# 工作流引擎设计（M2）

对应 PRD FR-09、FR-10、FR-16~FR-19、FR-25、FR-26、FR-35，验收 BW-1/2/9/10、C-1/3/4/5。数据结构以 `packages/schemas/schemas/*.json` 为准（step、workflow、checkpoint、side-effect、unverified、events、trajectory、params、signatures、rules），类型从 `@obact/schemas` 导入，不要重复定义。

## 目录与模块边界

```
packages/workflow/src/
  types.ts        共享类型与接口（已写好，各模块只依赖它，不互相引用内部实现）
  template.ts     模板渲染 {{param:..}} {{var:..}} {{file:..}}、敏感值脱敏
  params.ts       参数库 params.yaml：工作流 → 网站 → 全局三级查找；get/set
  files.ts        工作区文件 list/read/write，限制在工作区内（FR-35）
  workflow.ts     加载 workflows/<名称>/（workflow.json、steps.jsonl、signatures.json、rules.json），契约校验 + 结构校验
  store.ts        运行目录 runs/<run_id>/：检查点原子写、side_effects.jsonl、unverified.jsonl、steps.log、trajectory.jsonl
  runner.ts       解释执行：控制流、重试、失败策略、单次提交、续跑、跳过模式、暂停/停止、事件
  executor.ts     Executor 的实现：CoreExecutor（用 @obact/core 的 act / 定位器 / 抽取）
  extract.ts      页面抽取（表格 / 列表 / 键值，分页与虚拟滚动）与接口截获的读取
  output.ts       采集输出：data.jsonl + 主键索引 + CSV（UTF-8 BOM）/ xlsx 导出
  supervisor.ts   最小监督进程：心跳、子进程崩溃后拉起并续跑
  cli.ts          命令行：run / resume / status / unverified
  index.ts        导出
packages/core/src/network.ts   每个标签页的接口响应缓存（FR-10，PRD 5.6），core 导出
```

## 共享约定

1. **步骤即动作**：普通步骤的 `op` 等于 `action.json` 的动作，`runner` 渲染模板后去掉步骤字段（step_id、section、pre、retry、on_fail、once_only、idempotency_key、volatile、note、opens）交给 `Executor.act`。控制流步骤：`loop_begin / loop_end / break / if / else / end_if / call / set_var / checkpoint`；`extract` 交给 `Executor.extract`。
2. **工作流里目标只能是定位器**，出现 `target.ref` 在加载时报错。
3. **前置路径（`section: "preamble"`）**：必须在所有 main 步骤之前、不在循环内；续跑时无条件重放。
4. **模板**：字符串整体是单个模板时返回原类型，混合文本则插值为字符串；找不到变量/参数报 `invalid_params`（带步骤号与名称）。`{{file:路径}}`：`.csv`（首行表头）→ 对象数组，`.jsonl` → 数组，`.json` → 值，其他 → 文本；路径限定在工作区内。名称含 `password|token|secret` 的参数在日志、留痕、返回结果、检查点里一律显示 `***`，检查点的 `vars` 不写入敏感值。
5. **循环**：`loop_begin.over` 渲染后必须是数组；`as` 是循环变量；`key` 模板给条目主键（游标与去重）；检查点 `loop_index[loop_begin 的 step_id]` 记录当前条目下标，循环声明了 `key` 时 `cursor.loop_keys[loop_begin 的 step_id]` 同时记录当前条目的 key 渲染值，续跑时 `over[i]` 的 key 与它不一致（数据源在两次运行之间变了）则 FAILED，不声明 `key` 就不校验；`anchor` 是跳过模式重置页面后要满足的检查。循环可嵌套，`break` 跳出最近的循环。
6. **失败处理**（`on_fail`，默认 `human`）：步骤先按 `retry`（默认 0）重试；仍失败按 `on_fail`：`stop` 结束运行（状态 FAILED）、`skip` 记录并继续下一步、`human` 发 `need_human` 事件并进入 NEED_HUMAN（M3 才有真正的接管，M2 里等同于暂停等待 `resume()`）。**`once_only` 步骤永不自动重试，忽略 `retry`。**
7. **单次提交（FR-18）**：`once_only` 只能用在动作步骤上，不能在前置路径里（`call`、`set_var`、`extract`、控制流、`checkpoint` 上加载时报错）；`idempotency_key` 模板必须引用所有外层循环变量（循环内 `set_var`、`extract.as` 设的变量不算），两个 `once_only` 步骤的键模板不得完全相同（加载校验）。执行 `once_only` 步骤前，若 `side_effects.jsonl` 已有该 `idempotency_key` → 跳过并记 `skipped`；否则先写检查点（step_id 指向它）再执行。幂等键渲染后必须是非空字符串或数字，否则在动作发出前报 `invalid_params`，按普通失败。执行结果：成功（后置检查全部通过）→ 写 side effect；**已发出但结果未确认**（`assertion_failed`、`timeout`、`navigation_failed`、`browser_disconnected`、或进程崩溃后续跑时发现检查点 `cursor.inflight` 的在途键没有 side effect）→ 写 unverified（`reason` 取 post_timeout / post_failed / navigation_lost / browser_lost / crash / stuck），发 `unverified` 事件，**绝不重试**；**未发出**（`not_found`、`not_unique`、`not_actionable`、`obscured`、`stale_ref`、`invalid_params`、`landing_mismatch`；`dialog_blocking` 例外）→ 按普通失败处理。上面两类错误码只在执行器没给 `details.dispatched` 时才看，给了以它为准，见第 16 条；`response_timeout` 同 `timeout`（post_timeout）。`on_unverified`（步骤所在循环的设置，缺省取工作流的，再缺省 `stop`）：`stop` → 停止运行（状态 STOPPED）；`skip` → 记入待核实 → 重置页面（重放前置路径，并满足循环 `anchor`）→ 处理下一条；**连续 2 条状态未明则停止**（连续计数存在检查点 `cursor.unverified_streak`，续跑时恢复，停止后不核实直接续跑也不清零；成功一条才清零）。
8. **检查点（FR-17）**：每个循环条目开始前、每个 `once_only` 步骤前后、`checkpoint` 步骤、状态变化时写；`once_only` 动作发出前预写检查点时，在 `cursor.inflight = {step_id, key}` 记下在途的幂等键，动作有了结论（成功、状态未明、确认没发出）后清掉；`seq` 单调递增；原子写（同目录临时文件 → fsync → rename）。检查点里没有的东西（页面、浏览器）靠重放前置路径恢复。
9. **续跑**：读检查点 → 恢复 `vars`、`loop_index`、`cursor` → 重放全部 preamble 步骤（失败则 FAILED）→ 跳到 `step_id` 所在位置继续（循环内则回到对应条目）。续跑一开始（重放前置路径、渲染 `over` 之前）若 `cursor.inflight` 的在途键没有 side effect → 按“崩溃”记 unverified、发事件，按 on_unverified 处理（stop → STOPPED；skip → 重置页面后从该循环的下一条继续）。
10. **事件**（`events.json`）：`step`（进度）、`need_human`、`ask_save`（M3）、`unverified`、`run_done`（含统计）。通过 `RunEvents`（`types.ts`）回调发出，同时写 `steps.log`。
11. **留痕（FR-26）**：`steps.log` 一行一步（时间、step_id、op、结果、耗时，敏感值已脱敏）；`trajectory.jsonl` 按 `trajectory.json` 契约；截图保存数量有上限（默认保留最近 200 张），研究采集模式（`research_capture`）每步存截图与文本快照。
12. **接口截获（FR-10）**：`core/network.ts` 为每个标签页缓存最近 30 条 JSON 响应（只缓存与工作流 `intercept` 正则匹配的；`capture_all` 时全部），单条上限 1 MiB，超出淘汰最早的；每条记录到达时的动作序号（`currentActionSeq`）。抽取读取“上一个动作开始之后到达、URL 匹配”的最近一条，没到就等到 `wait_ms`，超时报 `timeout`。
13. **采集输出（FR-25）**：`outputs/<任务>/<日期>/data.jsonl` 实时追加，主键索引（`data.index`）持久化，重复主键跳过（续跑后不会重复写），所以 `extract` 带 `into` 时必须有主键（步骤的 `key` 或 `meta.outputs[into].key`），否则加载报错；导出 CSV 带 UTF-8 BOM，xlsx 用最小实现（不引入重依赖）。
14. **监督（FR-19 的最小部分）**：监督进程拉起运行子进程，心跳每 5 秒；子进程退出码非 0 或 30 秒无心跳视为崩溃，自动以续跑模式重启，1 小时内超过 3 次则停止并报 TRIPPED；完整熔断、卡住截图留到 M4。**锁**：同一个运行同一时刻只允许一个监督进程，`runs/<id>/run.lock`（O_EXCL 创建，内容是持有进程的 pid 与启动标识）；同一账号同一时刻只允许一个运行，`profiles/<账号>.lock` 由运行子进程在 `openSession` 里拿，拿不到抛 `invalid_params`（子进程报错后正常退出，不进重启循环）。持有者已死（被 SIGKILL、崩溃、pid 被复用）则下一个直接接管，不会留下解不开的锁。`runs/<id>/browser.pid` 记浏览器 pid、配置目录和所有者（运行子进程的 pid），子进程退出后只清扫所有者是它的记录。**信号**：监督进程第一次收到 SIGINT / SIGTERM / SIGHUP 走 `stop()`（先 SIGTERM 子进程组，宽限期后 SIGKILL），第二次直接强退，并在 `exit` 钩子里同步 SIGKILL 子进程组（含 `process.exit`），不留孤儿；运行子进程自己处理这三个信号：同步清扫浏览器后立即退出（130 / 143 / 129），不写检查点，等同崩溃，续跑按检查点里的在途键判定，不会产生浏览器没了却 NEED_HUMAN 的状态。

15. **多页面（FR-37）**：runner 维护一张别名表（别名 → 标签页编号），不进检查点。`pageId` 先按别名表解析，没有再当作标签页编号；别名 `^[A-Za-z][A-Za-z0-9_]*$`，不得与 `p` 加数字同形，`main` 保留给任务起点的标签页。步骤带 `opens: "名字"` 时，该步结果的 `effects.new_pages` 必须恰好一个新标签页，绑定到该别名；0 个报 `not_found`，多于 1 个报 `not_unique`，别名已绑定且页面仍开着报 `invalid_params`。别名未绑定或页面已关闭报 `page_not_found`。`extract` 的 `as` 把结果存进运行变量（已有字段），回原页面用 `{{var:..}}` 填写。续跑的重做单位是循环条目或 `checkpoint` 步骤：`main` 由前置路径重建，辅助页不恢复，需要时工作流自己 `opens`。重做单位内、提交之前的步骤必须幂等，这是工作流作者的责任。
16. **`dispatched`**：core 的 `act` 所有失败结果都带 `error.details.dispatched`（布尔，输入是否已经派发；派发前就失败的为 false）。对 `once_only` 步骤以它为准：true → “已发出、结果未确认”（记 unverified、不重试，派发后才出现的 `page_not_found`、`invalid_params`、`dialog_blocking` 等一视同仁）；false → “未发出”，按普通失败；缺省（旧执行器、假执行器）才按第 7 条的错误码表，其中 `dialog_blocking` 缺省按“未发出”。
17. **接口缓存的大整数**：超过 2^53 的整数在响应体里以十进制字符串保留，抽取结果里该字段是 string。
18. **runner 的实现细节**（`runner.ts`，补充上面几条）：①检查点的 `step_id`：循环条目开始前指向 `loop_begin`（`loop_index` 里是即将开始的条目），`once_only` 前指向该步、成功后指向下一步，`checkpoint` 步骤指向下一步；检查点里的 `vars` 不含循环变量（续跑时由 `over` 与 `loop_index` 重新渲染）、敏感变量、以及脱敏会改变内容的变量，`cursor.output_date` 固定采集输出的日期目录。②崩溃按检查点的 `cursor.inflight`（动作发出前预写的在途键）判定，不看检查点停在哪一步：动作发出前、上一个 `once_only` 刚成功后、`checkpoint` 步骤之后的崩溃都不会误报；崩溃标记在续跑一开始就写入待核实清单，之后前置路径重放失败、`over` 渲染失败把检查点改成 FAILED 也不丢，`over` 的数据源变了也按键而不是按位置判断（键上已有核实为未完成的旧记录时，这次的崩溃照样重新记为未核实）。转人工、停止后续跑是重做该步，已记为状态未明且未核实的幂等键不会再执行（核实为未完成后才重做）。③`on_unverified` 的优先级：`RunOptions.onUnverified` > 最内层设置了它的循环 > 工作流 meta > `stop`；不在循环里没有“下一条”，只能停止。④`once_only` 的错误码未列入第 7 条两类时（如 `internal`）无法确认动作是否发出，保守按状态未明（`post_failed`）；`path_outside_workspace` 发生在动作之前，按未发出。⑤`call` 的子工作流不写检查点（整体算根工作流的一步，续跑从 `call` 重做），其中不允许 `once_only`；`call` 嵌套最多 8 层；敏感变量的标记各工作流环境各自一份（子工作流里的同名 `set_var` 改不到根工作流的），敏感的 `call` 实参传进去仍按敏感打码。⑥`Executor` 增加 `mainPage()`（别名 `main` 指向的标签页）与 `pageOpen(pageId)`；不带 `code` 的异常（`act` 违约抛出、程序错误、测试模拟崩溃）不转成失败，直接向外抛，等同进程崩溃。⑦运行结束（DONE）时，先写 DONE 检查点，再按 `meta.outputs` 的 `export` 导出 CSV / xlsx；导出出错不改变状态，错误放进 `RunResult.error`（`internal`），`run()` 不 reject。
19. **执行器与命令行**（`executor.ts`、`cli.ts`）：①`openSession` 用 `launchBrowser` 启动浏览器（配置目录 `<工作区>/profiles/<account 或 default>`，缺省无头，浏览器路径取 `--chrome` 或环境变量 `CHROME_PATH`，`handleSignals: false`：不让 puppeteer 接管信号），新建的第一个标签页是 `main`，启动时自带的空白页关掉；工作流声明了 `intercept` 才挂接口缓存，且先于开标签页。②接口读取的起点是**最近一个非 `wait_for` / `assert` 动作**的序号（这两类只看不动，`click → wait_for → extract` 仍能取到点击触发的响应）；动作打开了新标签页后先 `cache.ready()`（M2 的变通，页面最初几毫秒的请求仍可能漏掉）。③`screenshot` 存到 `runs/<run_id>/shots/keep/<名>.webp`，返回相对工作区的路径，3 秒内截不到（如页面被对话框占住）返回 null。④命令行（`--workspace` 缺省当前目录，`--run-id` 缺省 `<工作流名>-<时间戳>`）：`obact run <工作流> [--workspace DIR] [--run-id ID] [--headed] [--chrome PATH] [--on-unverified stop|skip] [--var k=v]...`、`resume <run-id>`、`status <run-id>`、`unverified <run-id>`；run / resume 的父进程是监督进程，用同一入口加 `--child` 拉起运行子进程，崩溃后加 `OBACT_RESUME=1` 重启（检查点还不存在则重新开始）。**子进程只要跑到结局（DONE、FAILED、STOPPED、NEED_HUMAN）退出码就是 0**，否则监督进程会把它当崩溃重启；命令行的退出码由父进程按检查点状态换算：DONE 0、FAILED 1、STOPPED 3、NEED_HUMAN 4、熔断 5、运行被另一个进程占用 6、Ctrl-C 中断 130（可 `resume`）、用法错误 2、其他错误 1。父进程在拉起前先预检：run-id、工作流名（只允许字母数字 `_ - .`，不含路径分隔符和 `..`；`call` 的工作流名在加载校验里同样要求）、工作流能加载且 `name` 与目录名一致、`account` 名合法、浏览器路径存在且可执行、Linux 上有头模式必须有 `DISPLAY`（不自动接入 Xvfb）；确定性的错误直接报错退出，不拉起子进程，不进重启循环。

## 测试原则

少而有价值：每条测试对应一个需求或真实问题；用 `fixtures/` 和 `lab/` 做端到端，单元测试只测有逻辑的纯函数（模板、结构校验、检查点原子性、去重）。浏览器用 `tools/browser.ts`（`npm run browser:install`）。
