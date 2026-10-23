// 进程锁（运行锁、账号锁）：O_EXCL 创建、活着的持有者拒绝、死掉的持有者接管、只释放自己的锁。不需要浏览器。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquireLock, LockedError } from '../src/lock.ts';

const dir = mkdtempSync(join(tmpdir(), 'obact-lock-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** 起一个会一直活着的进程，返回它的 pid 和杀掉它的函数（杀完等它退出，保证 pid 已经死透）。 */
async function sleeper() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const gone = new Promise((r) => p.once('exit', r));
  return {
    pid: p.pid as number,
    kill: async () => {
      p.kill('SIGKILL');
      await gone;
    },
  };
}

test('第二次拿同一把锁被拒绝，释放后可以再拿；锁里记着本进程的 pid', () => {
  const file = join(dir, 'a', 'x.lock'); // 目录不存在时自动创建
  const release = acquireLock(file, '运行 x');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  assert.throws(
    () => acquireLock(file, '运行 x'),
    (e) => e instanceof LockedError && e.code === 'invalid_params' && e.message.includes('运行 x'),
  );
  release();
  assert.equal(existsSync(file), false);
  acquireLock(file, '运行 x')();
});

test('持有者已死：接管；释放只删自己的锁（被别人接管后不误删）', async () => {
  const file = join(dir, 'dead.lock');
  const s = await sleeper();
  writeFileSync(file, JSON.stringify({ pid: s.pid, start: '' }));
  assert.throws(() => acquireLock(file, '账号 a'), LockedError, '持有者活着');
  await s.kill();
  const release = acquireLock(file, '账号 a'); // 持有者被杀，接管
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  writeFileSync(file, JSON.stringify({ pid: 1, start: 'other' })); // 模拟被别人接管
  release();
  assert.equal(existsSync(file), true, '不是自己的锁，不删');
});

test('pid 被别的进程复用（启动标识对不上）也算持有者已死', () => {
  if (process.platform !== 'linux') return; // 启动标识只在有 /proc 的平台上可靠
  const file = join(dir, 'reused.lock');
  writeFileSync(file, JSON.stringify({ pid: process.pid, start: '1' }));
  acquireLock(file, '运行 y')();
});

test('残缺的锁文件：刚写下的当作正在写（拒绝），过了一会儿当作遗留（接管）', () => {
  const file = join(dir, 'torn.lock');
  writeFileSync(file, '');
  assert.throws(() => acquireLock(file, '运行 z'), LockedError);
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  acquireLock(file, '运行 z')();
});
