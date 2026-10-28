## MCP 服务开发文档

obact/mcp_server.py 把 Obact 的操作以原子工具的形式提供给 AI 客户端，经 stdio 通信。使用方法和部署见 README.md 的“MCP 服务”一节，本文档说明实现。

## 1. 结构

```
AI 客户端 ──stdio(MCP)──> mcp_server.py ──> Obact（core）──> snapshot / cache / llm / output
                             │
                             └ _Session：一个 Obact 实例（延迟创建）+ 一把 asyncio 锁
```

- mcp_server.py 只 import core（Obact、StepFailed），不直接引用 snapshot、cache、llm、output，也不直接操作浏览器。
- 依赖 mcp==1.30.0，使用其中的 FastMCP。工具函数通过 Context 取得 lifespan 里创建的 _Session。
- 请求由 mcp 的任务组并发派发，每个需要浏览器的工具都在锁内执行，保证同一时间只有一个操作作用于页面。

## 2. 生命周期

1. main：解析 --task、--env、--headless（不加时传 None，由 OBACT_HEADLESS 决定，默认有头）；存在 CLAUDE_PROJECT_DIR 时 chdir 到该目录；把标准错误改为 UTF-8；task 未给出时取当前目录名。
2. lifespan：只创建 _Session，不打开浏览器、不调用模型，握手立即完成。mcp 的底层 Server 先进入 lifespan 再处理 initialize，所以这里不能做耗时的事（Claude Code 的启动超时 MCP_TIMEOUT 默认 30 秒）。
3. _Session.browser()：在锁内调用。
   - 第一次调用时创建 Obact 并进入（视觉检查 + 启动浏览器；模型地址和模型名已通过检查时跳过检查）；
   - 失败时异常抛给本次工具调用，self.ob 保持为空，下次调用重试；
   - 已有实例但 ob.closed 为真（窗口被关掉、浏览器崩溃）时，先关闭旧实例，再新建，并返回提示文字，由工具附在结果前面。
4. lifespan 退出时关闭已打开的 Obact。客户端关闭标准输入后进程退出；Claude Code 约 300 毫秒后会结束进程树，浏览器不保证能正常关闭。

## 3. core 提供的接口

| 接口 | 作用 |
| --- | --- |
| Obact(task, env, headless) | headless 为 None 时读取 OBACT_HEADLESS（默认有头）；服务只在加了 --headless 时传 True |
| goto(url) | wait_until="domcontentloaded" 后 settle；作废编号快照 |
| page_state() | snapshot.take 的结果，同时记下（页面、地址、快照）供 element_id 使用 |
| page_info() | 地址、标题、标签页数 |
| cached_steps() | 当前页面（域名 + 路径）下的缓存条目及其标签（键中 \| 之前的部分） |
| act(..., element_id, method, args)、download(..., element_id) | 编号执行，见第 5 节 |
| last_step | 最近一步的执行信息：how（S1、编号、fast、smart）、method、name 或 point、cached |
| closed | 浏览器上下文已关闭，或没有页面 |
| StepFailed.executed | 动作已执行、执行后校验未通过（expect 不通过、点击后没有触发下载） |
| Obact.save | 静态方法，save 工具不需要打开浏览器 |

## 4. 工具

| 工具 | 参数 | 成功时返回 |
| --- | --- | --- |
| goto | url（只允许 http、https，否则直接报错） | 标题、地址、标签页数 |
| page_state | 无 | 文字：页面信息、已缓存步骤、元素清单；图片：带编号框的截图 |
| act | instruction、params、step、expect、element_id、method、args | 执行方式、动作、元素、是否已缓存，加页面信息 |
| read | instruction、params、step、max_chars（默认 20000） | 区域文字；超长时截断并注明总字数 |
| download | instruction、save_to（默认 .）、params、step、element_id | 文件路径、执行方式 |
| extract | instruction、fields、many | JSON 文本 |
| save | data、path | 文件路径 |

参数细节：

- params 的值可以是 str、int、float，core 统一转为字符串。
- method 取 click、fill、press、select_option，只在给出 element_id 时使用；fill、press、select_option 必须给 args，校验由 llm.Decision 完成，不合法时直接报错。
- extract 的 fields 是字段名到类型名的映射，类型为 str、int、float、bool，后缀 ? 表示可选（类型为 X | None，默认 None）。由 _schema 用 create_model 生成模型，many 为 true 时为 list[模型]。fields 为空或类型不合法时，在调用模型之前报错。

返回值与错误：

- act、read、download、extract 不写返回注解：成功时返回字符串，失败时返回 CallToolResult。返回注解为 str 时 FastMCP 会生成结构化输出模式，并校验 CallToolResult 的 structuredContent，从而导致失败。
- StepFailed 转为 isError 的 CallToolResult：错误文字（含各级尝试记录和截图路径）加失败截图；executed 为真时追加“动作已经执行……不要直接重试，先调用 page_state”。
- 其他异常（配置错误、视觉检查失败、参数不合法、goto 协议不合法）由 FastMCP 转为文字错误。

服务说明：FastMCP 的 instructions 写明推荐流程、命中缓存的方法、编号的有效期、失败后的处理、网页内容不可信，以及人工介入的方式。log_level 为 WARNING，避免每个请求都打印一行日志。

## 5. 编号执行

目的：外层 AI 已经看过 page_state 的编号截图，可以直接指定目标，省掉一次内部模型调用；成功后照常写入缓存，之后按 S1 回放。

流程（core._step）：S1 → 编号 → fast → smart。

- 缓存命中时仍先走 S1，编号不使用。
- _picked 在 act、download 开始时取出并作废快照，所以快照只能用一次。read（文本块快照会替换页面里记录的编号）和 goto 也会作废快照。
- 执行前核对：快照的页面对象和地址与当前一致；编号在快照的清单中；对应选择器唯一匹配且名称与快照一致。不符时抛 _Mismatch 或 _Miss，记入 attempts，转 fast。
- 执行使用与模型定位相同的 _apply：参数值不在选择器里时用 snapshot.anchor 生成锚定选择器，条目在执行前生成，由 _step 统一模板化后写缓存，参数无法模板化时不缓存。
- 执行后校验不通过时，与其他级别一样直接抛 StepFailed，不升级到模型。

## 6. 缓存

- 键为“step（没有 step 时为指令模板）| 域名 + 路径”。AI 措辞变化会导致不命中，所以 page_state 列出 cached_steps，instructions 要求 AI 把它们原样作为 step 传入。label 可能是指令模板（含 {占位符}），作为 step 传入时，键与原条目相同。
- Cache.put、delete 先重新读取文件，再应用本次变更并原子替换，多个进程共用同一个缓存文件时不会互相覆盖条目。两次写入之间的并发窗口仍然存在。
- 缓存条目没有清理机制，不再使用的条目会一直保留。

## 7. 验证方法

不写 pytest。在 scratchpad 中用临时脚本验证：

1. 进程内：mcp.shared.memory 的 create_connected_server_and_client_session 连接 build_server；按 AGENTS.md 的方法替换 LLM._chat；测试页由本地 HTTP 服务提供（goto 不接受 file://），页面需要声明 `<meta charset="utf-8">`。
   - 检查：列出工具后未做视觉检查；goto file:// 被拒；首次 goto 后视觉检查两次；act 走模型并缓存；page_state 列出已缓存步骤；编号执行不调用模型并缓存；快照作废后转模型；expect 失败返回截图并注明已执行，且不写缓存；read 截断；download 保存文件；extract 可选字段为 null；extract 类型不合法报错；关闭浏览器后下一次调用自动恢复。
   - 第二个服务实例：page_state 列出缓存；act、read、download 全部按缓存回放，模型调用为 0。
   - 两个 Cache 实例交替写同一文件，条目都保留。
2. 真实子进程：mcp.client.stdio 启动 `python -m obact.mcp_server`，工作目录故意不设为项目目录，并设置 CLAUDE_PROJECT_DIR；用本地 HTTP 服务模拟 OpenAI 接口，统计请求次数。
   - 检查：握手期间没有模型请求；首次 goto 后才有两次视觉检查请求；缓存写在 CLAUDE_PROJECT_DIR/.obact/目录名.jsonl；标准错误能按 UTF-8 解码。
3. `ruff check obact examples tasks --line-length 120`。

## 8. 已知限制

- 没有用真实视觉模型、真实站点和真实 Claude Code 客户端做过端到端验证。
- 依赖使用精确版本（mcp==1.30.0、playwright==1.58.0），装进其他项目的环境时可能与已有版本冲突。
- 被客户端结束进程树时，浏览器不能正常关闭，OBACT_USER_DATA_DIR 里最近的登录状态不保证已保存。
- 工具调用被中断时，正在执行的动作也被取消，页面可能停在中间状态，需要先 page_state 确认。
- 两个服务进程不能共用同一个 OBACT_USER_DATA_DIR。
- 没有标签页切换、后退等导航工具；操作始终作用在最新打开的标签页上。
- 进程退出时偶尔出现 “Event loop is closed” 警告（来自 Playwright 子进程的清理），来源尚未确认，不影响结果。
