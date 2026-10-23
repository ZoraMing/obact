// 信号处理（评审 M2、M3）：真的 `node cli.ts run`，工作流停在一个长时间的 wait_for 上，从外部发信号。
// 终止信号：运行子进程立即清扫浏览器并退出，运行不能被写成 NEED_HUMAN；连按两次：直接强杀，不留孤儿子进程和 Chrome。
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SKIP } from '../../../../lab/test/helpers.ts';
import { RunStore } from '../../src/store.ts';
import { alive, browserRec, cli, leftovers, until } from './cli-helpers.ts';
import { makeWorkspace } from './collect-helpers.ts';

const HOLD = [
  {
    step_id: 'hold',
    op: 'wait_for',
    pageId: 'main',
    until: [{ text_present: '__never__' }],
    timeout_ms: 120_000,
  },
];

describe('信号', { skip: SKIP, timeout: 120_000 }, () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** 起一个停在 wait_for 上的运行，等浏览器和检查点都出来。 */
  async function start() {
    const ws = makeWorkspace('hold', {}, HOLD);
    dirs.push(ws);
    const run = cli(ws, ['run', 'hold', '--run-id', 'r']);
    const store = new RunStore(ws, 'r');
    const rec = await until(
      '浏览器和检查点',
      () => store.readCheckpoint() !== null && browserRec(ws),
    );
    return { ws, run, rec, store };
  }
  /** 断言失败时别留下进程。 */
  const reap = (pids: number[]) => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`${sig}：子进程立即清扫浏览器并退出，检查点不是 NEED_HUMAN，之后可以续跑`, async () => {
      const { ws, run, rec, store } = await start();
      try {
        const t0 = Date.now();
        run.proc.kill(sig);
        const end = await run.done;
        assert.equal(end.code, 130, end.err);
        assert.ok(Date.now() - t0 < 4000, '不用等到 5 秒的强杀宽限');
        assert.match(end.err, /已中断，可用 obact resume r 续跑/);
        assert.equal(store.readCheckpoint()?.state, 'RUNNING');
        assert.deepEqual([alive(rec.owner), alive(rec.pid), leftovers(ws)], [false, false, '']);
        assert.equal(existsSync(join(ws, 'runs', 'r', 'run.lock')), false, '运行锁已释放');
        // 被信号结束的子进程留下的账号锁，下一次运行直接接管
        const again = cli(ws, ['resume', 'r']);
        const next = await until('续跑起好浏览器', () => {
          const r = browserRec(ws);
          return r && r.owner !== rec.owner && r;
        });
        again.proc.kill('SIGTERM');
        assert.equal((await again.done).code, 130);
        assert.equal(alive(next.pid), false);
      } finally {
        reap([-rec.pid, rec.owner, run.proc.pid as number]);
      }
    });
  }

  test('连按两次 Ctrl-C：第二次直接强杀子进程组并退出，不留孤儿子进程和 Chrome', async () => {
    const { ws, run, rec } = await start();
    try {
      process.kill(rec.owner, 'SIGSTOP'); // 子进程卡死：优雅停止它收不到也处理不了
      run.proc.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(run.proc.pid as number), '第一次信号走优雅流程，监督进程在等子进程');
      run.proc.kill('SIGINT');
      assert.equal((await run.done).code, 130);
      await until('子进程和 Chrome 都已退出', () => {
        return !alive(rec.owner) && !alive(rec.pid) && leftovers(ws) === '';
      });
    } finally {
      reap([-rec.pid, rec.owner, run.proc.pid as number]);
    }
  });
});
