# @obact/schemas：数据契约

PRD 第 7 节的结构在这里用 JSON Schema（2020-12）冻结。各模块只通过这些结构交互（开发计划第 6 节）。TS 端和 Python 端都从同一批 Schema 文件读取。

## 文件

| 文件 | 内容 | PRD |
|---|---|---|
| `common.json` | 共用类型：PageId、编号、坐标、包围盒、定位器、目标、检查项、错误码、视口 | 3、7.7 |
| `observe.json` | observe 的参数与返回 | 7.2、FR-05、FR-31 |
| `action.json` | act 的参数：一个动作，共 21 种 op（含坐标动作） | 7.7、FR-12、FR-32 |
| `act-result.json` | act 的返回 | 7.3、FR-15 |
| `act-batch.json` | act_batch 的参数与返回 | FR-33 |
| `step.json` | 工作流 steps.jsonl 的一行：动作 + 步骤字段，或控制流步骤 | 7.4、FR-16 |
| `checkpoint.json` | runs/<run_id>/checkpoint.json；运行状态枚举 | 7.5、FR-17 |
| `unverified.json` / `side-effect.json` | 待核实清单 / 已确认的单次提交记录 | 7.5、FR-18 |
| `trajectory.json` | 轨迹文件的一行 | FR-26 |
| `events.json` | 推送事件 step、need_human、ask_save、unverified、run_done | 7.1 |
| `methods.json` | 其他方法的参数与返回 | 7.1 |
| `rpc.json` | JSON-RPC 2.0 请求、响应、通知；`Call.<方法>` 给出每个方法的参数，`x-result` 标注它的返回结构 | 7.1、8.2 |
| `workflow.json` / `signatures.json` / `rules.json` | 工作流目录里的 workflow.json、signatures.json、rules.json | 7.6、FR-08、FR-23 |
| `params.json` | params.yaml 的结构 | FR-22 |
| `task.json` | 任务集的任务：初始化 + 指令 + 评分点 | 5.8、FR-36 |

## 相对 PRD 第 7 节的补充

以下几处 PRD 没有写明，冻结时补上了，评审时请重点看：

1. **新增 `human.reply` 方法**：终端或接口调用方用它回答 need_human 和 ask_save，补全人工接管的闭环（FR-21、FR-34）。
2. **工作流中的目标只能用定位器**：`step.json` 拒绝 `{"ref": …}`，因为编号只在会话内有效（FR-06、FR-07）。
3. **pageId 规则**：除 `new_page` 和控制流步骤外，所有动作都必须带 pageId（FR-04）。
4. **ask_human 与人工接管共用通道**：need_human 的 reason 增加 `question` 和 `infeasible` 两个值（FR-34）。
5. **运行状态**：RUNNING、PAUSED、NEED_HUMAN、SUSPENDED（为切换有头/无头而挂起）、STOPPED、FAILED、TRIPPED（熔断）、DONE。
6. **act 返回增加 `action_seq`**：接口缓存用它判断响应是在哪个动作之后到达的（PRD 5.6）。
7. **轨迹记录增加 `source`**：区分工作流回放、人工接管和外部调用（以后的模型）。
8. **评分点字段名用 `scoring`**：与续跑用的检查点（checkpoint）区分开。

## 用法

```ts
import { Contracts, methodTable } from '@obact/schemas';
const contracts = new Contracts();
contracts.assert('observe.Result', data); // 也可写 'observe.json#/$defs/Result'
```

```python
from obact.contracts import default_contracts
default_contracts().check("action", data)
```

## 修改流程

1. 修改 `schemas/*.json`。
2. 在 `examples/<目标>/` 下补充 `valid-*.json` 和 `invalid-*.json` 样例；`.jsonl` 文件会逐行校验。
3. 运行 `npm run gen:types`，重新生成 `src/types.ts`。
4. 运行 `npm run check` 和 `pytest python`。两端用同一批样例，判定必须一致。

冻结后，删除字段、收紧约束这类破坏性改动需要先评审。
