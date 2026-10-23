// 命令行层验收：真的 `node cli.ts run / resume`（监督进程 + 运行子进程 + 浏览器），订单审核走 Lab。
// 判据：退出码、stderr 提示、Lab 服务端的提交次数、运行产物，以及有没有遗留 Chrome。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import orders from '../../../../lab/src/modules/orders.ts';
import { SKIP } from '../../../../lab/test/helpers.ts';
import { RunStore } from '../../src/store.ts';
import { browserRec, cli, until } from './cli-helpers.ts';
import {
  auditWorkspace,
  cleanup,
  NAME,
  pendingOrders,
  reconcile,
  serverView,
} from './orders-helpers.ts';

describe('命令行层', { skip: SKIP, timeout: 300_000 }, () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
    cleanup();
  });

  test('同一 run-id 并发的第二个 resume 被运行锁拒绝（退出码 6）、同一账号的另一个运行被账号锁拒绝，第一个运行的 Chrome 不受影响', async () => {
    const ws = auditWorkspace(lab, 'cli-lock', await pendingOrders(lab, 'cli-lock', 1000, 12));
    const first = cli(ws, ['run', NAME, '--run-id', 'r']);
    const store = new RunStore(ws, 'r');
    const chrome = await until(
      '第一个运行起好浏览器',
      () => store.readCheckpoint() !== null && browserRec(ws),
    );
    const second = await cli(ws, ['resume', 'r']).done;
    assert.equal(second.code, 6, second.err);
    assert.match(second.err, /运行 r 已被进程 \d+ 占用/);
    const other = await cli(ws, ['run', NAME, '--run-id', 's']).done; // 同一账号的另一个运行
    assert.equal(other.code, 1);
    assert.match(other.err, /账号 default 已被进程 \d+ 占用/);
    assert.doesNotMatch(other.err, /子进程崩溃/, '确定性的错误不进重启循环');
    process.kill(chrome.pid, 0); // 还活着（不抛异常）
    const end = await first.done;
    assert.equal(end.code, 0, end.err);
    assert.equal(store.readCheckpoint()?.state, 'DONE');
    reconcile(ws, 'r', await serverView(lab, 'cli-lock'));
  });
});
