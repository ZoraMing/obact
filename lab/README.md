# Obact Lab（测试应用）

自己用 Node 编写、只在本地运行的 Web 应用（PRD 9.3），承担公开网站做不到的测试：写操作对账、故障注入、浸泡和长程任务集。每个模块把原子控件嵌进业务流程，让任务由多个原子操作串起来。

```bash
node lab/server.ts [--port 8700]     # 打开 http://127.0.0.1:8700/s/default/
node --test "lab/test/**/*.test.ts"
```

## 数据空间

所有页面和接口都在 `/s/<空间名>/` 下。每个空间有独立的数据、会话、提交记录和故障开关，首次访问时按种子初始化；多个运行用不同的空间名即可并行。会话 cookie 的 Path 限定在空间内，空间之间不串登录态。同一服务有两个站点：`127.0.0.1` 和 `localhost`，用来构造跨域 iframe。

## 三个控制接口

不受故障注入影响，不需要登录。

| 接口 | 作用 |
|---|---|
| `POST /s/<空间>/_lab/reset` | 重置为初始数据，清空会话、提交记录和故障开关；可传 `{"seed": 整数}` 换种子；订单后台还接受 `{"orders": 1~2000}` 改订单数量（默认 200 条，约 62% 待审核；BW-9 逐条审核 500 条时用 1000），大表还接受 `{"rows": 1~20000}` 改行数（默认 1000） |
| `GET /s/<空间>/_lab/state` | 状态查询：种子与重置参数、故障开关、会话、按幂等键汇总的提交记录、事件日志（最近 500 条）、各模块的状态（评分点判定和对账用） |
| `POST /s/<空间>/_lab/faults` | 设置故障开关（给哪项改哪项），返回当前开关 |

控制接口的请求体可以是 JSON 或表单，会校验：必须是对象，只认下表里的开关名（`reset` 只认 `seed` 和模块声明的参数，目前是订单后台的 `orders` 和大表的 `rows`），值按类型转换（表单里的 `0.5`、`true`、`null` 会变成数字、布尔、null）；未知键、非法值、非对象体返回 400 并说明原因，一项都不会生效。所有请求体上限 1 MiB，超过返回 413。

只绑定 127.0.0.1，并且只接受 `Host` 为 `127.0.0.1:端口` 或 `localhost:端口` 的请求（其余回 403，挡住 DNS 重绑定）；浏览器里别的网站发来的 POST 控制请求（`Sec-Fetch-Site` 为 `cross-site` 或 `same-site`）回 403。服务端出错只回“内部错误”，堆栈写到服务的日志（stderr）。

## 故障注入

| 开关 | 含义 |
|---|---|
| `delay_ms` | 所有 `/api/` 接口延迟 |
| `error_rate` | 偶发 500 的比例（0~1） |
| `drop_rate` | 丢弃响应（直接断开连接）的比例；`commit` 写接口先照常执行并落库再断开（客户端只看到连接重置，状态未明），读接口直接断开 |
| `commit_timeout` | 提交超时但已落库：写接口照常执行并记录，然后不返回响应 |
| `session_ttl_ms` | 会话有效期；过期后访问需要登录的页面被跳到登录页 |
| `redesign` | 改版变体：0 为原版，1 起为各模块定义的改版（改 id、改文案、改层级）。目前 auth 登录页和 orders 列表各有 1~4，structure、noise、bigtable、servers 没有改版（设了也没有变化） |
| `redesign_after_requests`、`redesign_after_ms`、`redesign_to` | 定时改版（PRD 的“运行中途改版”），默认关闭。设置 `redesign_after_requests: N` 后，之后的 N 个模块请求（页面和 `/api/` 都算，控制接口不算）仍是旧版，第 N+1 个请求起 `redesign` 切到 `redesign_to`（默认 1）；`redesign_after_ms: T` 是从设置起 T 毫秒后的下一个请求切。两个谁先到谁生效，只切一次，切换记入事件日志（`redesign_switch`）；设为 `null` 取消 |
| `popup_rate` | 随机弹窗：每个页面加载按此概率弹出广告层（按空间的随机序列，结果可复现） |

写接口用幂等键记录每一次提交（页面生成键，状态未明后重试沿用同一个键）；`state.submissions[].count` 大于 1 就是重复提交；`payload` 始终是首次提交的内容，同一个键后来带了不同操作或载荷时 `conflict` 为 true（服务端仍只按首次处理）。

## 模块

| 模块 | 页面 | 覆盖 |
|---|---|---|
| `auth` 登录与账号 | `/login`、`/verify`（人机验证页）、`/account`；账号 alice / bob / carol / dave，carol 连续 3 次密码错误锁定，dave 每次登录都要过验证 | FR-02、FR-08、FR-20、FR-22；登录页 4 种改版 |
| `orders` 订单后台 | `/orders`（默认 200 条订单，数量可由 reset 改；筛选、排序、翻页都不改 URL）、`/orders/:id`；批量审核（confirm → 带幂等键提交）、CSV 导出 | FR-07、FR-09、FR-16~FR-19、FR-25；列表 4 种改版 |
| `bigtable` 大表与数据 | `/table`：`/table/paged`（分页表格，每页 20 行，名称是 `/table/item/:id` 详情链接）、`/table/virtual`（虚拟滚动，滚动容器 `#viewport`、行 `.row[data-id]`）、`/table/scroll`（无限滚动，容器 `#list`，每次 10 行）；三者与 `GET /api/rows`（`page&size` 或 `offset&limit`，响应 `{rows, total}`）是同一份数据，由种子决定 | FR-09、FR-10；BW-1、BW-2、BW-10 |
| `servers` 服务器管理 | `/servers`、`/servers/:id/edit`（表单 `#name`、`#cpu`、`#memory_limit`、`#note`，提交 `#save`，成功显示“已保存”；“参数说明”链接新标签页打开）、`/servers/docs/params`（`dl#params`，memory_limit 的值由种子决定）；`POST /api/servers/:id` 带幂等键提交，`state` 里有每台服务器的当前值和文档页的值 | FR-37；BW-15 |
| `structure` 复杂结构 | `/structure`：同源与跨域 iframe、嵌套 frame、开放与封闭 Shadow DOM、新标签页（链接与 `window.open`）、同名“查看”、每次加载都变的 id 与哈希类名；`/structure/library`：Shoelace 组件库实现的差旅申请 | FR-04、FR-06、FR-07 |
| `noise` 干扰层 | 只有广告弹窗（全屏遮罩 + 对话框）一种：`/noise` 说明页，`/noise/entry-ad` 每次加载都弹的 Entry Ad，`popup_rate` 让任意页面随机弹广告；Cookie 提示条、透明遮挡层、布局偏移由 `fixtures/` 覆盖 | FR-13、FR-23 |

后续模块按开发计划加入：文件区已不排期（FR-35 由单测覆盖），消息中心、申请向导、看板与画布、实时面板在 M5。设置页（PRD 9.3 列了它，覆盖 FR-12 的 alert / confirm / prompt）还没排进任何里程碑，目前由 `forms-files` 夹具顶替。

## 写新模块

在 `lab/src/modules/<名字>.ts` 默认导出 `LabModule`（见 `src/core.ts`）：`init` 初始化数据（用 `space.rng()` 取随机数；要让重置时可调数量就声明 `resetOptions`，值在 `space.options`，见订单后台的 `orders`）、`routes` 注册路由（`{auth: true}` 需要登录，`{commit: true}` 的写接口受 `commit_timeout` 影响并用 `ctx.record` 记幂等键；故障注入只作用于 `/api/` 下的路径，所以 commit 路由必须以 `/api/` 开头，否则注册时报错）、`state` 给状态查询、`shell` 在每个页面末尾追加内容（如干扰层）。页面用 `page()` 外壳，导航自动包含全部模块。测试放 `lab/test/`，每个测试用不同的空间名。
