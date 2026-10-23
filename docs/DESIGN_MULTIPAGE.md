# 任务上下文与多页面流程设计（M2）

状态：已精简（见下方说明）。原同步到 [`packages/workflow/DESIGN.md`](../packages/workflow/DESIGN.md)、契约（`packages/schemas`，已冻结，按变更流程评审）和 [M2 计划](M2_PLAN.md)。术语见 PRD 第 3 节。

> **2026-10-22 精简**：本稿原先的方案过重，M2 只实现其中的最小部分，以 [M2 计划](M2_PLAN.md) 第 3 节为准：runner 里一张别名表（`opens` 绑定、`pageId` 写别名、`extract.into`）；续跑的重做单位用已有的循环条目与 `checkpoint` 步骤。下文的任务上下文（页面表、导航链）、检查点 `pages` / `segment` / `lookup_done`、`segment_begin / end`、静态检查、对账等**均已取消**，保留仅作为将来需要时的参考。

## 1. 要解决的问题

一个任务经常要“去别处查信息，再回来继续”：比如在服务器管理后台填一张表单，某个参数要去文档页查；查到后回到表单填剩下的部分。这里有四个难点：

1. 一个任务会同时拥有多个标签页，每个标签页还会依次装下多个文档（导航链），需要有地方记住“现在有哪些页、各自在哪、谁打开了谁”。
2. 工作流是录制出来、纯程序回放的，不能依赖编号（编号只在一次 observe 内有效），所以要有稳定的方式引用“那个文档页”。
3. 表单填到一半，状态只存在于页面里，崩溃后无法恢复。
4. 无论是固定的 JSONL 回放，还是以后接入大模型的 agent 循环，都应该跑在同一套底座上。

不在本设计范围：任务内的**并发**协作页（同时驱动多个页面）。那是 M4 之后与并行规则一起设计的事；本设计的数据结构为它留好了位置，但 M2 的执行线始终只有一条。

## 2. 总体结构

```
决策者（谁决定下一步）                 执行底座（同一套）
┌──────────────────────┐        ┌────────────────────────────────────┐
│ 固定 JSONL（纯程序）   │        │ 任务上下文 TaskContext              │
│ LLM agent 循环        │ ─────▶ │   页面表 pages（别名、角色、opener）   │
│ 人（交互脚本、接管）    │        │   每页导航链、每页编号表/观察缓存      │
└──────────────────────┘        │   变量 vars、检查点、side effects     │
                                │ observe / act / extract（core）     │
                                └────────────────────────────────────┘
```

- 决策者不同，底座相同。执行器接口（`Executor`）只依赖动作和结果，不关心是谁发的；轨迹文件记录“看到了什么、选了什么、结果如何”，LLM 探索出来的轨迹可以由人审核后固化成 JSONL。
- 任务上下文由 `core` 的 `PageRegistry` 扩展而来，由内核收集浏览器事件自动维护，不依赖调用方汇报。

## 3. 数据模型

```ts
type PageEntry = {
  page_id: string;            // 内核登记的标签页编号（现有）
  alias?: string;             // 工作流里的页面别名，如 "main"、"docs"
  role: 'main' | 'aux';       // main：任务起点打开的页；aux：因查询而打开的辅助页
  opener?: string;            // 打开它的 page_id（弹窗、target=_blank、new_page）
  nav: NavEntry[];            // 导航链，最后一项是当前文档
  state: 'open' | 'closed';
};
type NavEntry = {
  url: string;
  title?: string;
  at: string;                 // 时间
  via: 'initial' | 'click' | 'navigate' | 'redirect' | 'history' | 'spa' | 'reload';
  step_id?: string;           // 触发这次导航的步骤
  signature?: string;         // 页面签名匹配到的名称（M3 起）
};
```

收集方式（CDP 事件，不依赖动作返回值）：

| 事件 | 记录 |
|---|---|
| `Page.frameNavigated`（主 frame） | 新的 `NavEntry`，`via` 由触发原因判定 |
| `Page.navigatedWithinDocument` | SPA 路由变化：同一文档的新视图，追加 `via:'spa'` |
| `Target.targetCreated`（type=page，带 `openerId`） | 新 `PageEntry`，`opener` 填入 |
| `Target.targetDestroyed` | `state:'closed'`，从别名表解绑 |
| 后退、前进 | 使用浏览器历史，`nav` 上追加一项并标 `via:'history'`（不删除旧项，方便回溯） |

`nav` 只保留最近 50 项；保留的内容不含页面正文，只有 URL、标题、时间，不会产生敏感数据问题（URL 里的令牌参数在日志和检查点里按敏感规则遮蔽查询串）。

## 4. 页面别名与步骤字段（契约草案）

步骤上的 `pageId` 现在是必填的标签页编号。改为：**可以是编号，也可以是别名**；运行时由引擎解析。新增一个可选字段 `opens`：

```json
{"step_id":"s10","op":"click","pageId":"main","target":{"role":"link","name":"参数说明"},"opens":"docs"}
{"step_id":"s11","op":"extract","pageId":"docs","source":{"type":"dom","kind":"kv","root":{"css":"#params"}},"as":"param"}
{"step_id":"s12","op":"close_page","pageId":"docs"}
{"step_id":"s13","op":"fill","pageId":"main","target":{"role":"textbox","name":"内存上限"},"value":"{{var:param.mem_limit}}"}
```

规则：

1. **保留别名 `main`**：运行开始时的第一个标签页。`new_page` 步骤用 `opens` 给新页起名，也可以不起名（只能用返回的编号，不推荐）。
2. **`opens` 的语义**：这一步执行后，`effects.new_pages`（M1 已有）里**恰好出现一个**新标签页，绑定到该别名；0 个报 `not_found`（“预期会打开新页面但没有”），多于 1 个报 `not_unique`。同一别名已绑定且页面仍开着，报 `invalid_params`（避免悄悄覆盖）。
3. **同标签跳转**不用 `opens`：用 `navigate_page`（`url / back / forward / reload`）或点击链接，页面别名不变，但导航链追加一项。
4. **别名解析失败**（别名未绑定、页面已被用户关闭）：报 `page_not_found`，按失败策略处理，不会悄悄用别的页面。
5. **取值带回**：`extract` 已有 `as`（变量名，结果写入 `vars`）； `set_var` 仍可用。取到的值进入检查点的 `vars`（敏感值除外）。
6. **回程校验**：回到原页面后的下一步，建议带 `pre`（步骤前置检查）：`url_matches`/页面签名/关键字段 `value_equals`。检查不过按 `on_fail`（默认 `human`）。引擎不自动补填，补填是工作流作者或决策者的事（见第 6 节）。

录制器（M3）录到“点击后出现新标签页”时自动生成 `opens`，录到切换标签页时自动生成对应的 `pageId` 别名，别名默认取页面标题的拼音或序号（`tab2`），用户可改。

## 5. 检查点与续跑

检查点增加 `pages` 和 `segment`：

```json
{"run_id":"run_42","workflow":"edit_server","mode":"headless","state":"RUNNING",
 "step_id":"s13","loop_index":{},"vars":{"param":{"mem_limit":"4096"}},"cursor":{},
 "segment":{"id":"seg_fill","start":"s08","lookup_done":true},
 "pages":[
   {"alias":"main","role":"main","url":"https://admin.local/servers/12/edit","nav_depth":1},
   {"alias":"docs","role":"aux","opener":"main","url":"https://docs.local/params","nav_depth":1,"state":"closed"}
 ],
 "seq":31}
```

- `pages` 只存可恢复的最小信息（别名、角色、opener、当前 URL、导航深度、开合状态）；完整导航链放 `trajectory`，不进检查点（避免检查点膨胀）。
- **段（segment）**：工作流用成对的控制流步骤 `{"op":"segment_begin","segment":"seg_fill"}` … `{"op":"segment_end"}` 标出“从打开表单到提交”的可重放段（段不嵌套，不跨循环条目）。段是**续跑的最小单位**：崩溃后从段起点重做，不尝试从半填状态继续。段里已经提交成功的 `once_only` 步骤由 `side_effects` 保证不重复。
- **查询完成标记**：段内的查询部分结束时写一次检查点（`lookup_done:true`，`vars` 里已有查到的值）。续跑时：
  1. 重放前置路径，恢复 `main` 页面；
  2. 回到段起点；
  3. `lookup_done` 为 true 的查询步骤整体跳过（它们只读、结果已在 `vars`），直接用变量填表。
- **辅助页不恢复**：续跑不重开 aux 页（除非后面的步骤还要用它，此时 `pageId` 解析失败报 `page_not_found`，由工作流用 `opens` 重新打开；因此“重开文档页”是显式的步骤，而不是引擎的隐式行为）。
- **检查点写入时机**（沿用 DESIGN.md 第 8 条，增加两项）：段开始、查询完成。

续跑算法的页面部分：

```
读检查点 → 恢复 vars → 重放 preamble（重建 main）
→ 若 segment 存在：跳到 segment.start；其中 lookup_done 的只读步骤跳过
→ 页面表只用于一致性核对：main 的 URL 与检查点不符 → 记警告，由段内 pre 检查决定是否重做
```

## 6. 半填表单的策略（决策表）

| 情形 | 做法 | 谁负责 |
|---|---|---|
| 查询值在填表前就能确定 | **先查后填**：所有查询放在段的前半部分，值进 `vars`，再一次性填完 | 工作流作者（推荐的默认写法） |
| 边填边查，且文档在新标签打开 | 原页面不动；`opens` 打开辅助页取值；`close_page` 关闭；回原页，用 `pre` 做回程校验 | 引擎提供，作者编排 |
| 只能同标签跳转 | 离开前读出已填字段并存入 `vars`；回来后 `pre` 校验，缺的重填；有“保存草稿”先存。敏感字段读不出明文，回来后用参数库重填 | 作者；引擎的 `observe` 提供值读取 |
| 辅助页在查询中崩溃或被页面关闭 | `page_not_found` → 按 `on_fail`：`retry` 重新 `opens`（辅助页是只读的，重做安全） | 引擎报错，策略由作者定 |
| 原表单页在查询期间崩溃或被重载 | 回程校验失败 → 从段起点重做（`vars` 里的查询结果还在，不用再查） | 引擎的段机制 |
| 崩溃后续跑 | 见第 5 节 | 引擎 |

**一个硬规则**：段内、`once_only` 步骤之前的所有动作必须是幂等的（填写、选择、只读查询）。引擎在加载工作流时做静态检查：同一段里 `once_only` 步骤之后不允许再出现需要重做的填写（否则提交成功但后续失败时，续跑会重复）。

## 7. observe 与缓存

- 每个标签页独立的编号表和观察缓存（缓存键：`page_id + 文档 URL + 版本号`）；切换页面不丢缓存。
- 回到旧文档（后退）时，先比对 URL 与（可用时）页面签名，命中则复用缓存并做一次轻量校验，不命中则全量 observe。
- M2 **不做** DOM 增量；缓存的版本号和 `outline/query`、增量更新是后续方案（见“减少全量刷新”的讨论），契约里先预留 `version` 字段的位置，不实现。

## 8. 决策者无关：与 LLM agent 循环的衔接

| 能力 | 纯程序回放 | LLM 探索 |
|---|---|---|
| 引用页面 | 别名（`pageId:"docs"`） | 页面表里的编号 + 别名，LLM 也可以为页面取别名 |
| 引用元素 | 定位器 | 编号（observe 结果），固化时换算成定位器 |
| 看页面 | 极少 observe，靠 `pre/post` 检查 | observe（以后用 `outline/query` 取小片段） |
| 页面变化后 | 每步重新解析定位器 | act 返回 `effects`（导航、新页面、对话框），据此决定是否重新 observe |
| 记录 | `steps.log`、轨迹 | 轨迹（观察摘要 + 选择 + 结果），可审核后固化为 JSONL |

执行器接口新增（在 `Executor` 上，决策者共用）：

```ts
pages(): PageEntry[];                     // 当前页面表（只读副本）
resolvePage(alias: string): string;       // 别名 → page_id，找不到抛 page_not_found
```

## 9. 边界情形

| 情形 | 行为 |
|---|---|
| 点击后新开多个标签页（广告弹窗） | `opens` 报 `not_unique`；弹窗规则（M3）处理广告，M2 里转人工 |
| 辅助页被网站自己关闭（如 `window.close()`） | 页面表标记 `closed`，别名解绑；后续引用报 `page_not_found` |
| 同一别名被重复 `opens` | `invalid_params` |
| 辅助页里再点链接打开第三层页面 | 允许，`opener` 链记录；每个页面各自有别名；层数只受内存限制 |
| 辅助页需要登录 | 同一浏览器配置目录共享登录态；未登录时按人工接管流程（M3） |
| SPA 里路由切换（URL 变但不是新文档） | 追加 `via:'spa'` 导航项，编号表和缓存失效，别名不变 |
| 回到原页面时它已经被重新加载 | 回程校验失败 → 按 `on_fail` 处理；默认转人工 |
| 浏览器整体崩溃 | 池重启浏览器（M1 已有），页面表清空，按续跑流程重建 `main` |

## 10. 测试

少而有价值，只测需求与真实风险：

1. **Lab 新模块“服务器管理”**：编辑表单里有一个参数需要查文档页；文档页提供两种变体——`target=_blank` 新标签、同标签链接（含 bfcache 不命中的情形）；提交带幂等键，Lab 记录提交次数。
2. **验收用例 BW-15（新增）**：新标签查文档 → 取值 → 关闭辅助页 → 回原页校验 → 填写余下 → 提交；中途分别注入：辅助页关闭、原页被重载、进程被杀；断言：最终服务端恰好一次提交，值正确，续跑不重复查询。
3. **runner 单测（假执行器）**：别名绑定与解析、`opens` 的 0/1/多个新页、段的续跑算法、静态检查（`once_only` 之后不能再有重做填写）。
4. **页面表单测（真浏览器）**：新标签、弹窗、关闭、`navigate_page` 的 back/forward、SPA 路由，页面表与导航链正确。

## 11. 对 M2 计划的影响

新增工作包 **W1b 任务上下文**（在 W1 runner 之前，与 W2 Lab 并行）：

| 内容 | 位置 | 估计 |
|---|---|---|
| 页面表与导航链收集（CDP 事件） | `packages/core/src/pages.ts` 扩展 | 中 |
| 别名解析、`opens`、段与检查点扩展 | `packages/workflow`（runner、store、workflow.ts 静态校验） | 中 |
| 契约变更：step（`opens`）、checkpoint（`pages`、`segment`） | `packages/schemas`，走变更评审 | 小 |
| Lab“服务器管理”模块与 BW-15 | `lab/`、`bench` 或 E2E | 中 |

总计约增加 M2 工作量的 20%。不影响 M2 出口之外的里程碑。

## 12. 已确认的决策（2026-10-22）

1. 页面别名复用步骤的 `pageId` 字段；别名 `^[A-Za-z][A-Za-z0-9_]*$`，标签页编号带 `p` 加数字前缀，靠命名区分。
2. 可重放段用独立的 `segment_begin / segment_end` 控制流步骤表示，不嵌套、不跨循环条目。
3. 续跑后辅助页不由引擎隐式重开，需要时工作流显式 `opens`。
4. 任务内并发协作页放 M4 之后，与并行规则一起设计。

开发计划见 [M2 计划](M2_PLAN.md)。
