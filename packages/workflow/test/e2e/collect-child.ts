// 运行子进程的薄入口（collect 用例）：由 superviseRun 拉起，用法 collect-child.ts <工作区> <run-id> <工作流名>。
// 环境变量：OBACT_E2E_VARS（JSON，工作流变量）、OBACT_E2E_KILL（"步骤:n"，首次启动时第 n 次执行完该步骤就 SIGKILL 自己，
// 用来在确定的位置模拟崩溃；监督进程重启时 OBACT_RESUME=1，不再自杀）。不依赖生产代码里的任何测试开关。
import { join } from 'node:path';
import { RunStore } from '../../src/store.ts';
import { startHeartbeat } from '../../src/supervisor.ts';
import { runFlow } from './collect-helpers.ts';

const [workspace, runId, name] = process.argv.slice(2) as [string, string, string];
const [killStep, killNth] = (process.env.OBACT_E2E_KILL ?? ':0').split(':');
const resumed = process.env.OBACT_RESUME === '1';
let done = 0;

startHeartbeat(join(workspace, 'runs', runId, 'heartbeat'), 500);
const r = await runFlow({
  workspace,
  runId,
  name,
  vars: JSON.parse(process.env.OBACT_E2E_VARS ?? '{}'),
  resume: resumed && new RunStore(workspace, runId).readCheckpoint() !== null,
  hooks: {
    afterStep(step) {
      if (!resumed && step.step_id === killStep && ++done === Number(killNth)) {
        process.kill(process.pid, 'SIGKILL');
      }
    },
  },
});
// 跑到结局（含失败）退出码都是 0，与 cli.ts 一致，否则监督进程会当作崩溃重启
if (r.error) console.error(`${r.state}：${r.error.step_id} ${r.error.code}：${r.error.message}`);
