// 监督进程测试用的父进程：拉起一个忽略 SIGTERM、带孙进程的子进程，等它就绪后自己 process.exit。
// 参数：状态目录。子进程的 pid 写在 <状态目录>/child.pid。
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseRun } from '../../src/supervisor.ts';

const dir = process.argv[2] as string;
const child = join(dirname(fileURLToPath(import.meta.url)), 'child.ts');
superviseRun({
  command: [process.execPath, child, 'stubborn', dir, join(dir, 'heartbeat')],
  heartbeatFile: join(dir, 'heartbeat'),
  onEvent: (e) => {
    if (e.type === 'start') writeFileSync(join(dir, 'child.pid'), String(e.pid));
  },
});
setInterval(() => {
  if (existsSync(join(dir, 'ready'))) process.exit(0); // 监督进程强退：子进程组要被同步清扫
}, 20);
