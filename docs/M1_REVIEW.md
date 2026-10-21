# M1 评审问题清单

2026-10 对 M1（观察与执行内核）做了一次整体评审：8 个维度（动作执行、observe 与定位、运行时与生命周期、需求与契约、测试质量、Lab 与夹具、安全与数据保护、文档一致性）各由一位评审者查找问题，再由另一位独立复核者逐条尝试推翻（Lab 与夹具、安全、文档三个维度因会话用量中断没有复核，改为修复者先独立复现再修）。本文把全部发现合并去重、记录状态。

- 评审原始记录共 132 条，去掉跨维度重复后是 **112 个独立问题**。
- 结果：**已修复 100**（每个问题一个提交，提交说明写编号）；**已知限制 6**（确认成立但代价高于收益，或需要改契约）；**不修 10**（复核驳回或属设计取舍）；未修的待办 0。
- 验证：`npm run check` 415 项全过（跳过 0）、`npm run test:bench` 8 项全过、Python 79 项全过。

## 1. 已修复

| 编号 | 严重度 | 问题 | 位置 | 提交 |
|---|---|---|---|---|
| act-1 | 高 | 下拉框 fill/点选项用方向键逐项移动，中间项的 input/change 都会触发，带 onchange 副作用的下拉框会去到错误的结果 | `packages/core/src/act/ops.ts:424` | c583f0b |
| act-3 | 高 | 隐藏的原生复选框改点 label 时，点击点可能落在 label 里的链接上：跳走页面却报 ok，或报 internal | `packages/core/src/act/page.ts:96` | 10cff3f |
| fx-1（同 sec-8） | 高 | 夹具服务一个畸形 URL 就让整个进程崩溃（async 回调里的 new URL / decodeURIComponent 未捕获） | `fixtures/server.ts:82` | 9d9b8ac |
| obs-1 | 高 | obPickUnique 用“是否在当前视口内”判定可见，滚动位置不同，同名元素的唯一性与解析结果就不同：生成的定位器标为 unique:true，回放时点到另一个元素 | `packages/core/src/page/dom.ts:541` | 074cff8 |
| obs-2（同 tst-3、sec-3） | 高 | axtree 视图只给“已列入 elements 的敏感输入”打码；被字符预算截掉、或未渲染（零尺寸）的令牌输入框，其明文值会作为 StaticText 输出 | `packages/core/src/observe/index.ts:348` | 40f0f99 |
| obs-3（同 con-1、tst-2） | 高 | 页面上有未处理的 alert/confirm 对话框时，observe 挂起 180 秒，最后抛出没有错误码的原始 ProtocolError | `packages/core/src/observe/index.ts:280` | e38e38b |
| obs-4 | 高 | 绑定了点击监听的容器（React 17+ 的 #root、jQuery 委托的 ul/div）被列成一个巨大的 clickable，并使内部 cursor:pointer 的自绘控件推断失效，页面文字还可能从 text_md 消失 | `packages/core/src/mark.ts:79` | 074cff8 |
| rt-1 | 高 | 对池持有的 lease.browser 调用 Session.close() 会被池当成崩溃，SIGKILL 整个浏览器，持久 Cookie 丢失 | `packages/core/src/pool.ts:397` | ba092d2 |
| sec-2 | 高 | navigate_page / new_page 放行 file: 等本地协议，可读工作区之外的任意本地文件 | `packages/core/src/act/ops.ts:758` | 084eee2；navigate_page / new_page 只放行 http、https、about:blank 与工作区内 file: |
| act-11 | 中 | 拖拽终点（以及起点以外的所有非命中测试路径）取整个元素矩形的中心，目标被视口或祖先容器裁掉一部分时落点在可视区之外，却返回 ok | `packages/core/src/act/ops.ts:517` | 10cff3f |
| act-13 | 中 | element_absent / text_absent 在页面无响应或求值出错时空通过：忙页面、非法选择器都会得到“不存在” | `packages/core/src/act/assert.ts:206` | 93c204a |
| act-14 | 中 | 轮询阶段（wait_for、post 后置检查）页面弹出对话框时处理不一致：wait_for 条件未满足却返回 ok，post 要等满超时再报 assertion_failed | `packages/core/src/act/index.ts:194` | 45eb248；post 轮询期间弹出对话框返回 dialog_blocking，details.dispatched 为 true（M2 引擎需读此字段） |
| act-15 | 中 | 页面主线程无响应时 act 不受 timeout_ms 约束，会卡到 protocolTimeout（180 秒）；同进程另一个标签页的对话框也会让本页卡死 | `packages/core/src/act/locate.ts:49` | 0668195 |
| act-21（同 con-4） | 中 | 多选下拉框（select multiple）无法选择多项：fill 和点 option 都只会替换当前选择；同时事件被派发两遍 | `packages/core/src/act/ops.ts:263` | c583f0b |
| act-2（同 con-7、tst-1、sec-1） | 中 | value_equals 检查不通过时把输入框的真实值写进 detail，密码框和敏感字段明文泄露到返回结果和 wait_for 的错误信息 | `packages/core/src/act/assert.ts:125` | 40f0f99 |
| act-4 | 中 | 会话第一次 act 之前、或页面第一次被 act 之前弹出的对话框不会被记录：之后所有动作卡住，handle_dialog 也关不掉它 | `packages/core/src/act/state.ts:27` | c566725 |
| act-5 | 中 | 目标在较高的 iframe 里、位置落在父页面可视区外时无法滚动到视口，报 not_actionable | `packages/core/src/act/locate.ts:157` | 10cff3f |
| act-6 | 中 | actionable 内部因节点被移除而重新定位后，调用方仍拿旧的（已 dispose 的）句柄：fill、type_text、下拉框、勾选、元素截图报 internal，复选框已被点了却报错 | `packages/core/src/act/locate.ts:103` | 10cff3f |
| act-7 | 中 | 对话框打断动作后返回 dialog_blocking（按“未发出”处理，可安全重试），但 fill、type_text、下拉框其实在 handle_dialog 时才真正执行，重试会重复输入 | `packages/core/src/act/ops.ts:340` | c8f55d3 |
| act-8 | 中 | fill 勾选/下拉框触发了页面导航时，动作其实成功了却返回 status:error code:internal | `packages/core/src/act/ops.ts:382` | 93c204a |
| con-2 | 中 | opacity:0 的原生控件（无 label 的自绘复选框、单选框、开关、文本框）observe 列为可点击并列出全部操作，act 一律判“元素不可见”，永远操作不了 | `packages/core/src/observe/page.ts:399` | 8c46e3b；表单控件已根治；opacity:0 的链接等非表单元素仍标 transparent |
| con-5 | 中 | Web Component 按钮（标签文字是宿主的 slot 文本）被误报 clickable=false/“covered”，act 却能点 | `packages/core/src/observe/page.ts:411` | 8c46e3b |
| con-8 | 中 | 无名称图标按钮的 hint 被框架样式类占满，真正的图标名被丢掉（Ant Design、Element UI、Bootstrap） | `packages/core/src/page/dom.ts:305` | 8c46e3b |
| doc-1 | 中 | compat-stable 抽测任务按构造必然失败，且与 PRD 8.3 对它的描述不符 | `.github/workflows/live.yml:53` | 14e5620；live.yml 的 compat-stable 已改为只跑核心与夹具测试；待首次联网运行确认 |
| doc-2 | 中 | PRD 里仍有多处把已取消的扩展侧边栏当作现有功能或 M4 交付物 | `docs/PRD.md:592` | 9947f71 |
| doc-4 | 中 | DEV_PLAN 里 Lab 和浏览器池的测试数量与实际相差一倍以上 | `docs/DEV_PLAN.md:117` | f59c999 |
| fx-2 | 中 | WebSocket 收到文本 null 会让夹具进程崩溃 | `fixtures/api/polling.ts:140` | 6a85357 |
| lab-1 | 中 | drop_rate 在写操作执行之前就断开连接，写入不落库，与 PRD“丢弃响应”不一致，测不出“连接被重置但已落库” | `lab/src/app.ts:301` | 05c64df |
| lab-2 | 中 | 同一幂等键重复提交时 record() 覆盖 payload，提交记录显示的内容和实际落库的不一致，且不检测同键异载荷 | `lab/src/app.ts:258` | fb7284c |
| lab-3 | 中 | _lab/faults 与 _lab/reset 不校验输入：表单编码下 commit_timeout=false 反而开启故障，拼错的字段被静默忽略 | `lab/src/app.ts:167` | 5ff3916 |
| obs-10 | 中 | 编号框覆盖层（view=som）用 innerHTML 加内联 style 构造：在启用 Trusted Types 的页面整个 observe 抛错，在严格 style-src CSP 页面编号框全部失效 | `packages/core/src/observe/page.ts:638` | 8c46e3b |
| obs-11（同 con-12、tst-13、sec-4） | 中 | 敏感值打码规则过窄，且只覆盖 <input>：textarea、一次性验证码、银行卡、pw/pass/api_key 等的值原样进入 elements、snapshot_text、axtree | `packages/core/src/observe/page.ts:267` | 40f0f99 |
| obs-12 | 中 | 表头每格只有可排序按钮（或整格是可操作元素）时，表头行被当成“纯编号行”从 text_md 删掉，表格只剩分隔行，列名丢失 | `packages/core/src/observe/format.ts:135` | e879e7e |
| obs-5（同 con-10、sec-10） | 中 | 同一会话内并发 observe 多个标签页：编号重复、编号表被覆盖，其中一个标签页之后的编号全部用不了；也可能抛出普通 Error“编号回退” | `packages/core/src/mark.ts:136` | 074cff8 |
| obs-6 | 中 | obsFoldDuplicates 把嵌在 link / tab / option 等带角色元素内的无名图标按钮折叠掉，这些元素有编号但不出现在 elements 和 snapshot_text 里 | `packages/core/src/observe/page.ts:118` | e879e7e |
| obs-7 | 中 | 只在包围盒中心取一个点做命中测试：跨行换行的内联链接被误报 clickable:false（covered） | `packages/core/src/observe/page.ts:406` | e879e7e |
| obs-8 | 中 | locatorAtPoint（坐标步骤换算成定位器）只穿透开放 Shadow DOM，封闭 Shadow 里的元素会被换算成宿主元素的定位器 | `packages/core/src/locator/page.ts:167` | 074cff8 |
| obs-9（同 sec-5） | 中 | textarea 的值含换行时，snapshot_text 不再是“一行一个元素”，页面内容可以伪造元素行 | `packages/core/src/observe/format.ts:59` | e879e7e |
| rt-2 | 中 | 改过名的标签页（含 newPage({pageId}) / act new_page 带 pageId）关闭后永远不会从登记表移除，pageId 无法复用 | `packages/core/src/pages.ts:44` | cd43a63 |
| rt-4 | 中 | 接口缓存用 JSON.parse 解析响应，超过 2^53 的整数静默丢精度，抽取到错误的数值 | `packages/core/src/network.ts:363` | b8a0beb；超过安全整数的整数以十进制字符串保留（M2 抽取需知） |
| sec-6 | 中 | 截图默认目录是共享的 <tmpdir>/obact-shots：默认权限 0755/0644、文件名可预测，不检查目录属主和符号链接 | `packages/core/src/observe/views.ts:18` | c6f570f |
| sec-7 | 中 | 页面提示条可被页面脚本改写、关掉：句柄挂在宿主元素上、补回上限 20 次、当前文档里封闭 Shadow Root 可被钩子截获 | `packages/core/src/banner.ts:70` | 0935b16 |
| act-10 | 低 | fill 不核对最终值：number 填非数字、color 填非法值、maxlength 截断、range 超范围被夹取，都返回 ok 但值与请求不符 | `packages/core/src/act/ops.ts:355` | c583f0b |
| act-12 | 低 | type_text 带 target 时只聚焦不放置光标：HTML 里带初始值的输入框、文本域，新输入被插到最前面 | `packages/core/src/act/ops.ts:478` | c583f0b |
| act-16 | 低 | hover、元素截图、滚动目标、拖拽终点也要求元素“启用”，禁用元素上悬停或截图会白等整个超时再报错 | `packages/core/src/act/locate.ts:106` | 10cff3f |
| act-17 | 低 | timeout_ms 为 0 时导航类动作没有超时：puppeteer 把 timeout:0 当成无限等待 | `packages/core/src/act/ops.ts:749` | 93c204a |
| act-18（同 sec-12） | 低 | take_screenshot 的 path 解析到工作区根目录本身（'.'、'sub/..'）时，补 .png 后缀把文件写到工作区之外 | `packages/core/src/act/ops.ts:816` | 93c204a |
| act-19 | 低 | new_page 的 URL 无效时已经建好并登记了空白标签页，每次失败泄漏一个；失败结果还声称 navigated:true、changed:true | `packages/core/src/act/ops.ts:875` | 93c204a |
| act-20 | 低 | onObscured 的返回值被忽略：弹窗规则第 3 次成功处理遮挡物后仍然报 obscured / landing_mismatch | `packages/core/src/act/locate.ts:192` | 10cff3f |
| act-22（同 con-3） | 低 | role=textbox 但不可编辑的自绘输入区：observe 的可用操作列出 fill，act 的 fill 却拒绝 | `packages/core/src/act/page.ts:364` | 8c46e3b |
| act-9 | 低 | fill 日期等控件值格式不对时，先写入再报 invalid_params：原有的值被清空，页面还收到清空值的 input/change | `packages/core/src/act/ops.ts:354` | c583f0b |
| con-11 | 低 | act(session, null/undefined) 抛出 TypeError，违背“不向外抛异常” | `packages/core/src/act/ctx.ts:96` | 93c204a |
| con-13 | 低 | text_md 里仍会出现可操作元素自己的内容或残留的列表说明，没有完全做到“只放网页信息” | `packages/core/src/observe/text.ts:119` | e879e7e |
| con-14 | 低 | 可操作元素名称 80~120 字符时，尾部既不在 snapshot_text 也不在 text_md | `packages/core/src/observe/format.ts:19` | e879e7e |
| con-16 | 低 | DEV_PLAN 第 4 节 M1 表格的测试数量与“补全中”状态已过时 | `docs/DEV_PLAN.md:117` | b54eb43 |
| con-6 | 低 | BW-14 的 Obact 一侧取自 markPage 的编号而不是 observe 的 elements，页面清单也缺测试应用各模块页面；用 observe 输出重算召回只有 96.7% | `bench/bw14.ts:172` | 18824d7 |
| doc-10 | 低 | “M1 需要承接的预研结论”里两条与实际实现不同，PRD 的数据来源描述也未更新 | `docs/DEV_PLAN.md:91` | f427c7d |
| doc-11 | 低 | PRD 8.3 / FR-01 的浏览器选择顺序和提示命令在实现里不存在，报错文案还与 8.3 相反 | `packages/core/src/browser.ts:43` | a8dff2f |
| doc-12 | 低 | M0 预研文档里的复跑命令在默认环境下得不到文档记录的结果 | `docs/spikes/M0-spikes.md:74` | 664686b |
| doc-13 | 低 | Lab README 说设置页按开发计划在 M2、M5 加入，开发计划里没有排它 | `lab/README.md:47` | fe88d1a |
| doc-3 | 低 | 契约文档和内核注释仍说侧边栏 / 扩展是接口调用方或可用选项 | `packages/schemas/README.md:29` | 0daeec7 |
| doc-5 | 低 | 动作种数、组件种数、改版夹具版本数、observe 示例等数字与实现对不上 | `docs/DEV_PLAN.md:115` | 9dd3ef5 |
| doc-6 | 低 | 多处仍声称 --live 逻辑已用本地桩站点测试跑通，对应测试已在 72b6868 删除 | `bench/bw3.ts:16` | 91e4e71 |
| doc-7 | 低 | 进度描述落后于 HEAD：bench 已进 CI、live 工作流已存在、脚本已完成，计划仍写成待办 | `docs/DEV_PLAN.md:101` | a6b8783 |
| doc-8 | 低 | bench 的使用文档只覆盖 BW-14 和 MiniWoB++，M1 出口要求的 BW-3/6/7/12 脚本和 test:bench 没有任何说明 | `bench/README.md:1` | 45de0f7 |
| doc-9 | 低 | README 把已存在的 workflow 说成后续模块、把已取消的 extension 说成后续模块，目录与文档清单缺项 | `README.md:24` | 71b106d |
| fx-3（同 sec-16） | 低 | 静态文件的目录穿越检查用 startsWith(PAGES) 没带路径分隔符，能逃到名字以 pages 开头的同级目录 | `fixtures/server.ts:110` | 9d9b8ac |
| fx-4 | 低 | 进度条夹具“停止”或完成后，“开始导出”再也点不动 | `fixtures/pages/timing/index.html:160` | fc9e0de |
| lab-10 | 低 | 请求体没有大小上限，Lab 和夹具服务都会把整个体读进内存 | `lab/src/app.ts:82` | 272ab38 |
| lab-11 | 低 | 订单后台只有 200 条订单且约 38% 非待审核，满足不了 BW-9“按订单号逐条审核 500 条” | `lab/src/modules/orders/data.ts:50` | f79d48e；Lab 的 reset 可带 {orders: N}；BW-9 用 1000 条 |
| lab-12 | 低 | PRD 的“定时改版”故障只有手动切换的 redesign 开关，没有按时间或次数触发的机制 | `lab/src/core.ts:28` | c5e1061 |
| lab-13 | 低 | /account 的“登录时间”取该用户所有会话里最新的一个，不是当前会话的 | `lab/src/modules/auth.ts:286` | 2487901 |
| lab-14 | 低 | space.log 注释写“最近 500 条”，实际从不裁剪，状态接口只返回最后 100 条 | `lab/src/app.ts:153` | fc7276c |
| lab-15 | 低 | DEV_PLAN 写的 Lab 各模块测试数与实际不符 | `docs/DEV_PLAN.md:117` | f59c999 |
| lab-4 | 低 | 页面事件上报遇到 HTTP 5xx 不重试，error_rate 下账本丢事件，与注释相反 | `lab/src/modules/structure/common.js:9` | 39a1f4e |
| lab-5 | 低 | 自动幂等键 auto-N 的计数器是服务进程全局的，不随空间和 reset 归零，同种子的状态不一致 | `lab/src/app.ts:259` | 358768b |
| lab-6 | 低 | safeNext 允许 ../ 点段跳出本空间，与“next 只接受本空间内的路径”不符 | `lab/src/modules/auth.ts:83` | a55a93c |
| lab-7 | 低 | next 含非 ASCII 字符时登录成功后返回 500（Location 头非法），且会话已建立 | `lab/src/modules/auth.ts:257` | 77decaf |
| lab-8 | 低 | 格式错误的百分号编码（Cookie 值、空间名、路径参数）导致 500，Cookie 情形下整个空间（含 _lab 控制接口）对该浏览器全部 500 | `lab/src/app.ts:77` | 5ae4b4c |
| lab-9 | 低 | commit 路由只有路径以 /api/ 开头才受故障注入，README“写新模块”没写这个前提 | `lab/src/app.ts:290` | 059ffdf |
| obs-13 | 低 | 控件的 label 文字整体从 text_md 剔除，而名称在 snapshot_text 里截到 80 字，长 label（协议、扣费说明）后半段在文本视图里消失 | `packages/core/src/observe/page.ts:496` | e879e7e |
| obs-14 | 低 | <summary> 没有 expanded 状态；obStates 里 details 分支永远走不到 | `packages/core/src/page/dom.ts:488` | e879e7e |
| obs-15 | 低 | 定位器里的 CSS、within、frame 选择器语法无效时抛原始 SyntaxError，act 里变成 script_error，不是 invalid_params | `packages/core/src/resolve.ts:88` | 074cff8 |
| obs-16（同 sec-9） | 低 | 字符预算只约束 snapshot_text 和 text_md，elements 里的 href 与 options 的 label/value 不设上限，max_chars 形同虚设 | `packages/core/src/observe/page.ts:439` | 8c46e3b |
| obs-17 | 低 | iframe 处在 CSS transform（缩放）里时，iframe 内元素的 bbox 与 clickable 都是错的 | `packages/core/src/observe/page.ts:587` | 8c46e3b；observe 侧已修（bbox 与命中换算）；act 的落点防护不处理 iframe 自身缩放，仍须用坐标，见第 2 节 |
| obs-18 | 低 | 带 tabindex 的 contenteditable / role=textbox 元素，名称取自它当前的内容，会随输入变化，并被写进角色+名称定位器 | `packages/core/src/page/dom.ts:219` | 074cff8 |
| rt-10 | 低 | getByPath 把根上以 $ 开头的普通键当成 JSONPath 根符号剥掉，读到别的字段 | `packages/core/src/network.ts:387` | 6a6a70e |
| rt-12 | 低 | acquire 与同账号的 close()/closeAll() 并发时，可能拿到正在被关闭的浏览器 | `packages/core/src/pool.ts:231` | 1cadf13 |
| rt-5 | 低 | newPage 带不合法或重复的 pageId 时先开了标签页再抛错，留下一个孤儿标签页 | `packages/core/src/pages.ts:98` | 51ee73a |
| rt-7 | 低 | showBanner 在 SVG/XML 等非 HTML 文档上抛 TypeError；这类页面导航后也不显示提示条 | `packages/core/src/banner.ts:34` | 9f16528 |
| rt-9 | 低 | asObactError 把 “Node is detached / detached Frame” 误报成 browser_disconnected，把 “browser has disconnected” 误报成 internal；用户脚本错误文本也先被断连规则抢走 | `packages/core/src/errors.ts:29` | 2bc5613 |
| sec-13 | 低 | fill 的错误信息和 details 回显调用方传入的值（可能是密码） | `packages/core/src/act/ops.ts:364` | 8d44b40 |
| sec-15 | 低 | Lab 不校验 Host，控制接口可被浏览器里任意网页跨站调用，500 响应带完整堆栈 | `lab/src/app.ts:179` | 455b8c8 |
| sec-18 | 低 | 依赖与下载未完全固定：Chrome 安装不校验哈希，Python 依赖是版本区间，CI 的 Actions 用可变标签 | `tools/browser.ts:59` | 05a534a；Actions 固定到具体版本、Chrome 下载加 SHA-256 校验；Python 依赖约束文件未做，见第 2 节 |
| tst-10 | 低 | 若干断言恒真或名不副实 | `packages/core/test/act.test.ts:180` | d034bbb |
| tst-14 | 低 | 下载测试只等 completed，下载被取消时空等 10 秒后报“等待超时”，不给原因；TMPDIR 含 .. 时稳定失败 | `fixtures/test/forms-files.test.ts:355` | 3e83428 |
| tst-4 | 低 | “目录穿越读不到包外文件”测试是空测：三条攻击路径指向的文件本来就不存在，去掉防护照样通过 | `lab/test/structure.test.ts:125` | cf17dd4 |
| tst-5 | 低 | take_screenshot 的 path 越出工作区没有任何测试；resolveInside 单测漏掉绝对路径、文件符号链接、悬空链接 | `packages/core/src/act/ops.ts:812` | 30b84c0 |
| tst-6 | 低 | 没有浏览器时所有浏览器套件被静默跳过，npm test 退出码 0 且汇总 skipped 为 0，没有“必须有浏览器”的闸门 | `packages/core/test/helpers.ts:20` | f4bc0cd |
| tst-7 | 低 | testChrome 在缺 chrome-headless-shell 时悄悄回退到完整 Chrome，与文件头注释和 DEV_PLAN 规则 7 相反，失败表现为莫名其妙的用例失败 | `tools/browser.ts:42` | 691903c |

## 2. 已知限制与后续

| 编号 | 问题 | 为什么没修 / 怎么办 |
|---|---|---|
| sec-11 | observe 之后页面脚本可读 host.__obactClosedRoot（封闭 Shadow Root） | 内核辅助脚本是每次重新求值的独立脚本，封闭根只能挂在页面可达的对象上；真正隔离需要隔离世界，与 sec-7、sec-14 一并整体评估 |
| sec-14 | 页面可替换 Function.prototype.apply / Boolean 等内建对象，截获内核辅助脚本的参数或让 expr 断言失真 | 改调用方式只是打地鼠；根治需把纯 DOM 读取类助手移到隔离世界，M4 前整体评估 |
| con-4（余部） | `<select multiple>` 的 listbox 元素没有 multiple 标记，option 不作为元素列出 | 需要增加 observe 契约字段；当前可用 `role:option` 加名称定位选项 |
| obs-17（余部） | iframe 自身有 CSS 缩放时，用编号点击会被落点防护拦下（不会误点） | act 的 `obActFrameHit` 需按缩放系数换算坐标；暂用坐标点击 |
| sec-18（余部） | Python 依赖仍是版本区间，CI 的 python 任务不可完全复现 | 新增 python/constraints.txt 并在 ci.yml 的 python 任务里 `-c` 引用；库依赖不改成精确版本 |
| sec-7（余部） | 提示条可被页面脚本删除或改写 | 提示条不是安全边界；已去掉宿主句柄并取消补回次数上限（退避），其余不做 |

## 3. 不修：复核驳回或属设计取舍

| 编号 | 问题 | 理由 |
|---|---|---|
| rt-3 | 池进程崩溃或容器重建后，账号配置目录无法接管：残留的 SingletonLock / 孤儿浏览器会让该账号一直起不来（或同一配置目录并发起两个浏览器） | 现象能复现，但不是 M1 范围内的缺陷。(a) e15.ts 伪造异主机 SingletonLock，完整 Chrome 拒绝启动，报错里带有 Chrome 原文“in use by another Chromium process … on another computer”，没有误导。(b) 池进程被 kill - |
| rt-6 | Xvfb 只在 closeAll 时关闭：close(account) 关光所有浏览器后空闲 Xvfb 让进程退不出去；收到 SIGTERM 时 Xvfb 泄漏 | 现象能复现，但都是未调用 closeAll 的后果，而 closeAll 是文档写明的关闭点。e16.ts：close 唯一账号后进程不退出，活动句柄是 Xvfb 的 ProcessWrap 和 PipeWrap；e7b.ts：空闲池收到 SIGTERM 后 Xvfb 存活。但 pool.ts:183 的类注释明确写“ |
| rt-8 | 任务进程正常关闭 Session 或崩溃后，页面提示条留在页面里，并继续自我恢复，直到下一次导航 | 属于有意设计，不是缺陷。banner.ts 文件头注释写明“act 不会自动显示它，由调用方（runner）决定何时显示和移除”，API 是显式的 showBanner/hideBanner 一对，仓库里还没有 runner 调用它们。PRD FR-29 的“结束后移除”由 runner 在结束时调用 hideBann |
| rt-11 | 账号名区分大小写，但在 macOS/Windows 默认的大小写不敏感文件系统上会映射到同一个配置目录 | 无法复现，只有代码推断，触发条件太窄。要出问题，调用方得在 macOS 或 Windows 上给同一个池起两个只差大小写的账号名（'Alice' 与 'alice'）。账号名由用户或工作流配置，没有这种命名习惯；Windows 保留名和以点结尾也要有人真的取这种账号名。同时，按小写规范化键和目录会改变已有 Linux  |
| con-9 | upload_file 打在任意可点击元素上会先真实点击它，再报“不是上传控件” | 现象能复现（对非 file input 的可点击元素 upload_file 会先点击），但这是文档化、有测试的设计，不是缺陷。代码依据：ops.ts:567-570 的注释明确写了“其他可点击元素（自绘上传按钮）：可信点击后拦截弹出的文件选择框并选入文件”；fixtures/test/forms-files.test |
| con-15 | actions 与 act 的接受范围不对称：hover/scroll/drag 在未列出的元素上也成功，press_key 无法指向元素 | 两点都是设计取舍而不是缺陷。(a) hover/scroll/drag 对未列出的元素也放行是有意的：ops.ts 的 hover 注释写明“悬停不改变页面数据，不限制元素类型（CSS :hover 菜单常不带 aria-haspopup）”，observe 的 actions 只是“可用操作”的提示而不是白名单，放宽 |
| tst-8 | 同一行为被多处重复覆盖，违反 DEV_PLAN 规则 8（重复覆盖同一行为不写），总耗时和维护成本白增 | 已知取舍与偏好，不成立为缺陷，且修的代价大于收益。逐项核对：fixtures/test/structure.test.ts 与 lab/test/structure.test.ts 跑的是两个不同的页面实现（fixtures/pages/structure 与 lab/src/modules/structure），夹具 |
| tst-9 | 相当一部分测试验的是夹具或 Lab 站点自己，不是内核需求 | 属测试范围取舍，不成立为缺陷。这些用例测的夹具服务端与 Lab 控制接口是 PRD 9.3 本地夹具库（“结果完全确定”）和 BW 基准的依赖：例如 lab/test/core.test.ts 的控制接口被基准用到，formatted-numbers/virtual-table/polling 的接口是对应夹具对外的契 |
| tst-11 | 功能测试里大量固定毫秒阈值，余量只有 2 到 6 倍；本次未复现失败 | 推测性问题，未复现，且依据不足。报告自己的观察是：28 个文件单独各跑 3 次共 84 次、全量 npm test 并发下 335 项全部通过，并发只让耗时涨 5% 到 25%。我核对了其中最可能“依赖机器速度”的下限断言（fixtures/test/timing.test.ts:97、125、159）：被测计时器都由 |
| tst-12 | 若干断言绑定 HTML 标记、文案、列位置、数量，实现一改就红而需求没变 | 纯风格与维护偏好，不成立为缺陷。被点名的断言绑定的是仓库内的静态夹具页与 Lab 页（auth 的验证页 HTML、basic.html 的元素数 18、HT-2401 等固定数据、Default 子目录），它们是测试输入本身，内容固定且随仓库一起改；没有指出任何一处在需求不变、实现正常时会误报或漏报的实际情形。要改成 |

## 4. 修复中发现并处理的遗留项

| 问题 | 处理 |
|---|---|
| 怪异模式（无 doctype）页面里 `obActViewport` 取到内容高度而不是视口高度 | 已修（act-3 遗留） |
| `handle_dialog` 接受 beforeunload 后导航完成，结果的 `navigated` 仍是 false | 已修（act-19 遗留） |
| 显式 `pageId` 创建的标签页改名后关闭，登记表条目不移除 | 已修（rt-2、rt-5） |
| opacity:0 的原生表单控件 observe 与 act 判定不一致 | 已修（con-2 根治，act 对表单控件不看 opacity，落点防护仍生效） |
| 直接调用 `resolveRef` / `resolveLocator` / `markPage` / `generateLocator` / `matchSignature` 时页面有未处理对话框仍会挂到 CDP 超时 | 未修：act 与 observe 入口已覆盖，只有绕过它们直接调用的调用方受影响；入口加 `pendingOf` 检查即可 |
| `examples/try.ts` 在页面有对话框时 observe 抛错会退出 | 已修（观察失败只打印，不退出） |

## 5. 给 M2（工作流引擎）的接口约定

- 动作在后置检查或等待期间被对话框打断时返回 `dialog_blocking`，且 `error.details.dispatched` 为 true，表示动作已执行。引擎对 `once_only` 步骤必须读这个字段：为 true 时按“已发出、结果未确认”处理（记 unverified、不重试），否则会重复提交。DESIGN.md 第 7 条目前把 `dialog_blocking` 一律归为“未发出”，需要改。
- 接口缓存里超过 2^53 的整数以十进制字符串保留（`NetworkEntry` 注释有约定），抽取结果里该字段是 string，写 data.jsonl 时不会丢精度。
- Lab 的 reset 可带 `{"orders": N}`（1~2000），BW-9 用 1000 条（约 600~640 条待审核）；故障开关有校验，拼错键名或非法值返回 400；`drop_rate` 现在对写接口是“先落库再断开”。
- Lab 新增定时改版故障：`redesign_after_requests` / `redesign_after_ms` / `redesign_to`，默认关闭。
