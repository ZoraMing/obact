// 批量审核订单的单次提交（BW-9、C-4、C-5）：Lab 订单后台，真浏览器，逐条 once_only 审核。
// 提交超时用 Lab 的 commit_timeout 故障（写接口照常落库但不返回响应），只在指定的第几条审核前打开、之后关闭。
// 判据以 Lab 服务端为准（每个订单收到几次审核请求），再与 side_effects.jsonl / unverified.jsonl 互相对账。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import orders from '../../../../lab/src/modules/orders.ts';
import { CHROME, control, SKIP } from '../../../../lab/test/helpers.ts';
import { runWorkflow } from '../../src/cli.ts';
import { RunStore } from '../../src/store.ts';
import type { Step } from '../../src/types.ts';
import {
  auditWorkspace,
  BATCH,
  cleanup,
  NAME,
  pendingOrders,
  reconcile,
  serverView,
} from './orders-helpers.ts';

describe('订单批量审核：单次提交', { skip: SKIP, timeout: 300_000 }, () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
    cleanup();
  });

  /** 跑一遍审核（前 n 条待审核订单）；timeouts 是要注入提交超时的条目序号（从 1 起）。 */
  async function audit(space: string, n: number, timeouts: number[], skip = false) {
    const ids = await pendingOrders(lab, space, 1000, n);
    const ws = auditWorkspace(lab, space, ids);
    const faults = control(lab, space).faults;
    let seen = 0;
    let on = false;
    const hooks = {
      async beforeStep(s: Step) {
        if (s.step_id !== 'approve') return;
        const want = timeouts.includes(++seen);
        if (want === on) return;
        on = want;
        await faults({ commit_timeout: want });
      },
    };
    // hooks 不在 RunWorkflowOptions 的类型里，但 runWorkflow 会原样交给 run（先放进变量，免得多余属性检查）
    const opts = {
      workspace: ws,
      runId: 'r',
      workflow: NAME,
      chromePath: CHROME,
      ...(skip && { onUnverified: 'skip' as const }),
      hooks,
    };
    const r = await runWorkflow(opts);
    const store = new RunStore(ws, 'r');
    const view = await serverView(lab, space);
    return { r, ws, ids, store, view, faults, ...reconcile(ws, 'r', view) };
  }

  test('C-4 默认 stop：第 7 条提交超时 → 该条状态未明、不重试、运行 STOPPED，服务端恰好一次提交，后面的订单没动', async () => {
    const { r, ws, ids, store, view, faults, done, unv } = await audit('ord-stop', BATCH, [7]);
    assert.deepEqual(
      [r.state, r.error?.code, r.error?.step_id],
      ['STOPPED', 'unverified', 'approve'],
    );
    assert.equal(store.readCheckpoint()?.state, 'STOPPED');
    assert.deepEqual(done, ids.slice(0, 6));
    assert.deepEqual(unv, [ids[6]]);
    assert.match(store.listUnverified()[0]?.reason ?? '', /^post_(failed|timeout)$/);
    assert.deepEqual([...view.hits.keys()], ids.slice(0, 7), '服务端：前 7 条各一次，之后一条未动');
    // 没有核实就续跑：状态未明的那条不会被重做（故障已关，重做会成功，服务端会多出一次请求），运行再次停下
    await faults({ commit_timeout: false });
    const again = await runWorkflow({
      workspace: ws,
      runId: 'r',
      chromePath: CHROME,
      resume: true,
    });
    assert.equal(again.state, 'STOPPED');
    assert.deepEqual([...(await serverView(lab, 'ord-stop')).hits], [...view.hits]);
  });

  test('BW-9 skip：两条提交超时 → 其余照常完成，服务端零重复，待核实清单与“已落库却被标记状态未明”的订单一致', async () => {
    const { r, ids, store, view, done, unv } = await audit('ord-skip', BATCH, [137, 301], true);
    assert.deepEqual([r.state, r.stats.unverified], ['DONE', 2]);
    assert.deepEqual(unv, [ids[136], ids[300]]);
    // 每条状态未明之后都先重置页面（重放前置路径的登录步骤）再处理下一条
    const log = readFileSync(store.stepsLogPath, 'utf8').split('\n');
    assert.equal(log.filter((l) => l.split('\t')[1] === 'login').length, 1 + unv.length);
    assert.equal(done.length, BATCH - 2);
    assert.equal(view.hits.size, BATCH, '全部订单都落库，每条恰好一次');
    assert.deepEqual(
      ids.filter((id) => !done.includes(id)),
      unv,
      '服务端已落库而引擎未确认的订单，正是待核实清单',
    );
  });

  test('C-5 连续两条状态未明即停；中间成功一条则计数清零', async () => {
    // 第 2、4、5 条超时：第 3 条成功把计数清零，所以第 4 条不停；第 4、5 条连续，第 5 条后停止
    const { r, ids, view, done, unv } = await audit('ord-consec', 10, [2, 4, 5], true);
    assert.deepEqual([r.state, r.error?.code, r.stats.unverified], ['STOPPED', 'unverified', 3]);
    assert.deepEqual(done, [ids[0], ids[2]]);
    assert.deepEqual(unv, [ids[1], ids[3], ids[4]]);
    assert.deepEqual([...view.hits.keys()], ids.slice(0, 5), '第 5 条之后没有再提交');
  });
});
