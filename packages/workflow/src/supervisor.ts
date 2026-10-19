// 最小监督进程（FR-19 的最小部分，C-1）：拉起运行子进程，崩溃（非 0 退出码、被信号杀死、心跳超时）后
// 用同一命令加环境变量 OBACT_RESUME=1 重启，让子进程从检查点续跑。完整熔断与卡住截图留到 M4。
//
// 约定：
//  - 心跳：子进程每 5 秒更新 heartbeatFile（writeHeartbeat / startHeartbeat）。监督进程只看“内容或修改时间有没有变”，
//    起点是子进程启动的时刻，所以上一轮留下的旧心跳文件不会让新进程立刻被判超时，也不会被误当作新心跳。
//  - 子进程放在独立的进程组里（detached）；心跳超时、stop() 和子进程退出后的清扫都针对整个进程组，
//    浏览器等孙进程不会成为孤儿。
//  - 只依赖 node 内置模块：监督进程要常驻、要小、要快起来，不该为了一个错误类型加载整个浏览器内核。
//  - 重启次数按滑动窗口计：windowMs 内已重启 maxRestarts 次后再崩溃就熔断（TRIPPED），不再拉起。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

/** 崩溃原因：退出码非 0、被信号杀死（不是我们杀的）、心跳超时（我们杀的）。 */
export type CrashReason = 'exit_code' | 'signal' | 'heartbeat_timeout';

export type SupervisorEvent =
  | { type: 'start'; attempt: number; pid: number; resume: boolean }
  | { type: 'heartbeat_timeout'; pid: number; silent_ms: number }
  | {
      type: 'exit';
      pid: number;
      code: number | null;
      signal: NodeJS.Signals | null;
      /** ok：正常退出；stopped：被 stop() 终止。 */
      reason: CrashReason | 'ok' | 'stopped';
    }
  | { type: 'restart'; restarts: number; reason: CrashReason }
  | { type: 'tripped'; restarts: number; reason: CrashReason };

export type SuperviseOptions = {
  /** 子进程命令与参数，如 [process.execPath, 'cli.ts', 'run', ...]。 */
  command: string[];
  cwd?: string;
  /** 追加到当前进程环境之上的环境变量。 */
  env?: Record<string, string | undefined>;
  heartbeatFile: string;
  /** 超过这么久没有心跳视为崩溃，默认 30000。 */
  heartbeatTimeoutMs?: number;
  /** 窗口内最多重启几次，默认 3。 */
  maxRestarts?: number;
  /** 计重启次数的窗口，默认 1 小时。 */
  windowMs?: number;
  /** stop() 发出 SIGTERM 后，等多久还没退出就改用 SIGKILL，默认 5000。 */
  stopGraceMs?: number;
  /** 观察事件；回调抛出的异常会被忽略，不影响监督。 */
  onEvent?: (e: SupervisorEvent) => void;
};

export type SuperviseResult = {
  /** DONE：子进程正常退出（码 0）；TRIPPED：熔断；STOPPED：被 stop() 终止。 */
  state: 'DONE' | 'TRIPPED' | 'STOPPED';
  /** 一共重启了几次。 */
  restarts: number;
};

/** superviseRun 的返回值：await 它得到结果，stop() 终止子进程且不再重启。 */
export type SupervisedRun = Promise<SuperviseResult> & { stop(): Promise<void> };

/** 子进程写一次心跳：把当前毫秒时间戳写进文件（监督进程看内容和修改时间的变化）。 */
export function writeHeartbeat(file: string): void {
  writeFileSync(file, `${Date.now()}\n`);
}

/**
 * 子进程启动心跳：立即写一次，之后每 intervalMs（默认 5 秒）写一次；返回停止函数。
 * 定时器不阻止进程退出；写失败（如磁盘满）忽略，由监督进程按“无心跳”处理。
 * 事件循环被阻塞时心跳也会停，这正是“卡住”的信号。
 */
export function startHeartbeat(file: string, intervalMs = 5000): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const beat = () => {
    try {
      writeHeartbeat(file);
    } catch {}
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** 心跳文件的“签名”：内容 + 修改时间；任何一项变化都算有心跳。文件不存在为空串。 */
function beatSignature(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${readFileSync(file, 'utf8')}`;
  } catch {
    return '';
  }
}

/** 向进程组发信号（组长就是子进程）；Windows 没有进程组，用 taskkill 杀进程树。进程组已空时忽略。 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch {}
}

type Outcome = { code: number | null; signal: NodeJS.Signals | null; reason: CrashReason | 'ok' };

export function superviseRun(opts: SuperviseOptions): SupervisedRun {
  const { command, heartbeatFile } = opts;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((c) => typeof c !== 'string')
  ) {
    throw new TypeError('command 必须是非空的字符串数组');
  }
  if (typeof heartbeatFile !== 'string' || heartbeatFile === '') {
    throw new TypeError('heartbeatFile 不能为空');
  }
  const timeoutMs = opts.heartbeatTimeoutMs ?? 30_000;
  const maxRestarts = opts.maxRestarts ?? 3;
  const windowMs = opts.windowMs ?? 3_600_000;
  const stopGraceMs = opts.stopGraceMs ?? 5000;
  if (!(timeoutMs > 0) || !(windowMs > 0) || !(stopGraceMs >= 0)) {
    throw new TypeError('heartbeatTimeoutMs、windowMs 必须大于 0');
  }
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new TypeError('maxRestarts 必须是非负整数');
  }
  // 检查间隔取超时的 1/10，上限 1 秒、下限 10 毫秒
  const pollMs = Math.min(1000, Math.max(10, Math.floor(timeoutMs / 10)));

  const emit = (e: SupervisorEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {}
  };

  let stopping = false;
  let current: ChildProcess | null = null;
  let escalate: NodeJS.Timeout | undefined;

  const runOnce = (attempt: number): Promise<Outcome> =>
    new Promise((resolve, reject) => {
      const resume = attempt > 1;
      const env = { ...process.env, ...opts.env, ...(resume ? { OBACT_RESUME: '1' } : {}) };
      let baseline = beatSignature(heartbeatFile);
      let lastBeat = performance.now();
      let timedOut = false;
      const child = spawn(command[0] as string, command.slice(1), {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: process.platform !== 'win32',
      });
      current = child;
      if (child.pid !== undefined) emit({ type: 'start', attempt, pid: child.pid, resume });

      const timer = setInterval(() => {
        const sig = beatSignature(heartbeatFile);
        const now = performance.now();
        if (sig !== baseline) {
          baseline = sig;
          lastBeat = now;
        } else if (!timedOut && now - lastBeat > timeoutMs) {
          timedOut = true;
          emit({
            type: 'heartbeat_timeout',
            pid: child.pid as number,
            silent_ms: Math.round(now - lastBeat),
          });
          killGroup(child, 'SIGKILL');
        }
      }, pollMs);

      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        current = null;
        reject(new Error(`无法启动 ${command.join(' ')}：${err.message}`));
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(escalate);
        current = null;
        killGroup(child, 'SIGKILL'); // 清扫残留的子孙进程（如孤立的浏览器）
        // 退出码 0 就是正常结束，哪怕恰好同时被判了超时
        const reason: Outcome['reason'] =
          code === 0
            ? 'ok'
            : timedOut
              ? 'heartbeat_timeout'
              : code === null
                ? 'signal'
                : 'exit_code';
        emit({
          type: 'exit',
          pid: child.pid as number,
          code,
          signal,
          reason: stopping && reason !== 'ok' ? 'stopped' : reason,
        });
        resolve({ code, signal, reason });
      });
    });

  const main = async (): Promise<SuperviseResult> => {
    const restartTimes: number[] = [];
    let restarts = 0;
    for (let attempt = 1; ; attempt++) {
      const out = await runOnce(attempt);
      if (stopping) return { state: 'STOPPED', restarts };
      if (out.reason === 'ok') return { state: 'DONE', restarts };
      const now = performance.now();
      while (restartTimes.length > 0 && now - (restartTimes[0] as number) > windowMs)
        restartTimes.shift();
      if (restartTimes.length >= maxRestarts) {
        emit({ type: 'tripped', restarts, reason: out.reason });
        return { state: 'TRIPPED', restarts };
      }
      restartTimes.push(now);
      restarts++;
      emit({ type: 'restart', restarts, reason: out.reason });
    }
  };

  const run = main() as SupervisedRun;
  run.stop = async () => {
    if (!stopping) {
      stopping = true;
      const child = current;
      if (child) {
        killGroup(child, 'SIGTERM');
        escalate = setTimeout(() => killGroup(child, 'SIGKILL'), stopGraceMs);
      }
    }
    try {
      await run;
    } catch {}
  };
  return run;
}
