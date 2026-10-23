// 子进程：模拟采集任务，从第 0 批开始一批批追加（已写过的批次会被主键去重跳过），直到被测试 SIGKILL。
// 参数：工作区 任务名 日期。每批结束同步输出一行“批号 实际写入行数”。
// 每行带一大块文本（整批上百 KB），增加写到一半被打断的机会。
import { writeSync } from 'node:fs';
import { Output } from '../../src/output.ts';

export const ROWS_PER_BATCH = 10;

export function batch(b: number): { id: number; text: string }[] {
  return Array.from({ length: ROWS_PER_BATCH }, (_, i) => {
    const id = b * ROWS_PER_BATCH + i;
    return { id, text: `${id}:${'x'.repeat(16 * 1024)}` };
  });
}

if (process.argv[1]?.endsWith('append-writer.ts')) {
  const [workspace, task, date] = process.argv.slice(2) as [string, string, string];
  const out = new Output(workspace, task, date);
  for (let b = 0; ; b++) {
    const { written } = out.append('orders', batch(b), { key: 'id' });
    writeSync(1, `${b} ${written}\n`);
  }
}
