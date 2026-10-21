# bench：对照与基准

## 基准工作流 BW-3、BW-6、BW-7、BW-12（`bw3.ts`、`bw6.ts`、`bw7.ts`、`bw12.ts`）

M1 出口要求的四个基准。默认跑本地场景（夹具库、Lab），不需要联网；全部通过时退出码为 0，有失败为 1。浏览器用 `npm run browser:install` 装的版本，设了 `CHROME_PATH` 则用它。

| 脚本 | 基准 | 参数 | 报告（`bench/out/`，不入库） |
|---|---|---|---|
| `bw3.ts` | BW-3 延迟与异步 | `--live`、`--only L2,L3`（只跑指定场景）、`--out 目录` | `bw3-local.md/.json`；加 `--live` 为 `bw3-live.*` |
| `bw7.ts` | BW-7 弹窗与页面结构（不含“存为规则”） | 同 `bw3.ts` | `bw7-local.md/.json`；加 `--live` 为 `bw7-live.*` |
| `bw6.ts` | BW-6 定位可靠性 | `--live`（只跑公开站点）、`--all`（本地和公开站点都跑） | `bw6-report.md`、`bw6-results.json`；只加 `--live` 时为 `bw6-live-*` |
| `bw12.ts` | BW-12 视觉观察与坐标动作 | 同 `bw6.ts` | `bw12-report.md`、`bw12-results.json`、`bw12-steps/<场景>.jsonl`；只加 `--live` 时为 `bw12-live-*` |

```bash
node bench/bw3.ts                            # 本地全部场景
node bench/bw3.ts --only S0 --out /tmp/bw3   # 只跑 S0（扫描脚本里没有固定延时），报告写到 /tmp/bw3
node bench/bw6.ts                            # 本地全部场景，约 1 分钟
node bench/bw12.ts --all                     # 本地加公开站点
npm run test:bench                           # 上面四个的本地场景加回归用例，约 2~3 分钟；CI 里是独立任务 bench
```

`--live` 要访问公开站点（quotes.toscrape.com、uitestingplayground.com、the-internet.herokuapp.com），这条路径没有测试执行过，也没有在真站上跑过：`bw6.ts`、`bw12.ts` 只加 `--live` 而访问不了站点时，如实报告“没有结果”并退出 1，`bw3.ts`、`bw7.ts` 把对应场景记为失败。首次真实运行在 `.github/workflows/live.yml`（手动触发或每周一次）。

## BW-14 组件识别对照（`bw14.ts`）

同一批页面分别用 Obact 和 BrowserGym 提取可交互元素，按位置（IoU ≥ 0.6）逐条比对，结果写到 `bench/out/`（不入库）。Obact 一侧取 `observe` 返回的 `elements`（智能体实际看到的元素表），不是识别层的原始编号。

### 准备

```bash
spikes/miniwob/fetch.sh                      # MiniWoB++ 任务页（MIT）
python3 -m venv spikes/.cache/venv-bg        # BrowserGym 单独的虚拟环境，不进入 obact 依赖
spikes/.cache/venv-bg/bin/pip install playwright==1.56.0 numpy pillow "lxml<6" beautifulsoup4 pyparsing gymnasium
spikes/.cache/venv-bg/bin/pip install --no-deps browsergym-core==0.14.3
```

`browsergym-core` 锁定 `playwright==1.44`；这里只用它的提取函数，所以换成与本机 Chromium 141 匹配的 Playwright 1.56。

### 运行

```bash
node bench/bw14.ts            # 全部页面：组件陈列页 + 测试应用（Lab）11 个页面 + 130 个 MiniWoB++ 任务页（种子 0）
node bench/bw14.ts --limit 20 # 只跑前 20 个 MiniWoB++ 页面
```

环境变量：`CHROME_PATH`（Obact 用的浏览器）、`BG_PYTHON`（BrowserGym 虚拟环境的 python）、`MINIWOB_HTML`。

### 口径

- 只计 BrowserGym 一侧可见的元素。Obact 一侧只要出现在 `observe` 的元素表里就算命中，包括它判为不可见的元素（如 opacity 为 0 的真实输入框）；元素表受字符预算限制，被截断的页面数记在报告里。
- 页面范围：组件陈列页、Lab 各模块不需要登录的页面（登录、验证、复杂结构及其 iframe 与组件库页、干扰层）、MiniWoB++ 任务页。Lab 的订单、账号页需要登录态，BrowserGym 一侧的脚本不带 cookie，没有纳入。
- 不计入分母的 BrowserGym 节点：页面根（`body`/`html`，带监听但不是组件），以及与控件重复的 `label`（点击 label 等同于点击其控件；Shadow DOM 里的 label 按 Chrome 的角色名 `LabelText` 认）。label 另外核对：主文档里有标注控件的 label，其控件必须出现在 `observe` 的元素表里（iframe 与 Shadow DOM 里的 label 不核对）。
- 从分母扣除、并逐条列在报告里的两类 BrowserGym 节点（报告同时给出不扣除的召回）：
  - option：下拉框、列表框的选项在所属元素的 `options` 字段里，不单列为元素（名称出现在某个元素的 `options` 里才算）；
  - 同位置折叠的重复元素：`observe` 把外壳折叠进内层元素，如树节点里的 `span.folder`、控件外面的 `ui-wrapper`（与已匹配的元素 IoU ≥ 0.6）。
- 匹配分两轮：先要求角色一致（Chrome 内部角色名如 `ColorWell`、`Date` 先换算成 ARIA 角色），再只按位置匹配。

### 最近一次结果（2026-10-21，Chromium 141，142 个页面）

| 指标 | 结果 |
|---|---|
| 页面 | 142：组件陈列页 1、Lab 11、MiniWoB++ 130（种子 0） |
| BrowserGym 可交互元素（可见） | 653 |
| 从分母扣除 | 15：option 在 options 字段里 9（组件陈列页 3、click-scroll-list 6），同位置折叠的重复元素 6（navigate-tree 3，click-widget、resize-textarea、use-spinner 各 1） |
| Obact 匹配到 | 638/638（召回 100%）；不做扣除为 638/653（97.7%）。分页面组：组件陈列页 32/32、Lab 62/62、MiniWoB++ 544/544 |
| label 核对 | 主文档 592 个 label，其中有标注控件的 50 个，控件都在 observe 的元素表里 |
| Obact 额外识别（可见） | 99：坐标图的点、饼图扇区、可拖拽的图形、数字块、滑块手柄、日历与表单里的包装元素，以及 Lab 复杂结构页里 BrowserGym 取不到的金额框、支付按钮和组件库的 tab，都是任务要点击或拖动的元素 |
| 角色叫法不同 | 114：主要是 CSS `content:url()` 渲染的图标，Chrome 叫 image、Obact 叫 generic；这些元素没有可访问名称，Obact 用 `hint` 给出 star、delete trash、search、reply 等提示 |
| observe 被字符预算截断的页面 | 0 |

之前的口径取识别层 `markPage` 的编号、只跑组件陈列页和 MiniWoB++（131 页）：591/591。那个口径把被编号但 `observe` 又丢掉的元素（下拉框的选项、被折叠的外壳）也算召回，已弃用。

这次对照找出并修复了 3 个问题：带非交互角色、又绑了监听的容器（可拖拽对话框、事件委托的 tablist）被漏掉；没有 href 但绑了监听的 `<a>` 被漏掉；`<a href role="presentation">` 没有按 ARIA 冲突规则忽略 presentation 角色。

## MiniWoB++ 任务（`miniwob.ts`）

只用 `observe` + `act` 完成 MiniWoB++ 任务：每步先 `observe` 拿到可操作元素及其可用操作，按任务说明选出元素和动作，再用 `act` 执行（可信输入），最后读任务页的 reward 判定成败。求解规则写在脚本里，不读页面私有变量。

```bash
spikes/miniwob/fetch.sh   # 同上
node bench/miniwob.ts     # 10 个任务 × 5 个种子
```

### 最近一次结果（2026-10-15，Chromium 141）

click-button、click-link、click-dialog、click-tab、focus-text、enter-text、enter-password、login-user、click-checkboxes、click-option 各 5/5，合计 50/50。
