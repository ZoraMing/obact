# 本地夹具库（PRD 9.3）

每个夹具是一个本地页面，结果完全确定（需要“随机”的由 URL 参数 `seed` 决定）。只保留当前验收用得上的部分，其余场景由 `packages/core/test` 和 `lab/` 覆盖。

```bash
node fixtures/server.ts            # http://127.0.0.1:8710/<夹具名>/，跨域站点 http://localhost:8710/
node --test fixtures/test/*.test.ts
```

| 夹具 | 内容 | 覆盖 |
|---|---|---|
| `timing` | 动画按钮、布局偏移、延迟渲染、骨架屏、进度条 | FR-13、FR-14、BW-3 |
| `fast-response` | 点击后约 20 毫秒返回的接口 | FR-10、BW-3 |
| `stale-refs` | 观察之后整块重绘的列表 | FR-06、BW-6 |
| `redesign` | 同一页面的原版与 6 个改版（改 id、改文案、改层级、移动位置、id 挪用、全面改版） | FR-07、FR-20、BW-6 |
| `overlays` | 透明层、透明引导层、Cookie 提示条、按 seed 弹出的广告层 | FR-13、FR-23、BW-7 |
| `virtual-table` | 1 万行虚拟滚动表格，只渲染可见行；对应 JSON 接口 | FR-09、FR-10 |
| `forms-files` | 账号表单（密码框）、上传（含自绘上传按钮、中文文件名）、下载（UTF-8 BOM、中文文件名） | FR-35 |
| `formatted-numbers` | 页面显示千分位、“1.2万”，接口返回原值（`packages/workflow/test/extract.test.ts` 依赖） | FR-09、FR-10 |
| `polling` | 每秒轮询接口 + WebSocket 定时推送，网络永不空闲（`packages/core/test/network.test.ts` 依赖） | FR-14 |
| `structure` | 开放 / 封闭 Shadow DOM、同源 / 跨域 / 嵌套 iframe、新标签页 | FR-04、FR-05 |
| `canvas` | 大面积 Canvas 柱状图，点击柱子记日志 | FR-11、FR-32、BW-12 |

页面在 `pages/<夹具名>/`，接口在 `api/<夹具名>.ts`（启动时自动加载，路径以 `/api/<夹具名>/` 开头），测试在 `test/`。`test/server.test.ts` 测夹具服务本身：畸形请求回 400 而不是让进程退出，静态路径不能逃出 `pages/`，不需要浏览器。`test/helpers.ts` 是各浏览器测试共用的环境（`setup`、`run`、`ok`），`packages/` 下的测试也用它。
