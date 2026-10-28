# AGENTS.md

本文件给在这个仓库里工作的编码代理（Claude Code、Codex 等）。使用方法和架构说明见 README.md，需求与设计以 docs/Obact_PRD_v2.md 为准，MCP 服务的实现见 docs/mcp-server.md。

## 项目概况

Obact 是 Python 实现的单任务网页自动化工具：第一次运行由视觉模型定位并执行（S2），成功后缓存定位结果，之后按缓存执行（S1），不调用模型。执行层是 Playwright + Chromium，模型是 OpenAI 格式接口的 fast、smart 两个视觉模型槽位。

| 文件 | 作用 |
| --- | --- |
| obact/core.py | Obact 类，唯一的编排者：读 .env 配置与视觉检查记录、act/read/download 共用的 _step 流程（S1 → 编号 → fast → smart）、动作执行与新标签页等待、执行后校验、反自动化检测 |
| obact/snapshot.js | 注入页面的脚本，挂在 window.__obact：snapshot（元素清单）、blocks（文本块清单）、nameOf、anchor、settle、opensTab（这次点击或回车是否会打开新标签页） |
| obact/snapshot.py | 调用 snapshot.js，组装 Snapshot（清单文字、截图、编号 → 选择器）；watch 跟踪进行中的请求，settle 等页面稳定 |
| obact/cache.py | 缓存键、参数模板化与回填、JSONL 读写 |
| obact/llm.py | 模型槽位、提示词（ACT_PROMPT、READ_PROMPT、EXTRACT_PROMPT）、视觉检查、JSON 解析与重试 |
| obact/output.py | save 的文件写出 |
| obact/mcp_server.py | MCP 服务（stdio）：把 goto、page_state、act、read、download、extract、save 暴露为原子工具；首次调用时才打开浏览器，浏览器关闭后重新打开；有 CLAUDE_PROJECT_DIR 时切换到项目目录；只通过 Obact 的公开方法访问浏览器；日志写标准错误，标准输出只留给协议消息 |
| examples/ | 使用示例 |
| tasks/ | OSWorld 风格的 Web 任务（shop、booking、archive、download、community）、公共校验 common.py、运行汇总 run.py |
| tests/smoke.py | 冒烟测试：本地测试页 + 真实模型跑两遍主流程，再以子进程测 MCP 服务 |

## 环境与命令

所有命令在仓库根目录执行，使用项目虚拟环境 .venv（Python 3.12）。

```powershell
.venv\Scripts\python.exe -m pip install -e .                          # 安装（playwright、openai、pydantic、mcp）
.venv\Scripts\ruff.exe check obact examples tasks tests --line-length 120   # 代码检查，改动后必须通过
.venv\Scripts\python.exe tests/smoke.py                                     # 冒烟测试：本地测试页 + 真实模型 + MCP
.venv\Scripts\python.exe tasks/run.py shop booking archive download         # 真实站点验证，打印汇总表
```

配置全部来自环境变量，写在仓库根目录的 .env 中（模板见 .env.example），Obact 启动时自动加载，已存在的环境变量优先。必填 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY（fast 槽位）；smart 槽位是可选的 SMART_MODEL_*，没写的项沿用 fast。.env 和 workspace/ 在 .gitignore 里，不要提交，也不要把密钥写进任何被跟踪的文件。.obact/ 是任务缓存，同样在 .gitignore 里，默认不提交。

## 必须保持的设计约束

1. core 是唯一的编排者；snapshot、cache、llm、output 互不引用。浏览器只由 core（执行动作）和 snapshot（读取页面）访问。mcp_server.py 只 import core，不直接引用 snapshot、cache、llm、output。
2. snapshot.js 整个文件是一个箭头函数表达式，由 page.evaluate 执行，再次注入时直接返回。文件末尾不能加分号，也不要改成模块或语句形式；页面上只挂 window.__obact 一个全局变量。
3. 参数值必须在选择器的字符串字面量或 args 中被模板化，才能写缓存；做不到时 templatize 返回 None，这一步不缓存。出现在 args 里的参数只在 args 中替换，不替换进选择器；click 的 args 恒为空。回放时选择器用 render_selector 填参数，不要用 render。不要放宽这些规则，否则换参数回放会静默点错元素。
4. 参数锚定（snapshot.js 的 anchor）先用“文字节点等于参数值”，再退回“包含”；锚点下面的条件（属性条件和位置路径）本身不能唯一定位元素，否则锚点会被绕过。
5. act 和 download 的 S1 必须核对“唯一匹配 + 名称一致”后才执行；read 只核对唯一匹配和非空文字；核对不符抛 _Mismatch，转 S2。按 element_id 执行（编号）时同样先核对页面地址未变、唯一匹配、名称与快照一致，不符转模型；page_state 的快照只能用一次，act、download、read、goto 时作废。
6. 执行后校验（verify）不通过时直接抛 StepFailed：不写缓存、不升级到下一级模型；S1 回放后不通过时还要删除这条缓存。动作执行之前的失败才升级。
7. 每个动作执行后、每次拍快照前都要 settle：等进行中的请求结束（超过 2 秒的视为卡住）且 DOM 稳定，总共最多 5 秒。请求跟踪只用 Playwright 事件，不要往页面里注入监听网络的代码。点击或回车会打开新标签页时（opensTab 判断），先等新标签页出现再 settle，否则 settle、expect 和后续步骤会作用在旧页面上；不会打开新标签页的动作不额外等待。
8. 模型输出走 response_format json_object，用 pydantic 校验；同一模型最多重试 1 次。
9. 缓存条目只存回放必需的字段（key、selector 或 point、name、method、args），格式见 README。

## 代码风格

- 匹配周围代码的写法：注释和文档字符串用中文，密度与现有代码一致，行宽 120。
- 注释和文档只描述当前状态，不写修改历史，不把尚未实现的设想写成规则。
- 只改与任务直接相关的代码，不顺手重构；不为假设的未来需求加配置项或抽象。
- 新增依赖要有必要理由，并同步写进 pyproject.toml。

## 验证方法

仓库里没有 pytest 单元测试；除非用户要求，不要新增。改动后先跑 tests/smoke.py（本地测试页 + .env 里的真实模型，两遍运行加 MCP 子进程，退出码 0 为通过），再按需要做下面两种验证，并在汇报中如实给出结果。用便宜或本地的模型跑冒烟测试时，在命令行设置 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY 覆盖 .env。

本地验证：写一个本地 HTML 测试页，用假模型替换 LLM._chat，跑两遍同一个脚本：第一遍应全部走 S2 并写缓存，第二遍 act、read、download 的模型调用次数应为 0。假模型按用户消息的开头区分调用类型：

```python
from obact import llm

async def fake_chat(self, slot, messages):
    text = messages[-1]["content"][0]["text"]
    if text.startswith("这张图片"):     # 视觉检查：缓存目录里没有 vision_checked.json 记录时才会调用
        return '{"color": "红色"}'
    if text.startswith("操作指令"):     # act、download：清单在 "可交互元素清单：" 之后
        return '{"found": true, "id": 3, "method": "click", "args": []}'
    if text.startswith("读取要求"):     # read：清单在 "文本块清单：" 之后
        return '{"found": true, "id": 5}'
    if text.startswith("提取要求"):     # extract
        return '{"data": []}'

llm.LLM._chat = fake_chat
```

本地验证时可以用一个单独的 .env（例如 OBACT_HEADLESS = true、OBACT_CACHE_DIR 指向临时目录、MODEL_BASE_URL 随便填），通过 Obact(task, env=路径) 传入。改动 MCP 服务时，还要按 docs/mcp-server.md 第 7 节做进程内和真实子进程两种验证。

真实验证：用 tasks/run.py 在练习站上跑两遍，第一遍各任务应通过，第二遍 act、read、download 应全部是“S1 命中缓存，直接回放”，只有 extract 调用模型（community 中地址每次不同的文章页步骤除外）。community 任务自动登录 Conduit：用 workspace/outputs/tasks/community/account.json 里保存的测试账号，没有或登录失败时自动注册一个、打印注册信息并保存；它会真实地发布文章和评论并在结束前删除。Conduit 是练习站，用户已同意在上面注册测试账号和发布测试内容。发布文章后中途失败时任务会直接删除文章；这一步清理本身也失败时，测试内容会留在站点上，需要手动清理。

## 调试

- 看模型选了什么：包装 LLM.decide 或 LLM.locate，打印传入的清单文字和返回值。
- 看模型看到的画面：调用 snapshot.take(page) 或 snapshot.take_blocks(page)，把 .image 写成 PNG；单独使用 Playwright 时先调用 snapshot.watch(page)，settle 才会等网络请求。
- 失败截图在缓存目录下的 任务名_failed.png，StepFailed.attempts 里有各级失败原因。
- 某一步行为异常时，先删掉 .obact 里对应任务的 jsonl，确认 S2 本身是否正确，再看 S1。

## 协作约定

- 用简体中文回复。
- 用户没有自测之前不要提交代码。不要执行可能导致改动无法撤销的 git 命令，尤其不要把 git checkout . 和 git clean -fd 组合执行。
- 发现与当前任务无关的问题，在汇报中指出，不要顺手修改。
