// 子进程：反复追加成功记录，直到被测试 SIGKILL。参数：工作区 运行ID。
// 每条记录带一大块证据（一行几百 KB，增加写到一半被打断的机会）；追加成功后同步输出序号。
// 序号接着已有记录的条数往下编，所以重启后索引没重建对就会出现重号或断号。
import { writeSync } from 'node:fs';
import { RunStore } from '../../src/store.ts';
import { payload } from './payload.ts';

const [workspace, runId] = process.argv.slice(2) as [string, string];
const store = new RunStore(workspace, runId);
let i = store.listSideEffects().length;
for (;;) {
  i += 1;
  store.recordSideEffect({
    step_id: 's04',
    idempotency_key: `k${i}`,
    evidence: [{ text_present: payload(i), pass: true }],
  });
  writeSync(1, `${i}\n`);
}
