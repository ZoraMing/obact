// 进程锁（运行锁 runs/<id>/run.lock、账号锁 profiles/<账号>.lock）：锁文件用 O_EXCL 创建，内容是持有者的
// pid 和进程启动标识。持有者还活着就拒绝；持有者已死（被 SIGKILL、崩溃都不会留下“永远解不开”的锁）就接管。
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ObactError } from '@obact/core';

/** 锁被另一个还活着的进程持有（命令行据此用专用退出码）。 */
export class LockedError extends ObactError {}

type Holder = { pid: number; start: string };

/** 进程状态与启动标识：pid 被别的进程复用后标识会变。Linux 读 /proc，其他平台用 ps；读不到返回 null。 */
function procInfo(pid: number): { zombie: boolean; start: string } | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // 第 3 个字段起：状态……第 22 个：启动时刻
      return { zombie: f[0] === 'Z', start: f[19] ?? '' };
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
    return { zombie: false, start: r.stdout.trim() };
  } catch {
    return null;
  }
}

/** 持有者是不是仍在运行的那个进程（已退出未回收的僵尸、pid 被复用的都不算）。 */
function alive(h: Holder): boolean {
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const info = procInfo(h.pid);
  return !(info?.zombie || (h.start && info?.start && h.start !== info.start));
}

function parse(text: string): Holder | null {
  try {
    const h = JSON.parse(text) as Holder;
    return Number.isInteger(h.pid) && typeof h.start === 'string' ? h : null;
  } catch {
    return null;
  }
}

/**
 * 拿锁，返回释放函数（只删仍是自己的锁，重复调用无害）。被活着的进程持有抛 LockedError。
 * 接管时先确认文件内容还是刚才判定过的那份才删，再重新 O_EXCL 创建；两个进程同时接管，只有一个创建得成。
 */
export function acquireLock(file: string, what: string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, start: procInfo(process.pid)?.start ?? '' });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let text = '';
    let fresh = false;
    try {
      text = readFileSync(file, 'utf8');
      fresh = Date.now() - statSync(file).mtimeMs < 5000;
    } catch {
      continue; // 刚被释放，重来
    }
    const holder = parse(text);
    // 内容残缺：持有者可能正写到一半（刚创建的 5 秒内），否则是崩溃遗留
    if (holder ? alive(holder) : fresh) {
      throw new LockedError(
        'invalid_params',
        `${what} 已被进程 ${holder?.pid ?? '?'} 占用（锁文件 ${file}；确认它已不在运行可删除该文件）`,
      );
    }
    try {
      if (readFileSync(file, 'utf8') === text) rmSync(file, { force: true });
    } catch {}
  }
  throw new LockedError('invalid_params', `${what}：锁反复抢不到（锁文件 ${file}）`);
}
