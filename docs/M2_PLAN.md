# M2 工作流引擎：开发计划

编制日期 2026-10-22（2026-10-19 初版，本版纳入多页面流程并确认全部待定决策）。依据：[PRD](PRD.md) FR-09、10、16~19、25、26、35、37；[DEV_PLAN](DEV_PLAN.md) 第 4 节 M2；设计：[`packages/workflow/DESIGN.md`](../packages/workflow/DESIGN.md)、[多页面设计](DESIGN_MULTIPAGE.md)。

**M2 出口**：BW-1、BW-2、BW-9、BW-10、BW-15；C-1、C-3、C-4、C-5。

## 1. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 页面别名放哪里 | 复用步骤的 `pageId` 字段；别名 `^[A-Za-z][A-Za-z0-9_]*$`，标签页编号带 `p` 加数字前缀，二者靠命名区分；保留别名 `main` |
| 2 | 可重放段怎么表示 | 成对的控制流步骤 `segment_begin` / `segment_end`，不嵌套、不跨循环条目 |
| 3 | 续跑后辅助页是否自动重开 | 不自动。需要时由工作流用 `opens` 显式重开，行为可预期 |
| 4 | 任务内并发协作页 | 不在 M2；M4 之后与并行规则一起设计。M2 的执行线始终只有一条 |
| 5 | BW-1、BW-2 | 本地版（Lab 大表）作日常验收，公开站点版放 `live.yml` 手动或每周触发；出口写成“本地版通过 + 联网版待验证” |
| 6 | 有头模式 | M2 不作验收对象，E2E 一律用 chrome-headless-shell；有头问题留待真实桌面确认 |
| 7 | BW-10 性能上限 | 页面滚动与接口截获各 ≤ 3 分钟；超出再讨论，保底降为 2000 条 |
| 8 | C-1 随机注入次数 | M2 做 5 次（固定种子可复现）；PRD 的 20 次放 M4 浸泡 |

## 2. 现状

**M1 已完成**（见 [M1_REVIEW](M1_REVIEW.md)）：observe、act、定位器、浏览器池、页面提示条、12 类夹具、Lab 四个模块；`npm run check` 415 项、bench 8 项、Python 79 项全过，CI 四个任务全绿。未验证项（`--live` 真站、稳定版 Chrome 抽测、有头 Chrome）不阻塞 M2。

**M2 已有的 8 个支撑模块**（各自单测通过，约 5400 行，但还没有一条把它们串起来的路径）：

| 模块 | 文件 | 说明 |
|---|---|---|
| 类型与接口 | `types.ts` | `Executor`、`RunEvents`、`RunOptions`、`RunResult` |
| 模板、参数库、工作区文件 | `template.ts` `params.ts` `files.ts` | `{{param:}} {{var:}} {{file:}}`，敏感值脱敏，限定在工作区内 |
| 工作流加载与校验 | `workflow.ts` | 契约校验 + 结构校验（preamble 位置、循环配对、目标必须是定位器） |
| 运行目录存储 | `store.ts` | 检查点原子写、side_effects、unverified、steps.log、trajectory |
| 页面抽取与接口读取 | `extract.ts`、`core/src/network.ts` | 表格 / 列表 / 键值，分页，虚拟滚动，接口缓存 |
| 采集输出 | `output.ts` | data.jsonl + 主键索引、CSV（BOM）、xlsx |
| 最小监督 | `supervisor.ts` | 心跳、崩溃拉起、1 小时 3 次熔断 |

**M2 还没有的**：runner、CoreExecutor、命令行、任务上下文（多页面）、Lab 的大表 / 文件区 / 服务器管理模块、全部出口用例。

## 3. 架构增量

```
workflow（决定下一步：JSONL 固定流程；以后可换成 LLM agent 循环）
   │ Executor 接口：act / extract / check / pages / resolvePage / actionSeq / screenshot
   ▼
CoreExecutor ──▶ core：act、observe、定位器、extract、network 缓存
                      └─ TaskContext（由 PageRegistry 扩展）：页面表、导航链、别名、每页编号表
```

- runner 只依赖 `Executor` 接口，不引用 core，因此 runner 可以全部用假执行器测。
- 任务上下文放在 core（它是浏览器事实的收集者），别名与段的语义放在 workflow（它是流程语义的拥有者）。

## 4. 工作包

| 包 | 内容 | 主要产出 | 前置 | 验收 | 估计 |
|---|---|---|---|---|---|
| **WP0 契约与设计冻结** | 契约变更与样例（第 5 节）；多页面设计并入 `packages/workflow/DESIGN.md`；M1 评审带来的约定（第 10 节）写进 DESIGN.md | `packages/schemas` 的 step、checkpoint 修改、样例、TS 与 Python 契约测试；`npm run gen:types` | — | `npm run check` 与 pytest 全过；契约变更评审记录 | 小 |
| **WP1 任务上下文（core）** | `PageEntry` 与导航链收集（`frameNavigated`、`navigatedWithinDocument`、`targetCreated/Destroyed` 带 opener）；别名绑定与解析；每页独立编号表与缓存键；`pages()`、`resolvePage()` | `core/src/pages.ts` 扩展、`context.ts` | WP0 | 真浏览器单测：新标签、弹窗、关闭、back/forward、SPA 路由时页面表与导航链正确 | 中 |
| **WP2 runner（workflow）** | 四个子包 R1~R4，见第 6 节 | `runner.ts`、`segment.ts` 等 | WP0 | 假执行器单测约 20 项 | 大 |
| **WP3 Lab 模块** | 大表与数据、文件区、服务器管理（第 7 节） | `lab/src/modules/*` | — | Lab 自带冒烟约 12 项 | 中 |
| **WP4 CoreExecutor 与命令行** | `executor.ts`（act / extract / check / pages）、`cli.ts`（`run / resume / status / unverified`）、`index.ts`；监督进程信号处理；新标签页接口缓存竞态；采集输出日期目录固定 | `executor.ts`、`cli.ts` | WP1、WP2 的接口稳定 | 用命令行跑通一个小工作流 | 中 |
| **WP5 端到端** | 9 个出口用例（第 8 节） | `packages/workflow/test/e2e/*` | WP1~WP4、WP3 | 全部通过 | 大 |
| **WP6 评审与修复** | 对 `packages/workflow` 与 M2 新增的 core 改动做多维度评审、独立复核、逐个修复 | 问题清单 `docs/M2_REVIEW.md` | WP5 | 零阻塞项；全量检查通过 | 中 |
| **WP7 收口** | 文档（DEV_PLAN、README 用法、工作流示例）；`e2e` 纳入 CI；标记 M2 完成 | — | WP6 | CI 全绿，工作区干净 | 小 |

估计用相对量（小：1~2 个 agent 小时；中：3~5；大：6~10）：总计约 **32~45 个 agent 小时**，墙钟约 **2~3 天**（同时最多 2 个 agent，4 核；还受额度与 CI 往返限制）。主要不确定性在 WP2 与 WP5：端到端阶段会暴露问题，M1 的经验是夹具与 Lab 测试一共揭出 12 个内核问题，所以 WP5 内预留约 30% 给修复。

### 4.1 执行顺序与并行

```
WP0 ──┬─▶ WP1 ──────────────┐
      ├─▶ WP2(R1→R2→R3→R4) ─┼─▶ WP4 ─▶ WP5 ─▶ WP6 ─▶ WP7
      └─▶ WP3 ──────────────┘
```

- 两条流水线（各一个 git 工作树和分支）：
  - **流水线 A（workflow）**：WP0 → WP2 的 R1 → R2 → R3 → R4。
  - **流水线 B（core 与 Lab）**：WP1 → WP3 → WP4 的 core 部分（缓存竞态等）。
- WP0 完成并合并后两条线才开始；WP4 的 `executor.ts` 要等 A 线的 `Executor` 接口稳定后由单个 agent 完成，随后合并进主分支。
- WP5 的用例互相独立，可两路并行；每个用例一个提交。
- 每个包结束时：提交并推送，`npm run check` 与相关测试通过，CI 绿。额度中断时靠已提交的进度恢复，不依赖会话内状态。

## 5. 契约变更清单（WP0）

`packages/schemas` 已冻结，按变更流程评审后改，同步更新样例、TS 类型（`npm run gen:types`）、TS 与 Python 契约测试。

| 契约 | 变更 |
|---|---|
| `step.json` | `pageId` 允许别名（正则见决策 1）；新增可选 `opens`（别名）；`extract` 新增可选 `into`（变量名）；新增控制流步骤 `segment_begin`（带 `segment` 名）与 `segment_end`；这两个步骤与现有控制流一样不要求 `pageId` |
| `checkpoint.json` | 新增可选 `pages`（别名、角色、opener、当前 URL、导航深度、开合状态）与 `segment`（`id`、`start`、`lookup_done`） |
| `common.json` | 错误码已有 `page_not_found`、`not_found`、`not_unique`、`invalid_params`，不新增 |
| `act-result.json` | 无变更（`effects.new_pages` 已满足 `opens`） |
| 样例 | `packages/schemas/examples/step`、`checkpoint` 各加多页面样例；Python 端共用同一批样例 |

## 6. WP2 runner 的子包

| 子包 | 内容 | 假执行器单测要点 |
|---|---|---|
| **R1 控制流与失败处理** | 步骤即动作；`loop / if / call / set_var / break`；模板渲染；`retry` 与 `on_fail`（`stop / skip / human`）；事件；`steps.log`；`into` 写变量 | 表驱动：控制流嵌套、重试次数、三种失败策略 |
| **R2 单次提交与状态未明** | `once_only` 全分支（成功 / 已发出未确认 / 未发出）；`dispatched` 字段判定；幂等键；待核实清单；跳过模式与“连续 2 条停止”；`anchor` 页面重置 | 表驱动：错误码 × `once_only` × 模式；`dialog_blocking` 带 `dispatched:true` 记 unverified、带 false 按普通失败 |
| **R3 检查点、续跑与多页面** | 检查点写入时机；续跑算法；页面别名解析与 `opens`（0 / 1 / 多个新页）；`segment` 与 `lookup_done`；页面表一致性核对；静态检查（同段内 `once_only` 之后不能再有需重做的填写） | 续跑从段起点重做、查询步骤跳过；别名未绑定报 `page_not_found` |
| **R4 抽取与输出集成** | `extract` → `Output`；日期目录在运行开始时固定并写入检查点；暂停 / 停止 | 重复主键跳过、续跑不重复 |

约束沿用 DESIGN.md：`once_only` 步骤永不自动重试；敏感值在日志与检查点里一律 `***`，被脱敏的循环变量不从检查点恢复。

## 7. Lab 模块（WP3）

| 模块 | 内容 | 对应用例 |
|---|---|---|
| 大表与数据 | 行数可配置（默认 1 万）；虚拟滚动与分页两种呈现；同一份数据有 `/api/rows?page=`；稳定主键，内容由种子决定，可重置 | BW-1 本地版、BW-2、BW-10 |
| 文件区 | 上传（记录文件名与哈希）、下载（含中文文件名）、列表 | FR-35 端到端 |
| 服务器管理 | 编辑表单的某个参数要去文档页查；文档页两种变体：`target=_blank` 新标签、同标签链接（含 bfcache 不命中）；提交带幂等键，服务端记录提交次数与值 | BW-15 |

BW-1 的本地版保留原题特征：50 页 1000 条、第 23 页注入崩溃；BW-2：滚动加载加 `/api/` 接口 100 条。BW-9 用 `_lab/reset {"orders":1000}`。

## 8. 出口用例（WP5）

| 用例 | 内容 | 数据源 | 要点 |
|---|---|---|---|
| BW-1 | 50 页 1000 条，主键为详情链接，导出 CSV；第 23 页崩溃后续采与不崩溃结果完全相同 | Lab 大表（分页） | 1000 条零重复；CSV 带 BOM |
| C-3 | 采集中断：第 23 页结束进程，续采零重复零遗漏 | 同上 | 确定性钩子 + SIGKILL |
| BW-2 | 接口截获与页面滚动各收集一次，都是 100 条且内容一致 | Lab 大表（滚动）+ 夹具快响应 / 轮询 | “动作之后到达”的序号机制，含响应早于抽取步骤 |
| BW-10 | 虚拟滚动大表 1 万条：页面滚动与接口截获各跑一次，内容一致 | Lab 大表 | 各 ≤ 3 分钟 |
| BW-9 | 按订单号逐条审核 500 条，期间注入提交超时；服务端零重复；状态未明进入待核实；跳过模式下其余照常完成 | Lab 订单 + `commit_timeout` | 以 Lab 服务端幂等键计数为判据 |
| C-4 | 提交后超时（已落库不返回）：标记状态未明、不重试、默认停止并提示 | Lab 订单 | 对比 side_effects 与服务端提交数 |
| C-5 | 连续两条提交超时：跳过模式下第二条后停止 | Lab 订单 | 中间成功一条后计数清零 |
| C-1 | 随机时刻 SIGKILL 子进程：监督进程拉起、重放前置路径、从检查点续跑，结果与不被杀一致 | 订单批量与采集各一份 | 固定种子，5 次 |
| **BW-15** | 新标签查文档 → 取值 → 关闭辅助页 → 回原页校验 → 填写余下 → 提交；同标签跳转变体另测一次 | Lab 服务器管理 | 分别注入：辅助页被关闭、原页被重载、进程被杀；服务端恰好一次提交且值正确，续跑不重复查询 |

通用判据：每个用例结束后核对 **服务端状态**（Lab `_lab/state`）与 **引擎产物**（`data.jsonl`、`side_effects.jsonl`、`unverified.jsonl`、检查点 `pages`）互相对得上。这是 M2 最有价值的断言。

## 9. 质量门与流程规则

1. 每个包合并前：`npx biome check .`、`npx tsc -p .`、`npm run check` 全过；涉及浏览器的包再跑 `npm run test:bench`。浏览器缺失时测试必须失败而不是跳过（`OBACT_REQUIRE_BROWSER=1`）。
2. 测试少而有价值：每条测试对应一个需求或一个真实风险；runner 用假执行器测逻辑，真浏览器只在 core 单测与 E2E 里用。
3. 契约先行：契约变更只在 WP0 做；其余包发现契约缺口，回到 WP0 流程。
4. 两条流水线用独立 git 工作树，文件所有权不重叠；每个小任务一个提交，提交说明写工作包与编号。
5. WP6 评审沿用 M1 的做法：多维度并行查找、独立复核者逐条尝试推翻、整理成清单后逐个修复、统一测试。
6. 每个工作包结束都推送，不把进度留在会话里（额度和工作进程重启都出现过）。
7. 不引入新依赖，除非 `package.json` 已有；xlsx 用最小实现。

## 10. M1 评审带给 M2 的接口约定（WP0 落实到 DESIGN.md）

详见 [M1_REVIEW](M1_REVIEW.md) 第 5 节。

1. **`dialog_blocking` 不再一律是“未发出”**：后置检查或等待期间被对话框打断时，错误的 `details.dispatched` 为 true，表示动作已执行。runner 对 `once_only` 步骤必须读它：为 true 按“已发出、结果未确认”处理（记 unverified、不重试）。`DESIGN.md` 第 7 条要同步改。
2. **接口缓存的大整数**：超过 2^53 的整数以十进制字符串保留；抽取结果里该字段是 string。`DESIGN.md` 第 12 条补一句。
3. **BW-9 的数据量**：Lab 的 `_lab/reset` 可带 `{"orders": 1000}`（约 600~640 条待审核）；故障开关有校验；`drop_rate` 对写接口是“先落库再断开”。
4. **定时改版**：Lab 的 `redesign_after_requests` / `redesign_after_ms` / `redesign_to`，用于长任务中途改版的演练。
5. **导航协议**：`navigate_page` / `new_page` 只放行 http、https、about:blank 和工作区内的 file:。

## 11. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 完整 Chrome 点击导航后输入失效（有头 / 新无头） | 有头模式下 C-1、BW-9 可能不稳 | E2E 一律 chrome-headless-shell；有头在真实桌面确认前，文档注明“有头未验证” |
| 页面表依赖 CDP 事件，漏事件会让别名绑错或页面表落后 | BW-15 不稳，别名解析出错 | `opens` 强制“恰好一个新页面”，其余情形报错；页面表与 `Target.getTargets` 周期性对账；单测覆盖弹窗、关闭、SPA、back/forward |
| 新标签页接口缓存竞态（新页面在附加前到达的响应会漏） | BW-2 在新标签页场景漏条 | 变通：新开页后先 `cache.ready()` 再导航；根治用 `Target.setAutoAttach` 或在页面登记处挂钩（WP4），不行就文档注明限制 |
| 监督进程 + SIGKILL 的测试依赖时序 | C-1、C-3、BW-15 不稳 | 确定性钩子（第 N 步后自杀）加固定种子的随机；心跳间隔在测试里调小 |
| runner 复杂度（单次提交 × 跳过模式 × 续跑 × 段 × 多页面） | 漏分支，单次提交重复 | 表驱动单测（错误码 × `once_only` × 模式），段与页面表另设用例；静态检查拦截危险编排 |
| BW-1 / BW-2 公开站点版本无法在容器验证 | 出口只能“本地版通过” | `live.yml` 手动或每周触发；出口里分开标注 |
| 估时偏乐观 | 超出一两天 | WP5 预留 30%；紧时先保 BW-9、C-1、C-4、C-5、BW-15（单次提交、崩溃恢复和多页面，是核心承诺），BW-10 降为 2000 条 |
| 额度或工作进程中断 | 长任务半途停止 | 每个包提交推送；流水线脚本可从缓存恢复，必要时只重跑未完成的包 |

## 12. 暂不做（留给后续里程碑）

- 任务内并发协作页 → M4 之后（与并行规则一起）。
- 增量 observe、`outline / query`、隔离世界 → 单独设计，M4 之前评估。
- 真正的人工接管（`need_human` 在 M2 等同暂停）→ M3。
- 弹窗规则、页面签名、参数库的实时询问与保存、录制器自动生成别名 → M3。
- 完整熔断、卡住截图、运行报告、资源采样 → M4。
- JSON-RPC 服务与 Python 客户端 → M4。
- LLM agent 循环 → 第一阶段不接模型；`Executor` 接口与轨迹格式保持决策者无关。
