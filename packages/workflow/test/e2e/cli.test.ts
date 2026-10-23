// 命令行层验收：真的 `node cli.ts run / resume`（监督进程 + 运行子进程 + 浏览器），订单审核走 Lab。
// 判据：退出码、stderr 提示、Lab 服务端的提交次数、运行产物，以及有没有遗留 Chrome。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import orders from '../../../../lab/src/modules/orders.ts';
import { control, SKIP } from '../../../../lab/test/helpers.ts';
import { RunStore } from '../../src/store.ts';
import { browserRec, cli, leftovers, until } from './cli-helpers.ts';
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

  test('外部 SIGKILL 运行子进程：监督进程拉起并续跑，退出码 0 / DONE，服务端恰好一次提交，没有遗留 Chrome', async () => {
    const ids = await pendingOrders(lab, 'cli-kill', 1000, 6);
    const ws = auditWorkspace(lab, 'cli-kill', ids);
    // 每条订单开头等 0.6 秒（等不到即跳过）：外部杀进程的时刻必然落在提交之外，用例才不会时灵时不灵
    const file = join(ws, 'workflows', NAME, 'steps.jsonl');
    const hold =
      '{"step_id":"hold","op":"wait_for","pageId":"main","until":[{"text_present":"~"}],"timeout_ms":600,"on_fail":"skip"}';
    writeFileSync(file, readFileSync(file, 'utf8').replace('{"step_id":"detail"', `${hold}\n$&`));
    assert.match(readFileSync(file, 'utf8'), /"step_id":"hold"/);
    const run = cli(ws, ['run', NAME, '--run-id', 'r']);
    const store = new RunStore(ws, 'r');
    const rec = await until('第 3 条订单开始', () => {
      return store.readCheckpoint()?.loop_index?.loop === 2 && browserRec(ws);
    });
    process.kill(rec.owner, 'SIGKILL');
    const end = await run.done;
    assert.equal(end.code, 0, end.err);
    assert.match(end.err, /子进程崩溃（signal），第 1 次重启并续跑/);
    assert.equal(store.readCheckpoint()?.state, 'DONE');
    const { done, unv } = reconcile(ws, 'r', await serverView(lab, 'cli-kill'));
    assert.deepEqual([done, unv], [ids, []]);
    assert.equal(leftovers(ws), '', '没有遗留 Chrome');
  });

  test('提交超时：命令行退出码 3（STOPPED），obact unverified 列出待核实条目，stderr 提示可 resume', async () => {
    const ids = await pendingOrders(lab, 'cli-stop', 1000, 3);
    const ws = auditWorkspace(lab, 'cli-stop', ids);
    await control(lab, 'cli-stop').faults({ commit_timeout: true });
    const end = await cli(ws, ['run', NAME, '--run-id', 'r']).done;
    assert.equal(end.code, 3, end.err);
    assert.match(end.err, /可 obact resume r 续跑/);
    const list = await cli(ws, ['unverified', 'r']).done;
    assert.match(list.out, new RegExp(`^audit:${ids[0]}\\tapprove\\tpost_failed\\t\\S+\\t未核实`));
    assert.equal(
      (await serverView(lab, 'cli-stop')).hits.get(ids[0] as string),
      1,
      '服务端落库一次，没有重试',
    );
  });
});
