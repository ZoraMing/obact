#!/usr/bin/env node
// 命令行：obact run / resume / status / unverified（工作区目录见 PRD 7.6）。
//
// run、resume：本进程当监督进程，用同一个入口加 --child 拉起运行子进程，崩溃（退出码非 0、被杀、心跳超时）后
// 监督进程以 OBACT_RESUME=1 重启，子进程从检查点续跑。子进程只要跑到了结局（DONE、FAILED、STOPPED、
// NEED_HUMAN）退出码就是 0，否则会被当作崩溃重启；命令行本身的退出码由父进程按检查点状态换算。
import '../../../tools/env.ts';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertAccountName, ObactError, resolveChromePath } from '@obact/core';
import { openSession, sweepBrowser } from './executor.ts';
import { acquireLock, LockedError } from './lock.ts';
import { run } from './runner.ts';
import { RunStore } from './store.ts';
import { startHeartbeat, superviseRun } from './supervisor.ts';
import type { RunEvents, RunOptions, RunResult, Workflow } from './types.ts';
import { assertWorkflowName, loadWorkflow } from './workflow.ts';

const USAGE = `用法：
  obact run <工作流> [--workspace DIR] [--run-id ID] [--headed] [--chrome PATH] [--on-unverified stop|skip] [--var k=v]...
  obact resume <run-id> [--workspace DIR] [--headed] [--chrome PATH] [--on-unverified stop|skip]
  obact status <run-id> [--workspace DIR]
  obact unverified <run-id> [--workspace DIR]`;

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      'run-id': { type: 'string' },
      headed: { type: 'boolean' },
      chrome: { type: 'string' },
      'on-unverified': { type: 'string' },
      var: { type: 'string', multiple: true },
      child: { type: 'boolean' }, // 内部用：作为运行子进程
    },
  });
type Flags = ReturnType<typeof parse>['values'];

/** 命令行写法不对：打印用法，退出码 2。 */
class UsageError extends Error {}

/** 检查点状态 → 退出码（其余按 1）；熔断 5，运行被另一个进程占用 6，被 Ctrl-C 中断 130。 */
const EXIT: Record<string, number> = { DONE: 0, FAILED: 1, STOPPED: 3, NEED_HUMAN: 4 };
const LOCKED = 6;

export type RunWorkflowOptions = {
  workspace: string;
  runId: string;
  /** 工作流名（workflows/<名>）；续跑时可省略，取检查点里的。 */
  workflow?: string;
  /** 从检查点续跑。 */
  resume?: boolean;
  /** 缺省取检查点的，再取工作流的，再缺省 headless。 */
  mode?: 'headed' | 'headless';
  chromePath?: string;
  onUnverified?: 'stop' | 'skip';
  vars?: Record<string, unknown>;
  events?: RunEvents;
  /** 测试用：每步前后调用，可抛异常模拟崩溃（透传给 run）。 */
  hooks?: RunOptions['hooks'];
};

/** 按名字加载 workflows/<名>：名字必须是安全名，且与 workflow.json 的 name 一致。 */
function loadNamed(workspace: string, name: string): Workflow {
  assertWorkflowName(name);
  const workflow = loadWorkflow(join(workspace, 'workflows', name));
  if (workflow.name !== name) {
    throw new ObactError('invalid_params', `目录名与 name 不一致：${name} / ${workflow.name}`);
  }
  return workflow;
}

/** 子进程的主体：加载工作流 → 启动浏览器 → 运行 → 关闭浏览器。 */
export async function runWorkflow(o: RunWorkflowOptions): Promise<RunResult> {
  const cp = o.resume ? new RunStore(o.workspace, o.runId).readCheckpoint() : null;
  const name = o.workflow ?? cp?.workflow;
  if (!name) throw new ObactError('invalid_params', `没有可续跑的检查点：${o.runId}`);
  const workflow = loadNamed(o.workspace, name);
  const mode = o.mode ?? cp?.mode ?? workflow.meta.mode ?? 'headless';
  const executor = await openSession({ ...o, workflow, mode });
  try {
    return await run(workflow, executor, { ...o, mode });
  } finally {
    await executor.close();
  }
}

const heartbeatFile = (workspace: string, runId: string) =>
  join(workspace, 'runs', runId, 'heartbeat');

function parseVars(list: string[] = []): Record<string, string> {
  return Object.fromEntries(
    list.map((s) => {
      if (s.indexOf('=') < 1) throw new UsageError(`--var 要写成 k=v：${s}`);
      return [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)];
    }),
  );
}

/** 终止信号 → 退出码（128 + 信号编号）。 */
const SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const;

/** 运行子进程：事件打印到 stderr，退出码恒为 0（运行失败也是 0，见文件头）。 */
async function child(o: RunWorkflowOptions): Promise<number> {
  startHeartbeat(heartbeatFile(o.workspace, o.runId));
  // 收到终止信号：浏览器自成进程组，进程一走它就成孤儿，所以先同步清扫再立即退出。不写检查点：
  // 这等价于崩溃，续跑时按检查点里的在途键判定，不会留下“浏览器没了却 NEED_HUMAN”的状态
  for (const [sig, code] of SIGNALS) {
    process.on(sig, () => {
      sweepBrowser(o.workspace, o.runId, process.pid);
      process.exit(code);
    });
  }
  const events: RunEvents = {
    need_human: (e) => console.error(`需要人工处理：${e.step_id}（${e.reason}）${e.message ?? ''}`),
    unverified: (e) => console.error(`状态未明：${e.idempotency_key}（${e.reason}）`),
  };
  let r: RunResult;
  try {
    r = await runWorkflow({ ...o, events });
  } catch (e) {
    // 有分类的错误（账号被占用、账号名不合法等）重启也不会好：报错后正常退出，退出码由父进程按检查点换算
    if (!(e instanceof ObactError)) throw e;
    console.error(`错误：${e.message}`);
    return 0;
  }
  if (r.error) console.error(`${r.state}：${r.error.step_id} ${r.error.code}：${r.error.message}`);
  return 0;
}

/** run / resume。父进程先把能确定的错误挡在这里，免得子进程反复崩溃重启。 */
async function start(cmd: 'run' | 'resume', target: string, v: Flags, rest: string[]) {
  const workspace = resolve(v.workspace ?? process.cwd());
  const stamp = new Date().toISOString().replace(/[-:]|\..*/g, '');
  const runId = cmd === 'resume' ? target : (v['run-id'] ?? `${target.slice(0, 40)}-${stamp}`);
  const mode = v['on-unverified'];
  if (mode !== undefined && mode !== 'stop' && mode !== 'skip') {
    throw new UsageError('--on-unverified 只能是 stop 或 skip');
  }
  const store = new RunStore(workspace, runId);
  const cp = store.readCheckpoint();
  const opts: RunWorkflowOptions = {
    workspace,
    runId,
    workflow: cmd === 'run' ? target : undefined,
    mode: v.headed ? 'headed' : process.env.HEADED === '1' ? 'headed' : undefined,
    chromePath: v.chrome,
    onUnverified: mode,
    vars: parseVars(v.var),
  };
  if (v.child) {
    return child({
      ...opts,
      resume: cmd === 'resume' || (process.env.OBACT_RESUME === '1' && !!cp),
    });
  }

  if (cmd === 'resume' && !cp)
    throw new ObactError('invalid_params', `没有可续跑的检查点：${runId}`);
  if (cmd === 'run' && cp)
    throw new ObactError('invalid_params', `运行 ${runId} 已存在，用 obact resume 续跑`);
  if (cp?.state === 'DONE') {
    console.log(`运行 ${runId} 已完成`);
    return 0;
  }
  // 预检：下面这些错误重启也不会好，在这里挡住，不拉起子进程
  const workflow = loadNamed(workspace, cp?.workflow ?? target);
  assertAccountName(workflow.meta.account ?? 'default');
  const chrome = resolveChromePath(v.chrome);
  try {
    if (!statSync(chrome).isFile()) throw new Error('不是文件');
    accessSync(chrome, constants.X_OK);
  } catch {
    throw new ObactError('invalid_params', `浏览器不存在或不可执行：${chrome}`);
  }
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (
    (opts.mode ?? cp?.mode ?? workflow.meta.mode) === 'headed' &&
    process.platform === 'linux' &&
    !display
  ) {
    throw new ObactError(
      'invalid_params',
      '有头模式（--headed）需要图形环境：没有设置 DISPLAY（无显示器的 Linux 请先启动 Xvfb 并设置 DISPLAY，或改用无头）',
    );
  }

  // 运行锁：同一个运行同一时刻只能有一个监督进程，否则两个子进程会写同一个运行目录、互相清扫对方的浏览器
  const release = acquireLock(join(store.dir, 'run.lock'), `运行 ${runId}`);
  try {
    const tail = [
      '--workspace',
      workspace,
      ...(cmd === 'run' ? ['--run-id', runId] : []),
      '--child',
    ];
    let childPid = 0;
    const sup = superviseRun({
      command: [
        process.execPath,
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        cmd,
        ...rest,
        ...tail,
      ],
      heartbeatFile: heartbeatFile(workspace, runId),
      onEvent: (e) => {
        if (e.type === 'start') childPid = e.pid;
        if (e.type === 'exit') sweepBrowser(workspace, runId, e.pid); // 子进程被杀时浏览器会成孤儿
        if (e.type === 'restart')
          console.error(`子进程崩溃（${e.reason}），第 ${e.restarts} 次重启并续跑`);
      },
    });
    // 第一次信号走优雅停止（SIGHUP 同 SIGTERM）；第二次直接强退：supervisor 的 exit 钩子 SIGKILL 子进程组，
    // 这里再清扫它的浏览器、放运行锁，不留孤儿
    let signalled = false;
    process.once('exit', () => {
      sweepBrowser(workspace, runId, childPid);
      release();
    });
    for (const [sig] of SIGNALS) {
      process.on(sig, () => {
        if (signalled) process.exit(130);
        signalled = true;
        void sup.stop();
      });
    }
    const out = await sup;
    const end = store.readCheckpoint();
    if (end) status(workspace, runId);
    if (out.state === 'TRIPPED')
      console.error(`1 小时内崩溃超过 3 次，不再拉起；修好后可 obact resume ${runId}`);
    if (out.state === 'STOPPED') console.error(`已中断，可用 obact resume ${runId} 续跑`);
    if (end?.state === 'STOPPED' || end?.state === 'NEED_HUMAN') {
      console.error(
        `处理后可 obact resume ${runId} 续跑（状态未明的条目见 obact unverified ${runId}）`,
      );
    }
    return out.state === 'TRIPPED'
      ? 5
      : out.state === 'STOPPED'
        ? 130
        : (EXIT[end?.state ?? ''] ?? 1);
  } finally {
    release();
  }
}

/** 已有运行的存储与检查点；没有就报错。 */
function open(workspace: string, runId: string) {
  const store = new RunStore(workspace, runId);
  const cp = store.readCheckpoint();
  if (!cp) throw new ObactError('invalid_params', `找不到运行：${runId}`);
  return { store, cp };
}

/** 打印检查点状态、步骤与统计（统计来自 steps.log 与单次提交记录）。 */
function status(workspace: string, runId: string): number {
  const { store, cp } = open(workspace, runId);
  const counts: Record<string, number> = {};
  try {
    for (const line of readFileSync(store.stepsLogPath, 'utf8').split('\n')) {
      const s = line.split('\t')[3];
      if (s) counts[s] = (counts[s] ?? 0) + 1;
    }
  } catch {}
  const loops = Object.entries(cp.loop_index ?? {}).map(([k, i]) => `${k}=${i}`);
  const todo = store.listUnverified({ unresolved: true }).length;
  const n = (k: string) => counts[k] ?? 0;
  console.log(
    [
      `运行 ${runId}（工作流 ${cp.workflow}，${cp.mode}）`,
      `状态：${cp.state}  步骤：${cp.step_id}${loops.length ? `  循环：${loops.join(' ')}` : ''}`,
      `检查点：第 ${cp.seq} 次，${cp.updated_at}`,
      `统计：执行 ${n('ok') + n('error') + n('skipped')} 步（ok ${n('ok')}，error ${n('error')}，skipped ${n('skipped')}）；` +
        `单次提交成功 ${store.listSideEffects().length} 次；待核实 ${store.listUnverified().length} 条（未核实 ${todo}）`,
    ].join('\n'),
  );
  return 0;
}

/** 打印待核实清单：幂等键、步骤、原因、时间、核实状态、截图。 */
function unverified(workspace: string, runId: string): number {
  const list = open(workspace, runId).store.listUnverified();
  if (list.length === 0) console.log('待核实清单为空');
  for (const r of list) {
    const state = r.resolution ? `已核实（${r.resolution.outcome}）` : '未核实';
    console.log(
      [r.idempotency_key, r.step_id, r.reason, r.time, state, r.screenshot ?? ''].join('\t'),
    );
  }
  return 0;
}

/** 命令分发；返回退出码。 */
export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    const { values, positionals } = parse(rest);
    const [target, ...extra] = positionals;
    if (!target || extra.length > 0) throw new UsageError('缺少参数或参数过多');
    const ws = resolve(values.workspace ?? process.cwd());
    if (cmd === 'status') return status(ws, target);
    if (cmd === 'unverified') return unverified(ws, target);
    if (cmd === 'run' || cmd === 'resume') return await start(cmd, target, values, rest);
    throw new UsageError(`未知命令：${cmd}`);
  } catch (e) {
    console.error(`错误：${(e as Error).message}`);
    const usage =
      e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    if (usage) console.error(USAGE);
    return usage ? 2 : e instanceof LockedError ? LOCKED : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
