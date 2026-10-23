// 崩溃可续跑（C-1）：订单批量审核过程中 SIGKILL 运行子进程，监督进程以续跑模式拉起，结果必须与不被杀一致。
// 子进程是 e2e/child.ts（按计划在确定的时刻自杀）；判据以 Lab 服务端为准，再与 side_effects / unverified 对账。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import { seeded } from '../../../../lab/src/core.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import orders from '../../../../lab/src/modules/orders.ts';
import { SKIP } from '../../../../lab/test/helpers.ts';
import {
  auditWorkspace,
  cleanup,
  type Kill,
  NAME,
  pendingOrders,
  reconcile,
  serverView,
  supervised,
} from './orders-helpers.ts';

const SEED = Number(process.env.OBACT_E2E_SEED ?? 20261023); // 失败后用同一个种子复现

describe('崩溃续跑', { skip: SKIP, timeout: 300_000 }, () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
    cleanup();
  });

  /** 在监督进程下跑审核工作流（前 n 条待审核订单），子进程按 kills 自杀；返回检查点状态与对账结果。 */
  async function killRun(space: string, n: number, kills: Kill[], skip = false) {
    const ids = await pendingOrders(lab, space, 1000, n);
    const ws = auditWorkspace(lab, space, ids);
    const state = await supervised(ws, NAME, kills, skip);
    const view = await serverView(lab, space);
    return { ids, state, view, ...reconcile(ws, 'r', view) };
  }

  /** 被杀后续跑，结果必须与不被杀一模一样：全部完成、没有待核实、服务端按原顺序每条审核一次。 */
  async function sameAsUnkilled(space: string, n: number, kills: Kill[]) {
    const { ids, state, view, done, unv } = await killRun(space, n, kills);
    assert.equal(state, 'DONE');
    assert.deepEqual(done, ids);
    assert.deepEqual(unv, []);
    assert.deepEqual(view.changed, ids, '服务端按原顺序每条审核一次，没有遗漏');
  }

  test(`C-1 随机时刻两次 SIGKILL（种子 ${SEED}）：续跑后与不被杀一致，服务端每条恰好一次、无遗漏`, async (t) => {
    // 随机点只取“安全”的时刻（订单审核提交之外）：重做被打断的那一条，结果应当与没被杀一模一样
    const rnd = seeded(SEED);
    const pick = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const at = () => ['before:ask', 'before:approve', 'after:approve'][pick(0, 2)] as string;
    const kills = [
      { at: at(), nth: pick(3, 15) },
      { at: at(), nth: pick(3, 12) },
    ];
    t.diagnostic(`击杀点：${JSON.stringify(kills)}`);
    await sameAsUnkilled('kill-random', 40, kills);
  });

  // 随机种子不一定三种时刻都抽到（当前种子只抽到 ask 之前和 approve 之后），所以三个候选点再各固定杀一次：
  // 点“审核通过”弹出确认框、还没点确认时被杀，也要与不被杀一致
  test('C-1 三个安全击杀点各固定杀一次：ask 之前、确认框打开时（approve 之前）、approve 之后', async () => {
    await sameAsUnkilled('kill-fixed', 20, [
      { at: 'before:ask', nth: 3 },
      { at: 'before:approve', nth: 3 },
      { at: 'after:approve', nth: 3 },
    ]);
  });

  // 崩在 once_only 步骤中间的三个时刻（第 12 条）：[说明, 击杀点, 跳过模式, 服务端该条提交数, 待核实条数]
  const mid: [string, string, boolean, number, number][] = [
    ['动作发出前', 'unsent', true, 0, 1],
    ['动作发出且生效后、side effect 写入前', 'sent', false, 1, 1],
    ['side effect 写入后、检查点推进前', 'recorded', false, 1, 0],
  ];
  for (const [name, at, skip, hits, pending] of mid) {
    test(`C-1 崩在单次提交中间：${name}`, async () => {
      const { ids, state, view, done, unv } = await killRun(
        `kill-${at}`,
        30,
        [{ at, nth: 12 }],
        skip,
      );
      const hit = ids[11] as string;
      // 保守原则：检查点停在单次提交上又没有 side effect，一律按状态未明（crash）；有 side effect 的认作已完成
      assert.deepEqual(unv, pending ? [hit] : []);
      assert.equal(view.hits.get(hit) ?? 0, hits, '该条的服务端提交次数（续跑不会补发）');
      const through = skip || !pending ? 30 : 12; // 默认 stop：状态未明那条之后的订单不动
      assert.deepEqual(
        done,
        ids.slice(0, through).filter((id) => !pending || id !== hit),
      );
      assert.equal(state, skip || !pending ? 'DONE' : 'STOPPED');
      assert.equal(view.hits.size, through - (hits ? 0 : 1));
    });
  }
});
