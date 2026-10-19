// 运行目录存储（FR-17、FR-18、FR-26）：检查点原子写、成功记录与待核实清单、留痕、截图清理。
// 崩溃用真实子进程 + SIGKILL 验证（C-1 的存储层依据）；不需要浏览器。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ObactError } from '@obact/core';
import type { Checkpoint } from '@obact/schemas';
import { RunStore, type TrajectoryInput } from '../src/store.ts';
import { payload } from './fixtures-store/payload.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-store');

const tmpDirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'obact-store-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function thrown(fn: () => unknown, code: string): ObactError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ObactError, `应抛 ObactError，实际：${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`应抛 ${code}`);
}

function cp(runId: string, extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    run_id: runId,
    workflow: 'wf',
    mode: 'headless',
    state: 'RUNNING',
    step_id: 's01',
    ...extra,
  };
}

/**
 * 启动子进程脚本，收到 acks 条确认后 SIGKILL，等它退出且输出读完。
 * 返回子进程确认过的最大序号（它输出一条就代表对应的写入已经成功返回）。
 * 杀的时刻随子进程的进度而变，被杀时它可能正好在写；下面的断言都是任何时刻都成立的不变量。
 */
async function killAfterAcks(script: string, args: string[], acks: number): Promise<number> {
  const child = spawn(process.execPath, [join(FIX, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let killed = false;
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d;
    if (!killed && out.split('\n').length - 1 >= acks) {
      killed = true;
      child.kill('SIGKILL');
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    err += d;
  });
  const [code, signal] = await once(child, 'close');
  assert.ok(killed, `子进程在 ${acks} 条确认之前就退出了（code=${code}）：${err}`);
  assert.equal(signal, 'SIGKILL');
  const lines = out.split('\n').slice(0, -1);
  assert.ok(lines.length >= acks);
  return Number(lines.at(-1));
}

// ---------- 检查点 ----------

test('检查点：反复 SIGKILL，读到的一定是完整的一版，seq 跨崩溃单调递增（C-1）', {
  timeout: 120_000,
}, async () => {
  const ws = workspace();
  let prev = 0;
  for (const acks of [1, 6, 2]) {
    const acked = await killAfterAcks('ckpt-writer.ts', [ws, 'r1'], acks);
    const store = new RunStore(ws, 'r1');
    const got = store.readCheckpoint();
    assert.ok(got, '被杀之后必须读得到检查点（旧版本或新版本）');
    // 完整：同一版里的各字段互相自洽（vars.n、loop_index、cursor、大块数据都来自同一次写入）
    const n = got.vars?.n as number;
    assert.equal(n, got.seq);
    assert.equal(got.vars?.blob, payload(n));
    assert.deepEqual(got.loop_index, { s03: n });
    assert.deepEqual(got.cursor, { rows: n });
    // 已确认写成功的不丢；在途的那一版要么没生效（seq = acked），要么完整生效（acked + 1）
    assert.ok(
      (got.seq ?? 0) >= acked && (got.seq ?? 0) <= acked + 1,
      `seq=${got.seq} acked=${acked}`,
    );
    assert.ok((got.seq ?? 0) > prev, 'seq 跨崩溃重启也要递增');
    prev = got.seq ?? 0;
    // 崩溃留下的临时文件被清理
    assert.deepEqual(
      readdirSync(store.dir).filter((f) => f.endsWith('.tmp')),
      [],
    );
  }
});

test('检查点：写入的每个环节被 SIGKILL，正式文件只会是完整的旧版本或新版本，下一次写入接着编号', {
  timeout: 120_000,
}, async () => {
  const ws = workspace();
  const points = {
    'mid-write': 'v1', // 临时文件只写了一半
    'before-fsync': 'v1', // 临时文件写完，未 fsync
    'before-rename': 'v1', // 临时文件已落盘，未 rename
    'after-rename': 'v2', // 已 rename，未 fsync 目录
  } as const;
  await Promise.all(
    Object.entries(points).map(async ([point, expected]) => {
      const runId = `crash-${point}`;
      const child = spawn(process.execPath, [join(FIX, 'crash-at.ts'), ws, runId, point], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        err += d;
      });
      const [, signal] = await once(child, 'close');
      assert.equal(signal, 'SIGKILL', `${point}：子进程应在崩溃点被杀：${err}`);

      const store = new RunStore(ws, runId);
      assert.equal(store.readCheckpoint()?.step_id, expected, point);
      assert.deepEqual(
        readdirSync(store.dir).filter((f) => f.endsWith('.tmp')),
        [],
        `${point}：遗留的临时文件应被清理`,
      );
      const next = store.writeCheckpoint(cp(runId, { step_id: 'v3' }));
      assert.equal(next.seq, expected === 'v1' ? 2 : 3, point);
    }),
  );
});

test('检查点：半写的临时文件被忽略并清理（别的进程正在写的除外），损坏的检查点读作 null', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r2');
  assert.equal(store.readCheckpoint(), null);
  const first = store.writeCheckpoint(cp('r2', { step_id: 's05' }));

  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = join(store.dir, `checkpoint.json.${deadPid}.1.tmp`);
  const inFlight = join(store.dir, `checkpoint.json.${process.ppid}.1.tmp`);
  writeFileSync(stale, '{"run_id":"r2","workfl');
  writeFileSync(inFlight, '{"run_id":"r2"');

  const read = new RunStore(ws, 'r2').readCheckpoint();
  assert.equal(read?.step_id, 's05');
  assert.equal(read?.seq, first.seq);
  assert.equal(existsSync(stale), false, '属主进程已死的临时文件应清理');
  assert.equal(existsSync(inFlight), true, '属主进程还活着的临时文件可能正在写，不能删');

  writeFileSync(store.checkpointPath, '{"run_id":"r2","workfl');
  assert.equal(new RunStore(ws, 'r2').readCheckpoint(), null);
});

test('检查点：写前按契约校验，失败不动旧版本；seq 自动维护；vars、cursor 里的敏感值写成 ***', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r3');
  const base = cp('r3', {
    vars: { user: 'bob', password: 'p@ss', account: { api_token: 't0k', id: 7 } },
    cursor: { secret_key: 'sk', rows: 3 },
  });
  const w1 = store.writeCheckpoint(base);
  assert.equal(w1.seq, 1);
  const raw = readFileSync(store.checkpointPath, 'utf8');
  for (const leaked of ['p@ss', 't0k', '"sk"'])
    assert.ok(!raw.includes(leaked), `泄漏了 ${leaked}`);
  const disk = JSON.parse(raw) as Checkpoint;
  assert.deepEqual(disk.vars, {
    user: 'bob',
    password: '***',
    account: { api_token: '***', id: 7 },
  });
  assert.deepEqual(disk.cursor, { secret_key: '***', rows: 3 });

  thrown(() => store.writeCheckpoint({ ...base, state: 'BOGUS' as never }), 'invalid_params');
  thrown(() => store.writeCheckpoint({ ...base, run_id: 'other' }), 'invalid_params');
  assert.equal(store.readCheckpoint()?.seq, 1, '校验失败不能动旧版本');

  // 调用方带的 seq 不算数：新实例（续跑）接着磁盘上的往下编
  const w2 = new RunStore(ws, 'r3').writeCheckpoint({ ...base, seq: 99 });
  assert.equal(w2.seq, 2);
});

// ---------- 成功记录 ----------

test('成功记录：SIGKILL 后已确认的一条不丢，索引重建后序号连续无重复，重复的键不再写入', {
  timeout: 120_000,
}, async () => {
  const ws = workspace();
  let total = 0;
  for (const acks of [3, 5]) {
    const acked = await killAfterAcks('append-writer.ts', [ws, 'r4'], acks);
    const store = new RunStore(ws, 'r4');
    const keys = store.listSideEffects().map((r) => r.idempotency_key);
    // 被杀时在途的那一条：要么完整落盘，要么只是末尾残片（被忽略）；已确认的全在，没有重复、断号
    assert.ok(
      keys.length === acked || keys.length === acked + 1,
      `keys=${keys.length} acked=${acked}`,
    );
    assert.deepEqual(
      keys,
      keys.map((_, i) => `k${i + 1}`),
    );
    assert.ok(keys.length > total);
    total = keys.length;
    for (const k of keys) assert.ok(store.hasSideEffect(k));
    // 除了可能的末尾残片，每一行都是完整的 JSON
    const lines = readFileSync(store.sideEffectsPath, 'utf8').split('\n').slice(0, -1);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    // 同一个键再记一次：不写
    const size = readFileSync(store.sideEffectsPath).length;
    assert.equal(store.recordSideEffect({ step_id: 's04', idempotency_key: 'k1' }), false);
    assert.equal(readFileSync(store.sideEffectsPath).length, size);
  }
});

test('成功记录：末尾残缺的一行被忽略，不会连累之后追加的记录；别的实例追加的也能看见', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r5');
  store.recordSideEffect({ step_id: 's1', idempotency_key: 'a' });
  // 模拟写到一半被打断（磁盘满、断电）：残片没有换行
  appendFileSync(store.sideEffectsPath, '{"run_id":"r5","step_id":"s2","idempotency_key":"b","ti');

  const reopened = new RunStore(ws, 'r5');
  assert.deepEqual(
    reopened.listSideEffects().map((r) => r.idempotency_key),
    ['a'],
  );
  assert.equal(reopened.hasSideEffect('b'), false);

  assert.equal(reopened.recordSideEffect({ step_id: 's3', idempotency_key: 'c' }), true);
  const again = new RunStore(ws, 'r5');
  assert.deepEqual(
    again.listSideEffects().map((r) => r.idempotency_key),
    ['a', 'c'],
  );

  // 运行进程追加之后，另一个早就打开的实例（如命令行 status）立刻能看到
  reopened.recordSideEffect({ step_id: 's4', idempotency_key: 'd' });
  assert.equal(again.hasSideEffect('d'), true);
});

// ---------- 待核实清单 ----------

test('待核实：核实为已完成会记入成功记录（续跑跳过），未完成可重做；记录只追加', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r6');
  const rec = (key: string, reason: 'post_timeout' | 'crash' | 'post_failed' = 'post_timeout') => ({
    step_id: 's04',
    idempotency_key: key,
    reason,
    screenshot: null,
  });
  assert.equal(store.recordUnverified(rec('audit:1')), true);
  assert.equal(store.recordUnverified(rec('audit:2', 'crash')), true);
  assert.equal(store.recordUnverified(rec('audit:1')), false, '未核实期间同键不重复记');
  assert.equal(store.hasSideEffect('audit:1'), false);

  const done = store.resolveUnverified('audit:1', { outcome: 'done', note: '后台已看到' });
  assert.equal(done.resolution?.outcome, 'done');
  assert.equal(done.resolution?.note, '后台已看到');
  assert.equal(store.hasSideEffect('audit:1'), true);
  store.resolveUnverified('audit:2', { outcome: 'not_done' });
  assert.equal(store.hasSideEffect('audit:2'), false);

  // 重新打开（续跑）：核实结果与成功记录都在，顺序不变
  const reopened = new RunStore(ws, 'r6');
  assert.deepEqual(
    reopened.listUnverified().map((r) => [r.idempotency_key, r.resolution?.outcome]),
    [
      ['audit:1', 'done'],
      ['audit:2', 'not_done'],
    ],
  );
  assert.deepEqual(reopened.listUnverified({ unresolved: true }), []);
  assert.equal(reopened.hasSideEffect('audit:1'), true);

  // 已记入成功记录的撤不回；不存在的键报错
  thrown(() => reopened.resolveUnverified('audit:1', { outcome: 'not_done' }), 'invalid_params');
  thrown(() => reopened.resolveUnverified('nope', { outcome: 'done' }), 'invalid_params');
  assert.equal(reopened.hasSideEffect('audit:1'), true);

  // 判定没做成、重做后又状态未明：重新变成未核实
  assert.equal(reopened.recordUnverified(rec('audit:2', 'post_failed')), true);
  assert.deepEqual(
    reopened.listUnverified({ unresolved: true }).map((r) => [r.idempotency_key, r.reason]),
    [['audit:2', 'post_failed']],
  );
});

// ---------- 留痕 ----------

test('留痕：steps.log 一步一行；轨迹按契约校验，seq 续跑后接着编', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r7');
  store.appendStepLog('s01 click ok 12ms\n多出来的换行');
  store.appendStepLog('s02 type ok 3ms');
  assert.equal(readFileSync(store.stepsLogPath, 'utf8').split('\n').length, 3); // 两行 + 末尾空串

  const entry: TrajectoryInput = {
    step_id: 's01',
    action: { op: 'click', pageId: 'main', target: { css: '#go' } },
    result: {
      status: 'ok',
      duration_ms: 12,
      effects: { navigated: false, new_pages: [], dialogs: [], changed: true },
    },
    source: 'workflow',
  };
  assert.equal(store.appendTrajectory(entry).seq, 1);
  assert.equal(store.appendTrajectory(entry).seq, 2);
  const bad = { ...entry, action: { op: 'click', pageId: 'main' } };
  thrown(() => store.appendTrajectory(bad as never), 'invalid_params');
  const lines = () => readFileSync(store.trajectoryPath, 'utf8').split('\n').slice(0, -1);
  assert.equal(lines().length, 2, '校验失败什么都不写');

  assert.equal(new RunStore(ws, 'r7').appendTrajectory(entry).seq, 3);
  assert.deepEqual(
    lines().map((l) => (JSON.parse(l) as { seq: number }).seq),
    [1, 2, 3],
  );
});

// ---------- 截图 ----------

test('截图：路径不会写出 shots 目录；清理只留最近 N 张，keep/ 与待核实引用的不动', () => {
  const ws = workspace();
  const store = new RunStore(ws, 'r8');
  assert.equal(dirname(store.shotPath('../../etc/x:y')), store.shotsDir);

  const base = Date.now() / 1000 - 1000;
  const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
  names.forEach((n, i) => {
    const f = store.shotPath(n);
    writeFileSync(f, n);
    utimesSync(f, base + i, base + i); // p1 最旧，p5 最新
  });
  const failure = store.shotPath('fail', { keep: true });
  writeFileSync(failure, 'x');
  utimesSync(failure, base - 100, base - 100);
  // p1 是待核实记录的依据（相对工作区的路径），最旧也不能删
  store.recordUnverified({
    step_id: 's04',
    idempotency_key: 'audit:1',
    reason: 'post_timeout',
    screenshot: 'runs/r8/shots/p1.webp',
  });

  assert.equal(store.pruneShots(2), 2);
  assert.deepEqual(readdirSync(store.shotsDir).sort(), ['keep', 'p1.webp', 'p4.webp', 'p5.webp']);
  assert.ok(existsSync(failure));
  assert.equal(store.pruneShots(2), 0);
});
