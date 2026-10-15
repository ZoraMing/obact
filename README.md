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
| `packages/core/` | 观察与执行内核：浏览器启动、标签页、编号、定位器、`observe`、`act`、断言 |
| `python/` | Python 包 `obact`（目前只有契约校验） |
| `bench/` | 对照与基准：BW-14 组件识别对照、MiniWoB++ 任务 |
| `spikes/` | M0 预研脚本 |

后续模块（server、workflow、recorder、extension、lab、fixtures）按开发计划第 3 节在各里程碑加入。

## 试用 observe / act

服务与统一接口在 M4 提供，目前可以直接调用 `packages/core` 的库，或用交互脚本试：

```bash
CHROME_PATH=/path/to/chrome node packages/core/examples/try.ts https://example.com
```

脚本先打印页面的两部分：

- **可操作功能**：每行一个元素，`[编号] 角色 "名称" 状态 → 可用操作`，例如 `[3] textbox "账号" value="" type=text → click,fill,type_text,press_key`；下拉框还会列出选项。
- **纯网页信息**：页面上不可操作的文字，整理成 Markdown（标题、段落、表格），表格里的按钮用 `[编号]` 引用。

然后每行输入一个动作（JSON，格式见 `packages/schemas/schemas/action.json`，`pageId` 可省略），执行后打印结果并重新观察：

```text
{"op":"fill","target":{"ref":3},"value":"alice"}
{"op":"click","target":{"role":"button","name":"登录"}}
{"op":"press_key","key":"Enter"}
o    重新观察
q    退出
```

`HEADED=1` 时有头运行，可以看着浏览器操作。

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
