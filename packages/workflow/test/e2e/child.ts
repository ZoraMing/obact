// 杀进程用例的运行子进程（由监督进程拉起）：调用 runWorkflow，按计划在确定的时刻 SIGKILL 自己。
// 配置在环境变量 OBACT_E2E（JSON）。kills 是按顺序的击杀点 [{ at, nth }]：第 k 次启动的进程执行第 k 个
// （已执行次数记在工作区的 kills.log，每次一个字符）；nth 是本进程内第几次到达该时刻时动手，
// 续跑后的进程从被打断的那一条重做起算。at 的取值：
//   before:<步骤> / after:<步骤>  runner 每步之前 / 之后（hooks）
//   unsent    单次提交（once_only）步骤的动作交给浏览器之前（已写检查点，动作还没发出）
//   sent      单次提交的动作返回之后、runner 记 side effect 之前（动作已发出且生效，留痕还没写）
//   recorded  side effect 写入之后、检查点推进之前
// 不改生产代码：只在本进程里包装 CoreExecutor.act 与 RunStore.recordSideEffect。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWorkflow } from '../../src/cli.ts';
import { CoreExecutor } from '../../src/executor.ts';
import { RunStore } from '../../src/store.ts';
import { startHeartbeat } from '../../src/supervisor.ts';
import type { Action, Step } from '../../src/types.ts';

const cfg = JSON.parse(process.env.OBACT_E2E ?? 'null') as {
  workspace: string;
  runId: string;
  workflow: string;
  chromePath: string;
  onUnverified?: 'stop' | 'skip';
  kills: { at: string; nth: number }[];
};
const killLog = join(cfg.workspace, 'kills.log');
const plan = cfg.kills[existsSync(killLog) ? readFileSync(killLog, 'utf8').length : 0];
let reached = 0;
const strike = (at: string): void => {
  if (plan?.at !== at || ++reached !== plan.nth) return;
  appendFileSync(killLog, 'x');
  process.kill(process.pid, 'SIGKILL');
};

let once = false; // 正在执行的是不是单次提交步骤
const act = CoreExecutor.prototype.act;
CoreExecutor.prototype.act = async function (this: CoreExecutor, a: Action) {
  if (once) strike('unsent');
  const r = await act.call(this, a);
  if (once) strike('sent');
  return r;
};
const record = RunStore.prototype.recordSideEffect;
RunStore.prototype.recordSideEffect = function (this: RunStore, rec) {
  const r = record.call(this, rec);
  strike('recorded');
  return r;
};

const { workspace, runId } = cfg;
startHeartbeat(join(workspace, 'runs', runId, 'heartbeat'), 500);
const opts = {
  workspace,
  runId,
  workflow: cfg.workflow,
  chromePath: cfg.chromePath,
  onUnverified: cfg.onUnverified,
  // 监督进程重启时带 OBACT_RESUME=1；检查点还没写出来（启动阶段就被杀）则重新开始
  resume: process.env.OBACT_RESUME === '1' && !!new RunStore(workspace, runId).readCheckpoint(),
  hooks: {
    beforeStep: (s: Step) => {
      once = !!s.once_only;
      strike(`before:${s.step_id}`);
    },
    afterStep: (s: Step) => strike(`after:${s.step_id}`),
  },
};
const r = await runWorkflow(opts);
console.error(`子进程结束：${r.state} ${r.error?.code ?? ''}`);
process.exit(0); // 跑到结局（含 STOPPED）退出码都是 0，否则监督进程会当作崩溃重启
