# 架构与实现

需求与设计依据见 [设计文档](Obact_PRD_v2.md)。

```
用户脚本            MCP 客户端 ── mcp_server.py
   │  act / read / download / extract / save
   ▼
core.py ── 唯一的编排者：加载 .env，S1 → 编号 → fast → smart，执行动作，执行后校验
   │            │             │              │
   ▼            ▼             ▼              ▼
snapshot.py   cache.py      llm.py         output.py
snapshot.js   缓存键、模板   fast / smart   结果文件
   │          .obact/任务名/  OpenAI 格式接口
   ▼
浏览器页面（Playwright + Chromium）
```

| 模块 | 职责 |
| --- | --- |
| core.py | Obact 类：读配置、启动浏览器、编排每一步、执行动作、校验结果、写缓存、抛出 StepFailed |
| snapshot.js | 注入页面的脚本：收集元素和文本块、生成 extract 用的带坐标文本、遮挡检测、生成选择器、参数锚定、画编号框、等待 DOM 稳定、判断动作是否会打开新标签页 |
| snapshot.py | 调用 snapshot.js，组装发给模型的清单文字、截图和"编号 → 选择器"对照表；跟踪进行中的网络请求，等待页面稳定 |
| cache.py | 缓存键生成、参数模板化与回填、JSONL 读写 |
| llm.py | 两个模型槽位、提示词、视觉能力检查、JSON 解析与重试 |
| output.py | 按扩展名把结果写成文件 |
| mcp_server.py | MCP 服务：工具定义、延迟打开和重建浏览器、结果与错误的格式化 |

core 是唯一的编排者，snapshot、cache、llm、output 互不引用；浏览器只由 core（执行动作）和 snapshot（读取页面）访问；mcp_server 只调用 core 的公开方法。

## 一步操作的流程

act、read、download 相同：

```
生成缓存键：step 或指令模板 | 域名 + 路径
├─ 缓存命中 → S1：等元素出现 → 核对 → 执行 → 执行后校验 → 返回
│               核对不符或执行出错 → 转 S2
│               没写 expect、执行后页面没有变化 → 删除这条缓存，转 S2
│               执行后校验不通过 → 删除这条缓存，抛 StepFailed
└─ S2：给了 element_id 时先按编号执行，核对不符再转模型
       快照 → fast 模型 → 执行 → 执行后校验 → 写缓存 → 返回
         模型报告目标被弹层挡住 → 按一次 Escape，重新快照，同一模型再判断一次，仍被挡住或找不到时换 smart
         模型找不到、编号无效、执行出错，或没写 expect、执行后页面没有变化 → 换 smart 再来一次 → 仍失败抛 StepFailed
         执行后校验不通过 → 直接抛 StepFailed，不写缓存、不升级
```

执行后校验：act 写了 expect 时是 expect，没写时检查动作有没有效果；download 是"15 秒内触发下载"；read 不校验。

动作有没有效果（只检查 act 的 click、press、fill、select_option）：从紧挨着动作执行之前开始观察，到动作后的页面稳定等待结束为止，下面任何一项成立都算有效果：地址变了；标签页数变了；DOM 有变化（节点增删、属性、文字，不含编号框）；页面发生了滚动；焦点元素变了（点击后焦点落在按钮、链接或 body 上不算，这是浏览器点击本身带来的）；表单控件的值、勾选、选中状态变了；页面发生导航；fill、select_option 后目标的值等于要求的值（填入与原值相同的内容）；目标是 canvas、iframe、embed、object、video 或 shadow DOM 宿主，或包含这类元素（内部变化观察不到）。观察期间页面自己的变化（轮播、计时器）会让检查判为有效果，这是有意的取舍：宁可漏判，不把有效果的动作判成没有效果。

快照有两种：

- 元素清单（act、download）：收集原生交互标签、带交互 role、onclick、tabindex 的元素，以及 cursor:pointer 的最外层元素；视口内没有子元素、带一段不超过 30 字短文字（含字母或数字）、不在 label 和上述元素里面的叶子元素也收进来，用于靠事件委托响应点击的下拉项、日历格子，超过上限时先舍弃它们；剔除不可见、禁用、过小的元素；中心在视口内的元素做五点遮挡检测，被弹窗盖住的不进清单，模型判断目标被挡住时返回 blocked，不改选别的元素；整页最多 300 个，视口外的标注"屏幕外"，执行时由 Playwright 自动滚动。名称依次取 aria-label、aria-labelledby、label、placeholder、文字、title、alt，都没有时取元素本身和后代的 ::before、::after 里引号中的文字（去掉图标字体的私用区字符）。视口内元素在截图上画编号框。模型返回编号，canvas 等无法编号的目标返回坐标。
- 文本块清单（read）：收集文字不少于 10 字的块级元素（div、p、table、ul、section 等），文字与外层完全相同的包装元素只保留最外层；每行给出开头 60 字和总字数，截图不画框。模型返回编号。

选择器生成：从目标元素往上最多 6 层，依次尝试 data-testid、data-test、data-qa、id（排除自动生成的）、name、aria-label、placeholder、title、alt、目标自身的短文本、type、role，找到能唯一定位的条件后在下面接位置路径；都不行时用从 /html 开始的绝对路径。每个选择器生成时都在页面上校验只匹配到这个元素。

参数模板化与锚定：写缓存时，出现在输入内容中的参数值在输入内容里替换成 {参数名}；其余参数值出现在选择器的字符串字面量中时替换成 {参数名}。输入内容里的参数不会替换进选择器，例如输入 2 时不会把 qty-2 改成 qty-{qty}。click、hover 不带输入内容，模型多给的 args 会被丢掉。参数值不在选择器里时（例如按航班号点对应行的按钮），从目标往上找第一个文字包含参数值的祖先，生成 //tr[.//text()[normalize-space(.)='{flight}']]//input[@type='submit'] 这样的锚定选择器：先要求某个文字节点正好等于参数值，不行再退回包含；锚点下面的条件（属性条件或位置路径）必须本身不能唯一定位，否则换参数后仍会命中原来的元素。仍无法模板化时这一步不写缓存。回放时参数值填回选择器后重新加引号，值里带引号也不会破坏选择器。

S1 核对：act 和 download 要求选择器只匹配到一个可见元素，并且可访问名称与缓存一致；read 的区域内容本身会变，只要求唯一匹配且有文字；坐标条目不核对。

等待页面稳定：每个动作执行后、每次拍快照前，都等进行中的文档、脚本、xhr、fetch 请求结束，并且 DOM 连续 300 毫秒没有节点变化，总共最多 5 秒。超过 2 秒还没结束的请求视为卡住，不再等待（例如连不上的第三方统计脚本）。请求通过 Playwright 事件跟踪，页面感知不到。点击 target=_blank 的链接、提交 target=_blank 的表单时，先等新标签页出现（最多 10 秒），再在新标签页上等稳定。

模型调用：请求带 response_format json_schema，按 Decision、文本块编号或 extract 的 schema 做约束解码，接口支持时输出结构由解码保证；接口不接受 json_schema（返回 400）时，这个模型槽位改用 json_object 并打印一行提示。回复用 pydantic 校验；content 为空时改用 reasoning_content（有的推理模型偶尔把答案只写在那里）；接口出错或 JSON 不合法时同一模型重试 1 次，仍失败则升级到下一级。

反自动化检测：启动参数带 --disable-blink-features=AutomationControlled；注入脚本把 navigator.webdriver 置为 false、删除 Playwright 的全局变量、修正通知权限查询的返回值；可通过 OBACT_USER_DATA_DIR 保留登录状态，通过 OBACT_EXECUTABLE_PATH 使用本机 Chrome。

## 目录结构

```
obact/
  core.py              编排层
  snapshot.py          页面快照与页面稳定等待
  snapshot.js          注入页面的脚本
  cache.py             缓存
  llm.py               模型调用与提示词
  output.py            结果文件
  mcp_server.py        MCP 服务
examples/              使用示例
tasks/                 OSWorld 风格的 Web 任务和运行汇总脚本 run.py
tests/                 冒烟测试 smoke.py 和 pytest 测试
docs/
  guide.md             使用指南
  mcp.md               MCP 服务的使用与部署
  architecture.md      架构与实现
  testing.md           测试
  Obact_PRD_v2.md      设计文档
  mcp-server.md        MCP 服务的实现与验证
  stagehand_design.md  Stagehand 设计参考
  images/              配图
.env.example           配置模板
.mcp.json              本仓库的 MCP 配置
pyproject.toml
AGENTS.md              给编码代理的项目说明
```
