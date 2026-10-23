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
5. **循环**：`loop_begin.over` 渲染后必须是数组；`as` 是循环变量；`key` 模板给条目主键（游标与去重）；检查点 `loop_index[loop_begin 的 step_id]` 记录当前条目下标；`anchor` 是跳过模式重置页面后要满足的检查。循环可嵌套，`break` 跳出最近的循环。
6. **失败处理**（`on_fail`，默认 `human`）：步骤先按 `retry`（默认 0）重试；仍失败按 `on_fail`：`stop` 结束运行（状态 FAILED）、`skip` 记录并继续下一步、`human` 发 `need_human` 事件并进入 NEED_HUMAN（M3 才有真正的接管，M2 里等同于暂停等待 `resume()`）。**`once_only` 步骤永不自动重试，忽略 `retry`。**
7. **单次提交（FR-18）**：执行 `once_only` 步骤前，若 `side_effects.jsonl` 已有该 `idempotency_key` → 跳过并记 `skipped`；否则先写检查点（step_id 指向它）再执行。执行结果：成功（后置检查全部通过）→ 写 side effect；**已发出但结果未确认**（`assertion_failed`、`timeout`、`navigation_failed`、`browser_disconnected`、或进程崩溃后续跑时发现检查点停在该步且无 side effect）→ 写 unverified（`reason` 取 post_timeout / post_failed / navigation_lost / browser_lost / crash / stuck），发 `unverified` 事件，**绝不重试**；**未发出**（`not_found`、`not_unique`、`not_actionable`、`obscured`、`stale_ref`、`invalid_params`、`landing_mismatch`；`dialog_blocking` 例外，见第 16 条）→ 按普通失败处理。`on_unverified`（步骤所在循环的设置，缺省取工作流的，再缺省 `stop`）：`stop` → 停止运行（状态 STOPPED）；`skip` → 记入待核实 → 重置页面（重放前置路径，并满足循环 `anchor`）→ 处理下一条；**连续 2 条状态未明则停止**。
8. **检查点（FR-17）**：每个循环条目开始前、每个 `once_only` 步骤前后、`checkpoint` 步骤、状态变化时写；`seq` 单调递增；原子写（同目录临时文件 → fsync → rename）。检查点里没有的东西（页面、浏览器）靠重放前置路径恢复。
9. **续跑**：读检查点 → 恢复 `vars`、`loop_index`、`cursor` → 重放全部 preamble 步骤（失败则 FAILED）→ 跳到 `step_id` 所在位置继续（循环内则回到对应条目）。检查点停在 once_only 步骤中间（无 side effect）→ 按“崩溃”记 unverified，按 on_unverified 处理。
10. **事件**（`events.json`）：`step`（进度）、`need_human`、`ask_save`（M3）、`unverified`、`run_done`（含统计）。通过 `RunEvents`（`types.ts`）回调发出，同时写 `steps.log`。
11. **留痕（FR-26）**：`steps.log` 一行一步（时间、step_id、op、结果、耗时，敏感值已脱敏）；`trajectory.jsonl` 按 `trajectory.json` 契约；截图保存数量有上限（默认保留最近 200 张），研究采集模式（`research_capture`）每步存截图与文本快照。
12. **接口截获（FR-10）**：`core/network.ts` 为每个标签页缓存最近 30 条 JSON 响应（只缓存与工作流 `intercept` 正则匹配的；`capture_all` 时全部），单条上限 1 MiB，超出淘汰最早的；每条记录到达时的动作序号（`currentActionSeq`）。抽取读取“上一个动作开始之后到达、URL 匹配”的最近一条，没到就等到 `wait_ms`，超时报 `timeout`。
13. **采集输出（FR-25）**：`outputs/<任务>/<日期>/data.jsonl` 实时追加，主键索引（`data.index`）持久化，重复主键跳过（续跑后不会重复写）；导出 CSV 带 UTF-8 BOM，xlsx 用最小实现（不引入重依赖）。
14. **监督（FR-19 的最小部分）**：监督进程拉起运行子进程，心跳每 5 秒；子进程退出码非 0 或 30 秒无心跳视为崩溃，自动以续跑模式重启，1 小时内超过 3 次则停止并报 TRIPPED；完整熔断、卡住截图留到 M4。

15. **多页面（FR-37）**：runner 维护一张别名表（别名 → 标签页编号），不进检查点。`pageId` 先按别名表解析，没有再当作标签页编号；别名 `^[A-Za-z][A-Za-z0-9_]*$`，不得与 `p` 加数字同形，`main` 保留给任务起点的标签页。步骤带 `opens: "名字"` 时，该步结果的 `effects.new_pages` 必须恰好一个新标签页，绑定到该别名；0 个报 `not_found`，多于 1 个报 `not_unique`，别名已绑定且页面仍开着报 `invalid_params`。别名未绑定或页面已关闭报 `page_not_found`。`extract` 的 `as` 把结果存进运行变量（已有字段），回原页面用 `{{var:..}}` 填写。续跑的重做单位是循环条目或 `checkpoint` 步骤：`main` 由前置路径重建，辅助页不恢复，需要时工作流自己 `opens`。重做单位内、提交之前的步骤必须幂等，这是工作流作者的责任。
16. **`dialog_blocking` 与 `dispatched`**：后置检查或等待期间被对话框打断时，`error.details.dispatched` 为 true，表示动作已经执行。对 `once_only` 步骤：为 true 按“已发出、结果未确认”处理（记 unverified、不重试）；为 false 或缺省按“未发出”处理。
17. **接口缓存的大整数**：超过 2^53 的整数在响应体里以十进制字符串保留，抽取结果里该字段是 string。
18. **runner 的实现细节**（`runner.ts`，补充上面几条）：①检查点的 `step_id`：循环条目开始前指向 `loop_begin`（`loop_index` 里是即将开始的条目），`once_only` 前指向该步、成功后指向下一步，`checkpoint` 步骤指向下一步；检查点里的 `vars` 不含循环变量（续跑时由 `over` 与 `loop_index` 重新渲染）、敏感变量、以及脱敏会改变内容的变量，`cursor.output_date` 固定采集输出的日期目录。②续跑只在检查点状态为 `RUNNING` 时才把停在 `once_only` 上的步骤当作崩溃；转人工、停止后续跑是重做该步，已记为状态未明且未核实的幂等键不会再执行（核实为未完成后才重做）。③`on_unverified` 的优先级：`RunOptions.onUnverified` > 最内层设置了它的循环 > 工作流 meta > `stop`；不在循环里没有“下一条”，只能停止。④`once_only` 的错误码未列入第 7 条两类时（如 `internal`）无法确认动作是否发出，保守按状态未明（`post_failed`）；`path_outside_workspace` 发生在动作之前，按未发出。⑤`call` 的子工作流不写检查点（整体算根工作流的一步，续跑从 `call` 重做），其中不允许 `once_only`；`call` 嵌套最多 8 层。⑥`Executor` 增加 `mainPage()`（别名 `main` 指向的标签页）与 `pageOpen(pageId)`；不带 `code` 的异常（`act` 违约抛出、程序错误、测试模拟崩溃）不转成失败，直接向外抛，等同进程崩溃。⑦运行结束（DONE）时，按 `meta.outputs` 的 `export` 导出 CSV / xlsx。

## 测试原则

少而有价值：每条测试对应一个需求或真实问题；用 `fixtures/` 和 `lab/` 做端到端，单元测试只测有逻辑的纯函数（模板、结构校验、检查点原子性、去重）。浏览器用 `tools/browser.ts`（`npm run browser:install`）。
