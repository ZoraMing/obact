// 最小监督进程（FR-19 最小部分、C-1）：用小的 node 子进程脚本模拟崩溃、卡住和正常运行。
// 心跳超时参数调小到几百毫秒；不需要浏览器。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.ts';
import { type SupervisorEvent, superviseRun } from '../src/supervisor.ts';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-supervisor', 'child.ts');

const dirs: string[] = [];
after(() => {
  // 万一测试失败，别把孙进程留在系统里
  for (const d of dirs) {
    for (const pid of pids(d)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'obact-sup-'));
  dirs.push(dir);
  const heartbeatFile = join(dir, 'heartbeat');
  const events: SupervisorEvent[] = [];
  return {
    dir,
    heartbeatFile,
    events,
    command: [process.execPath, CHILD, mode, dir, heartbeatFile],
    onEvent: (e: SupervisorEvent) => events.push(e),
  };
}

/** 每次启动时子进程看到的 OBACT_RESUME。 */
function starts(dir: string): string[] {
  return readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n');
}

function pids(dir: string): number[] {
  const f = join(dir, 'grandchild.pids');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

/** 进程是否还在运行（僵尸不算：容器里 1 号进程不一定回收孤儿）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true; // 没有 /proc（非 Linux）：kill(0) 成功就算活着
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    assert.ok(Date.now() < deadline, `等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('C-1：子进程崩溃（非 0 退出码、被 SIGKILL）后带 OBACT_RESUME=1 重启，直到正常结束', async () => {
  const t = setup('crash-then-ok');
  const result = await superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    onEvent: t.onEvent,
  });
  assert.deepEqual(result, { state: 'DONE', restarts: 2 });
  // 首次启动不带续跑标记，之后每次都带
  assert.deepEqual(starts(t.dir), ['-', '1', '1']);
  assert.deepEqual(
    t.events.filter((e) => e.type === 'restart').map((e) => e.reason),
    ['exit_code', 'signal'],
  );
});

test('熔断：窗口内重启超过 maxRestarts 次就停止，返回 TRIPPED', async () => {
  const t = setup('always-crash');
  const result = await superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    maxRestarts: 2,
    onEvent: t.onEvent,
  });
  assert.deepEqual(result, { state: 'TRIPPED', restarts: 2 });
  assert.equal(starts(t.dir).length, 3, '首次启动加 2 次重启，不会有第 3 次重启');
  assert.equal(t.events.at(-1)?.type, 'tripped');
});

test('熔断按滑动窗口计：相邻两次重启隔得比窗口远，累计超过 maxRestarts 也不熔断', async () => {
  // 子进程每次至少活 350 毫秒，窗口 200 毫秒：任何时刻窗口里最多 1 次重启
  const t = setup('slow-crash');
  const result = await superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    maxRestarts: 1,
    windowMs: 200,
  });
  assert.deepEqual(result, { state: 'DONE', restarts: 3 });
});

test('心跳正常的长任务不会被误杀', async () => {
  // 心跳超时 1.2 秒，任务跑 2.5 秒：误判（比如读不到心跳）会表现为被杀并重启
  const t = setup('healthy');
  const result = await superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    heartbeatTimeoutMs: 1200,
    onEvent: t.onEvent,
  });
  assert.deepEqual(result, { state: 'DONE', restarts: 0 });
  assert.equal(
    t.events.some((e) => e.type === 'heartbeat_timeout'),
    false,
  );
});

test('心跳超时：杀掉整个进程组（含孙进程），再带 OBACT_RESUME=1 重启', async () => {
  const t = setup('hang');
  const result = await superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    heartbeatTimeoutMs: 600,
    onEvent: t.onEvent,
  });
  assert.deepEqual(result, { state: 'DONE', restarts: 1 });
  assert.deepEqual(starts(t.dir), ['-', '1']);
  const timeout = t.events.find((e) => e.type === 'heartbeat_timeout');
  assert.ok(timeout, '应有 heartbeat_timeout 事件');
  assert.equal(t.events.find((e) => e.type === 'restart')?.reason, 'heartbeat_timeout');

  const first = t.events.find((e) => e.type === 'start');
  assert.ok(first && first.type === 'start');
  const grandchildren = pids(t.dir);
  assert.equal(grandchildren.length, 1);
  await waitFor(() => ![first.pid, ...grandchildren].some(alive), '被判超时的进程组全部退出');
});

test('stop()：终止忽略 SIGTERM 的子进程及其孙进程，且不再重启', async () => {
  const t = setup('stubborn');
  const run = superviseRun({
    command: t.command,
    heartbeatFile: t.heartbeatFile,
    stopGraceMs: 300,
    onEvent: t.onEvent,
  });
  await waitFor(() => existsSync(join(t.dir, 'ready')), '子进程就绪');
  await run.stop();
  assert.deepEqual(await run, { state: 'STOPPED', restarts: 0 });
  assert.equal(starts(t.dir).length, 1, 'stop 后不应重启');
  const first = t.events.find((e) => e.type === 'start');
  assert.ok(first && first.type === 'start');
  await waitFor(() => ![first.pid, ...pids(t.dir)].some(alive), '子进程与孙进程全部退出');
});

test('监督进程自己退出（process.exit）时，同步清扫子进程组，不留孤儿', async () => {
  const t = setup('stubborn');
  const parent = join(dirname(CHILD), 'parent.ts');
  const r = spawnSync(process.execPath, [parent, t.dir], { timeout: 15_000 });
  assert.equal(r.status, 0, String(r.stderr));
  const child = Number(readFileSync(join(t.dir, 'child.pid'), 'utf8'));
  try {
    await waitFor(() => ![child, ...pids(t.dir)].some(alive), '子进程与孙进程全部退出');
  } finally {
    try {
      process.kill(child, 'SIGKILL'); // 断言失败时别留下它（它忽略 SIGTERM）
    } catch {}
  }
});

test('index.ts 导出监督与清扫的接口（含类型 SupervisorEvent、SuperviseResult）', () => {
  const result: api.SuperviseResult = { state: 'DONE', restarts: 0 };
  const event: api.SupervisorEvent = { type: 'restart', restarts: 1, reason: 'signal' };
  assert.deepEqual([result.state, event.type], ['DONE', 'restart']);
  for (const f of [api.sweepBrowser, api.startHeartbeat, api.superviseRun]) {
    assert.equal(typeof f, 'function');
  }
});
