# M0 技术预研结论

对应 [开发计划](../DEV_PLAN.md) 3.1 的三项预研。脚本在 `spikes/`，都可以复跑。

**环境**：Chromium 141.0.7390.37（本容器预装，Playwright 构建 1194）、puppeteer-core 25.12.0、Node 22.22、Linux 容器（root）。有头模式用 Xvfb 运行，结果与无头一致。

**CfT 复核（已完成）**：这个容器下载不了 Chrome for Testing，所以改在 GitHub Actions 的 `spikes-cft` 任务里，用 **Chrome for Testing 141.0.7390.122** 复跑了扩展加载（无头、有头 Xvfb）和进程模型/编号两个脚本。结果与本机 Chromium 141 完全一致，见第 5 节。

## 1. 服务管理浏览器 + 元素编号

脚本：`node spikes/browser/service.ts`（有头：`HEADED=1 xvfb-run -a node spikes/browser/service.ts`）

### 1.1 进程模型（PRD 8.1、FR-02、FR-03）

| 验证项 | 结果 |
|---|---|
| 服务进程按账号启动浏览器，每个账号一个独立配置目录 | 可行。调试端口默认只绑定 `127.0.0.1` |
| 任务子进程用 `puppeteer.connect` 连接同一浏览器 | 可行 |
| 任务子进程被 `SIGKILL` | 浏览器保持连接，标签页还在 |
| 新的子进程接管已有标签页 | 可行：按 URL 找回页面，页面内容、localStorage、Cookie 都还在 |
| 浏览器重启，复用同一配置目录 | 登录态保留（持久 Cookie 和 localStorage 都在） |

注意事项：

- 不要传 `--remote-debugging-address`：传了 Puppeteer 启动会超时，而默认已经只绑定本机。
- Chrome 136 起，默认配置目录不允许开远程调试端口。我们按账号使用独立配置目录，不受影响。
- 容器里以 root 运行时，Chromium 必须加 `--no-sandbox`。正式部署不用 root 运行，不需要这一项。

### 1.2 编号写进元素属性（FR-05、FR-06，参考 BrowserGym）

测试页 `spikes/fixtures/refs.html` 包含：主文档、同源 iframe、跨域 iframe（OOPIF）、开放和封闭的 Shadow DOM、整块重绘的列表。

| 位置 | 写入方式 | 结果 |
|---|---|---|
| 主文档、开放 Shadow DOM | 页面脚本遍历 | 10 个 |
| 同源 iframe | 每个 frame 单独执行页面脚本 | 2 个 |
| 跨域 iframe（OOPIF） | Puppeteer `frame.evaluate` 可直接在 OOPIF 中执行 | 2 个 |
| 封闭 Shadow DOM | 页面脚本进不去；用 CDP `DOM.getDocument(pierce)` + `DOM.setAttributeValue` 写入 | 1 个 |

**各视图编号一致**：

- DOMSnapshot 一次取回同一进程内的所有文档（主文档、同源 iframe、封闭 Shadow DOM），能读到 13 个编号。
- 可访问性树中，13 个可交互节点全部能对上编号。唯一的例外是 `<select>` 里的 `<option>`：它没有被编号，M1 需要决定是否给它编号。BrowserGym 会给所有元素编号，为了 BW-14 的对照，建议也编号。
- OOPIF 要在它自己的 target（类型为 `other`）上开 CDP 会话，单独取快照和可访问性树，2 个节点全部能对上。Puppeteer 25 没有公开 OOPIF 判断和 frame 级 CDP 会话的接口，要通过 `browser.targets()` 找到对应的 target。

### 1.3 编号绑定具体节点（FR-06）——关键发现

| 重绘方式 | 按属性查找 | 按 backendNodeId 查找 |
|---|---|---|
| `outerHTML` 整块重写（新节点带着旧属性） | **命中新节点（会误操作）** | 判定失效 ✓ |
| 用新节点替换 | 找不到 ✓ | 判定失效 ✓ |

**对 M1 的要求**：

- 权威记录是一张编号表：编号 → (frame/会话, backendNodeId)。元素属性只用于让各视图的编号对齐。
- 执行动作时，按 backendNodeId 解析节点并检查 `isConnected`，失效就报 `stale_ref`。
- 观察时，如果某个元素带着编号属性、但它的 backendNodeId 不在编号表里（说明是克隆出来的），要给它分配新编号并覆盖属性，保证编号不复用。

### 1.4 性能（为 observe 设计提供依据）

| 场景 | 写编号 | DOMSnapshot | 全量可访问性树 | 只取视口内元素 |
|---|---|---|---|---|
| 1 万个可交互元素 | 83–200 ms | 375 ms | **2.9 s** | 扫描 24 ms + 36 次 `getPartialAXTree` 41 ms |
| 4 万个可交互元素 | 674 ms | 1.2 s | **11.7 s** | 扫描 168 ms + 53 ms |

**对 M1 的要求**：

- observe 默认只对视口内（及附近）的元素取可访问性信息。
- 全量可访问性树只在请求 `axtree` 视图时才取，并受字符预算限制。
- 大表数据走页面抽取或接口截获（FR-09、FR-10），不走 observe。

## 2. MV3 扩展加载

脚本：`node spikes/extension/load.ts`（有头：`HEADED=1 xvfb-run -a node spikes/extension/load.ts`）

| 方式 | 结果 |
|---|---|
| A：`--load-extension` + `--disable-extensions-except`，开调试端口 | ✓ 加载成功；侧边栏页面连上本机 WebSocket；扩展建标签组成功；外部进程能连上同一浏览器 |
| B：Puppeteer `enableExtensions: [路径]`，WebSocket 连接 | ✗ `Extensions.loadUnpacked: Method not available`，且 Puppeteer 在这里会产生未处理的 Promise 拒绝 |
| C：pipe 连接 + 调试端口 + `enableExtensions` | ✗ 同上 |
| D：pipe 连接 + 调试端口 + `--enable-unsafe-extension-debugging` + `installExtension` | ✗ 同上 |
| E：只用 pipe（不开调试端口）+ `--enable-unsafe-extension-debugging` + `installExtension` | ✓ 能加载，但没有调试端口，任务子进程无法直接连接 |

**结论：采用方式 A。**

- 品牌版 Chrome 137 起已经移除 `--load-extension`。PRD 已定用 Chrome for Testing 固定版本，需要在开发机上用那个版本确认 A 仍然可用。
- 如果 A 在 CfT 上不可用，有两条退路：
  1. 方式 E：服务持有 pipe 连接，为任务子进程代理 CDP。
  2. 侧边栏降级为服务提供的本地网页。FR-29 是 P1，不阻塞主线。

**其他发现**：

- Puppeteer 的 `target.worker().evaluate()` 在扩展的 service worker 上会挂起，连 `1+1` 都超时。改为对该 target 直接 `createCDPSession()`，再调 `Runtime.evaluate`（带 `awaitPromise`），就正常了。服务就用这个方式调用扩展建标签组（FR-03）。
- 侧边栏连接时，WebSocket 的 Origin 是 `chrome-extension://<扩展 ID>`。建议在 manifest 里写 `key` 固定扩展 ID，服务只接受这个 Origin 的连接，防止本机其他网页连上服务。
- `chrome.sidePanel.open()` 需要用户手势。设置 `setPanelBehavior({ openPanelOnActionClick: true })` 后，用户点一次工具栏图标就能打开侧边栏。这一点无头模式下无法验证，预研里把侧边栏页面放在标签页中打开来测试连接。

## 3. MiniWoB++ 与 BrowserGym

脚本：

- `spikes/miniwob/fetch.sh`：下载并解出任务页
- `node spikes/miniwob/run.ts`：运行任务
- `spikes/.cache/venv-bg/bin/python spikes/miniwob/browsergym_extract.py URL --miniwob-seed N`：导出 BrowserGym 提取结果

### 3.1 MiniWoB++（BW-13）

- 发布包 `miniwob==1.1.0`（MIT 许可）里带有全部任务页，都是静态 HTML 和 JS，共 130 个文件。本地静态托管即可运行，不需要它的 Python 或 Selenium 环境。
- 运行协议（从它的 Python 环境里读出来）：
  1. 打开 `miniwob/<任务>.html`
  2. `Math.seedrandom(seed)`
  3. 点击 `#sync-task-cover`（START）
  4. `core.getUtterance()` 读取指令
  5. 执行操作
  6. 读取 `WOB_DONE_GLOBAL`、`WOB_RAW_REWARD_GLOBAL`、`WOB_REWARD_GLOBAL`（含时间折扣）和 `WOB_REWARD_REASON`

  每个回合默认限时 10 秒。
- 实测：click-button、enter-text、click-checkboxes 各跑 5 个种子，都用“编号 + Puppeteer 可信输入”完成，原始奖励全部为 1（15/15）。

### 3.2 BrowserGym 提取（BW-14 基线）

- `browsergym-core` 0.14.3（Apache-2.0）锁定 `playwright==1.44`，与本机的 Chromium 141 不匹配。改为用 `--no-deps` 安装它，并换用 `playwright==1.56.0` 后，它的提取函数可以正常使用：`_pre_extract`、`extract_dom_snapshot`、`extract_merged_axtree`、`extract_dom_extra_properties`。
- `browsergym_extract.py` 按行输出 `{bid, role, name, clickable, visibility, bbox}`，作为 BW-14 的对照基线。BrowserGym 写的是 `bid` 属性，与 Obact 的 `data-obact-ref` 互不冲突。
- BrowserGym 放在单独的虚拟环境里，不进入 `obact` 包的依赖。

**对 M1 的影响**：

- BW-13、BW-14 的驱动全部放在 Node 侧。
- Python 只用来导出 BrowserGym 基线。
- M1 要做一个比对脚本：同一页面分别用 Obact 和 BrowserGym 提取，按角色和名称逐条对齐。

## 4. 在开发机上用 CfT 复跑（可选）

```bash
npx @puppeteer/browsers install chrome@<固定版本>   # 记下输出的可执行文件路径
export CHROME_PATH=<上一步的路径>
node spikes/browser/service.ts
node spikes/extension/load.ts
spikes/miniwob/fetch.sh && node spikes/miniwob/run.ts
```

选定的版本号记入 `docs/DEV_PLAN.md` 第 3 节的技术基线。

## 5. Chrome for Testing 141.0.7390.122 复核结果（CI `spikes-cft`）

| 项目 | 结果 |
|---|---|
| 扩展加载方式 A（`--load-extension`），无头 | ✓ 加载；侧边栏页面连上本机 WebSocket（Origin 为扩展）；标签组建立；外部进程能连上浏览器 |
| 扩展加载方式 A，有头（Xvfb） | ✓ 同上 |
| 方式 B、C、D | ✗ `Extensions.loadUnpacked: Method not available`（与本机一致） |
| 方式 E（只用 pipe） | ✓ 能加载，但没有调试端口（与本机一致） |
| 进程模型 | ✓ 子进程被杀后浏览器和页面不受影响、新进程接管、重启后登录态保留 |
| 编号 | ✓ 与本机一致（15 个编号、OOPIF 2/2、克隆重绘判定失效） |
| 性能（1 万个可交互元素） | 写编号 69 ms、DOMSnapshot 137 ms、全量可访问性树 1.1 s、视口内 40 个元素的可访问性信息 12 ms |
| 运行用户 | GitHub runner 为非 root，开启沙箱运行（Ubuntu 24.04 需放开 `apparmor_restrict_unprivileged_userns`） |

结论：**扩展加载风险关闭**，采用方式 A。CI 固定使用 CfT 141.0.7390.122（`.github/workflows/ci.yml` 的 `CFT_VERSION`），与本机预装的 Chromium 141 同一大版本。
