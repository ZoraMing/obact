# bench：对照与基准

## BW-14 组件识别对照（`bw14.ts`）

同一批页面分别用 Obact 和 BrowserGym 提取可交互元素，按位置（IoU ≥ 0.6）逐条比对，结果写到 `bench/out/`（不入库）。

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
node bench/bw14.ts            # 全部页面：组件陈列页 + 130 个 MiniWoB++ 任务页（种子 0）
node bench/bw14.ts --limit 20 # 只跑前 20 个 MiniWoB++ 页面
```

环境变量：`CHROME_PATH`（Obact 用的浏览器）、`BG_PYTHON`（BrowserGym 虚拟环境的 python）、`MINIWOB_HTML`。

### 口径

- 只计 BrowserGym 一侧可见的元素。Obact 一侧只要识别到就算命中，包括它判为不可见的元素（如 opacity 为 0 的真实输入框）。
- 不计入分母的 BrowserGym 节点：页面根（`body`/`html`，带监听但不是组件），以及与控件重复的 `label`（点击 label 等同于点击其控件）。
- 匹配分两轮：先要求角色一致（Chrome 内部角色名如 `ColorWell`、`Date` 先换算成 ARIA 角色），再只按位置匹配。

### 最近一次结果（2026-10-15，Chromium 141，131 个页面）

| 指标 | 结果 |
|---|---|
| BrowserGym 可交互元素（可见） | 591 |
| Obact 匹配到 | 591（召回 100%） |
| Obact 额外识别（可见） | 171：网格单元、日历格、社交媒体的回复/转发/点赞图标、饼图扇区等，都是任务要点击的元素 |
| 角色叫法不同 | 114：主要是 CSS `content:url()` 渲染的图标，Chrome 叫 image、Obact 叫 generic；这些元素没有可访问名称，Obact 用 `hint` 给出 star、delete trash、search、reply 等提示 |

这次对照找出并修复了 3 个问题：带非交互角色、又绑了监听的容器（可拖拽对话框、事件委托的 tablist）被漏掉；没有 href 但绑了监听的 `<a>` 被漏掉；`<a href role="presentation">` 没有按 ARIA 冲突规则忽略 presentation 角色。

## MiniWoB++ 任务（`miniwob.ts`）

只用 `observe` + `act` 完成 MiniWoB++ 任务：每步先 `observe` 拿到可操作元素及其可用操作，按任务说明选出元素和动作，再用 `act` 执行（可信输入），最后读任务页的 reward 判定成败。求解规则写在脚本里，不读页面私有变量。

```bash
spikes/miniwob/fetch.sh   # 同上
node bench/miniwob.ts     # 10 个任务 × 5 个种子
```

### 最近一次结果（2026-10-15，Chromium 141）

click-button、click-link、click-dialog、click-tab、focus-text、enter-text、enter-password、login-user、click-checkboxes、click-option 各 5/5，合计 50/50。
