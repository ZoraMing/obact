# 本地夹具库（PRD 9.3）

每个夹具是一个本地页面，结果完全确定（需要“随机”的由 URL 参数 `seed` 决定）。

```bash
node fixtures/server.ts            # http://127.0.0.1:8710/<夹具名>/，跨域站点 http://localhost:8710/
node --test fixtures/test/*.test.ts
```

| 夹具 | 内容 | 覆盖 | 测试 |
|---|---|---|---|
| `dynamic-attrs` | 每次加载 id 与哈希类名都变；订单表每行同名的“编辑”“删除” | FR-06、FR-07 | 4 项通过 |
| `redesign` | 同一页面的原版与多个改版：改 id、改文案、改层级、移动位置等 | FR-07、FR-20、BW-6 | 3 项通过 |
| `structure` | open / closed Shadow DOM、同源与跨域 iframe、嵌套 frame、新标签页 | FR-04、FR-05 | 5 项通过 |
| `overlays` | 透明遮罩、Cookie 提示条、按 seed 定时弹出的广告层 | FR-13、FR-23 | 8 项通过 |
| `timing` | 动画按钮、布局偏移、延迟渲染、骨架屏、进度条 | FR-13、FR-14、BW-3 | 9 项通过 |
| `polling` | 每秒轮询接口 + WebSocket 每 200 毫秒推送 | FR-14 | 5 项通过 |
| `virtual-table` | 1 万行虚拟滚动表格，只渲染可见行；对应 JSON 接口 | FR-09、FR-10 | 4 项通过 |
| `formatted-numbers` | 页面显示千分位、“1.2万”，接口返回原值 | FR-09、FR-10 | 4 项通过 |
| `fast-response` | 点击后约 20 毫秒返回的接口 | FR-10 | 4 项通过 |
| `stale-refs` | 观察之后整块重绘的列表 | FR-06 | 5 项通过 |
| `canvas` | 大面积 Canvas 柱状图，点击柱子记日志 | FR-11、FR-31、FR-32、BW-12 | 3 项通过 |
| `forms-files` | 密码框、对话框、上传、下载（UTF-8 BOM、中文文件名） | FR-12、FR-22、FR-26 | 10 项通过 |

页面在 `pages/<夹具名>/`，接口在 `api/<夹具名>.ts`（启动时自动加载，路径以 `/api/<夹具名>/` 开头），测试在 `test/`（`test/server.test.ts` 测夹具服务本身：畸形请求回 400 而不是让进程退出，静态路径不能逃出 `pages/`，不需要浏览器）。
