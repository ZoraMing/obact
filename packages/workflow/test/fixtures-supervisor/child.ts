// 监督进程测试用的子进程：按模式模拟崩溃、卡住、正常运行。
// 参数：模式 状态目录 心跳文件。每次启动在 <状态目录>/starts.log 追加一行当时的 OBACT_RESUME（没有则 '-'），
// 孙进程的 pid 追加在 <状态目录>/grandchild.pids，准备好后写 <状态目录>/ready。
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHeartbeat } from '../../src/supervisor.ts';

const [mode, dir, heartbeat] = process.argv.slice(2) as [string, string, string];
appendFileSync(join(dir, 'starts.log'), `${process.env.OBACT_RESUME ?? '-'}\n`);
const attempt = readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').length;
const resumed = process.env.OBACT_RESUME === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一个会一直活着的孙进程（同一进程组），记下 pid。 */
function spawnGrandchild(): void {
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  appendFileSync(join(dir, 'grandchild.pids'), `${gc.pid}\n`);
}

switch (mode) {
  case 'crash-then-ok':
    // 第 1 次以退出码 3 崩溃，第 2 次被 SIGKILL 杀死（模拟任务进程被杀），第 3 次正常结束
    if (attempt === 1) process.exit(3);
    if (attempt === 2) process.kill(process.pid, 'SIGKILL');
    break;
  case 'always-crash':
    process.exit(1);
    break;
  case 'slow-crash':
    // 每次活 350 毫秒再崩溃，第 4 次正常结束（用来验证滑动窗口：相邻重启隔得比窗口远）
    await sleep(350);
    if (attempt < 4) process.exit(1);
    break;
  case 'healthy': {
    // 心跳正常的长任务：跑 2500 毫秒（远超心跳超时）后正常结束
    startHeartbeat(heartbeat, 40);
    await sleep(2500);
    break;
  }
  case 'hang': {
    // 首次：心跳一小会儿后停止心跳但进程仍活着（卡住），并带一个孙进程；续跑时直接结束
    if (resumed) break;
    const stop = startHeartbeat(heartbeat, 30);
    spawnGrandchild();
    await sleep(200);
    stop();
    writeFileSync(join(dir, 'ready'), '');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  case 'stubborn': {
    // 忽略 SIGTERM、心跳正常、带孙进程，永不自行退出：只有 SIGKILL 能结束它
    process.on('SIGTERM', () => {});
    startHeartbeat(heartbeat, 30);
    spawnGrandchild();
    writeFileSync(join(dir, 'ready'), '');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    throw new Error(`未知模式 ${mode}`);
}
