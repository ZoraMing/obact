# Obact

Obact（暂定名）：本地运行、跨平台的浏览器识别与操作工具。把网页整理成可选择的操作和页面内容，按 JSONL 工作流带检查、可续跑地执行。第一阶段不接入 AI，目标是给以后的 AI 提供可靠的“眼睛和手”。

## 文档

- [PRD v1.5](docs/PRD.md)：第一阶段需求基线
- [开发计划](docs/DEV_PLAN.md)：里程碑、任务拆分、测试矩阵、并行开发规则
- [M0 预研结论](docs/spikes/M0-spikes.md)
- [数据契约](packages/schemas/README.md)

## 目录

| 目录 | 内容 |
|---|---|
| `packages/schemas/` | JSON Schema 数据契约、生成的 TS 类型、契约样例 |
| `python/` | Python 包 `obact`（目前只有契约校验） |
| `spikes/` | M0 预研脚本 |

后续模块（core、server、workflow、recorder、extension、lab、fixtures）按开发计划第 3 节在各里程碑加入。

## 开发

需要 Node ≥ 22.18（直接运行 `.ts`）和 Python ≥ 3.11。

```bash
npm install
npm run check            # lint、类型检查、生成类型一致性、契约测试

python3 -m venv .venv
.venv/bin/pip install -e "python[dev]"
.venv/bin/pytest python  # 与 TS 端共用同一批契约样例
```

修改 Schema 后运行 `npm run gen:types`。预研脚本的用法见 [M0 预研结论](docs/spikes/M0-spikes.md)；需要本机 Chrome 时用 `CHROME_PATH` 指定。
