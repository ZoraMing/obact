// 命令行层用例（cli、signals）共用：起命令行进程、等条件、读运行目录里记录的浏览器、判断进程是否还在。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from '../../../../lab/test/helpers.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/** 起一个命令行进程；done 在它退出后给出退出码和 stdout / stderr。 */
export function cli(ws: string, args: string[]) {
  const proc: ChildProcess = spawn(process.execPath, [CLI, ...args, '--workspace', ws], {
    env: { ...process.env, CHROME_PATH: CHROME },
  });
  let [out, err] = ['', ''];
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    proc.on('close', (code) => resolve({ code, out, err })),
  );
  return { proc, done };
}

export async function until<T>(
  what: string,
  f: () => T | undefined | false,
  ms = 30_000,
): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = f();
    if (v) return v;
  }
  throw new Error(`等待超时：${what}`);
}

/** 运行目录里记录的浏览器：pid 是 Chrome，owner 是启动它的运行子进程。 */
export const browserRec = (ws: string, runId = 'r') => {
  try {
    return JSON.parse(readFileSync(join(ws, 'runs', runId, 'browser.pid'), 'utf8')) as {
      pid: number;
      owner: number;
    };
  } catch {}
};

/** 进程是否还在运行（僵尸不算：容器里 1 号进程不一定回收孤儿）。 */
export function alive(pid: number): boolean {
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

/** 命令行里带这个工作区配置目录的进程（Chrome 及其子进程）；pgrep 的模式写成 [=] 形式，不会匹配到自己。 */
export function leftovers(ws: string): string {
  return spawnSync('pgrep', ['-f', `user-data-dir[=]${ws}`], { encoding: 'utf8' }).stdout.trim();
}
