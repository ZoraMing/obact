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
| `POST /s/<空间>/_lab/reset` | 重置为初始数据，清空会话、提交记录和故障开关；可传 `{"seed": 数字}` 换种子 |
| `GET /s/<空间>/_lab/state` | 状态查询：故障开关、会话、按幂等键汇总的提交记录、事件日志、各模块的状态（评分点判定和对账用） |
| `POST /s/<空间>/_lab/faults` | 设置故障开关（给哪项改哪项），返回当前开关 |

## 故障注入

| 开关 | 含义 |
|---|---|
| `delay_ms` | 所有 `/api/` 接口延迟 |
| `error_rate` | 偶发 500 的比例（0~1） |
| `drop_rate` | 丢弃响应（直接断开连接）的比例 |
| `commit_timeout` | 提交超时但已落库：写接口照常执行并记录，然后不返回响应 |
| `session_ttl_ms` | 会话有效期；过期后访问需要登录的页面被跳到登录页 |
| `redesign` | 改版变体：0 为原版，1 起为各模块定义的改版（改 id、改文案、改层级） |
| `popup_rate` | 随机弹窗：每个页面加载按此概率弹出广告层（按空间的随机序列，结果可复现） |

写接口用幂等键记录每一次提交（页面生成键，状态未明后重试沿用同一个键）；`state.submissions[].count` 大于 1 就是重复提交。

## 模块

| 模块 | 页面 | 覆盖 |
|---|---|---|
| `auth` 登录与账号 | `/login`、`/verify`（人机验证页）、`/account`；账号 alice / bob / carol / dave，carol 连续 3 次密码错误锁定，dave 每次登录都要过验证 | FR-02、FR-08、FR-20、FR-22；登录页 4 种改版 |
| `orders` 订单后台 | `/orders`（200 条订单，筛选、排序、翻页都不改 URL）、`/orders/:id`；批量审核（confirm → 带幂等键提交）、CSV 导出 | FR-07、FR-09、FR-16~FR-19、FR-25；列表 4 种改版 |
| `structure` 复杂结构 | `/structure`：同源与跨域 iframe、嵌套 frame、开放与封闭 Shadow DOM、新标签页、同名“查看”、动态 id 与哈希类名；`/structure/library`：Shoelace 组件库实现的差旅申请 | FR-04、FR-06、FR-07 |
| `noise` 干扰层 | `/noise`：Cookie 提示条、1.5 秒透明遮挡层、布局偏移；`/noise/entry-ad`：每次都弹的 Entry Ad；`popup_rate` 让任意页面随机弹广告 | FR-13、FR-23 |

后续模块（消息中心、申请向导、看板与画布、实时面板、大表与数据、文件区、设置页）按开发计划在 M2、M5 加入。

## 写新模块

在 `lab/src/modules/<名字>.ts` 默认导出 `LabModule`（见 `src/core.ts`）：`init` 初始化数据（用 `space.rng()` 取随机数）、`routes` 注册路由（`{auth: true}` 需要登录，`{commit: true}` 的写接口受 `commit_timeout` 影响并用 `ctx.record` 记幂等键）、`state` 给状态查询、`shell` 在每个页面末尾追加内容（如干扰层）。页面用 `page()` 外壳，导航自动包含全部模块。测试放 `lab/test/`，每个测试用不同的空间名。
