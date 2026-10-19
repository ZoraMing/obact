// 子进程：反复写检查点，直到被测试 SIGKILL。参数：工作区 运行ID。
// 每次写成功后同步输出 seq 到 stdout：输出过就代表这一版已经写成功（测试据此判断“已确认的不丢”）。
// 接着磁盘上已有的检查点往下编（模拟崩溃后续跑），vars.n 与 seq 始终相等。
import { writeSync } from 'node:fs';
import { RunStore } from '../../src/store.ts';
import { payload } from './payload.ts';

const [workspace, runId] = process.argv.slice(2) as [string, string];
const store = new RunStore(workspace, runId);
let n = (store.readCheckpoint()?.vars?.n as number | undefined) ?? 0;
for (;;) {
  n += 1;
  const cp = store.writeCheckpoint({
    run_id: runId,
    workflow: 'wf',
    mode: 'headless',
    state: 'RUNNING',
    step_id: `s${n % 50}`,
    loop_index: { s03: n },
    vars: { n, blob: payload(n) },
    cursor: { rows: n },
  });
  writeSync(1, `${cp.seq}\n`);
}
