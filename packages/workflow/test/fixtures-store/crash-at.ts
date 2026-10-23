// 子进程：先正常写一版检查点（v1），再写 v2，并在写 v2 的指定环节让自己 SIGKILL，模拟精确时刻的崩溃。
// 参数：工作区 运行ID 崩溃点。崩溃点：
//   mid-write     临时文件只写了一半
//   before-fsync  临时文件写完，还没 fsync
//   before-rename 临时文件已落盘，还没 rename 成正式文件
//   after-rename  已 rename，还没 fsync 目录
// 做法：替换 node:fs 的函数并同步到 ESM 的具名导入，store.ts 不需要为测试留任何钩子。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [workspace, runId, point] = process.argv.slice(2) as [string, string, string];
const { RunStore } = await import('../../src/store.ts');
const store = new RunStore(workspace, runId);
const base = { run_id: runId, workflow: 'wf', mode: 'headless', state: 'RUNNING' } as const;
store.writeCheckpoint({ ...base, step_id: 'v1', vars: { v: 1 } });

const die = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('不应继续执行');
};
const real = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
if (point === 'mid-write') {
  fs.writeSync = ((fd: number, buf: Buffer, off: number, len: number) => {
    real.writeSync(fd, buf, off, Math.floor(len / 2));
    return die();
  }) as unknown as typeof fs.writeSync;
} else if (point === 'before-fsync') {
  fs.fsyncSync = (() => die()) as typeof fs.fsyncSync;
} else if (point === 'before-rename') {
  fs.renameSync = (() => die()) as typeof fs.renameSync;
} else if (point === 'after-rename') {
  fs.renameSync = ((from: string, to: string) => {
    real.renameSync(from, to);
    return die();
  }) as typeof fs.renameSync;
} else {
  throw new Error(`未知崩溃点：${point}`);
}
syncBuiltinESMExports();
store.writeCheckpoint({ ...base, step_id: 'v2', vars: { v: 2 } });
throw new Error('没有在崩溃点被杀');
