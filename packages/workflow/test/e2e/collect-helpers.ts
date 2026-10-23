// 数据采集类 E2E（collect、scroll-api）共用的辅助：写工作区、进程内跑工作流（可挂钩子）、读采集输出、
// 取 Lab 的全量数据。不 import node:test 与 Lab 的测试助手，所以子进程入口 collect-child.ts 也能用。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSession } from '../../src/executor.ts';
import { Output } from '../../src/output.ts';
import { run } from '../../src/runner.ts';
import { RunStore } from '../../src/store.ts';
import type { RunOptions, RunResult, WorkflowMeta } from '../../src/types.ts';
import { loadWorkflow } from '../../src/workflow.ts';

/** Lab 大表的一行（与 lab/src/modules/bigtable.ts 的 Row 一致）。 */
export type LabRow = { id: string; name: string; category: string; price: number; updated: string };

/** 前置路径：登录 Lab。需要变量 base（空间地址）与参数 password。 */
export const LOGIN = [
  { step_id: 'open', op: 'navigate_page', url: '{{var:base}}/login' },
  { step_id: 'user', op: 'fill', target: { css: '#username' }, value: 'alice' },
  { step_id: 'pass', op: 'fill', target: { css: '#password' }, value: '{{param:password}}' },
  {
    step_id: 'login',
    op: 'click',
    target: { css: '#login-btn' },
    post: [{ url_matches: '/account$' }],
  },
].map((s) => ({ ...s, section: 'preamble', pageId: 'main' }));

/** 新工作区（临时目录）：workflows/<name>/ 下放好 workflow.json 与 steps.jsonl，参数库里放登录密码。 */
export function makeWorkspace(name: string, meta: Omit<WorkflowMeta, 'name'>, steps: object[]) {
  const ws = mkdtempSync(join(tmpdir(), 'obact-collect-'));
  const dir = join(ws, 'workflows', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ name, ...meta }));
  writeFileSync(join(dir, 'steps.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n'));
  writeFileSync(join(ws, 'params.yaml'), 'global:\n  password: alice123\n');
  return ws;
}

export type FlowOptions = {
  workspace: string;
  runId: string;
  name: string;
  vars?: Record<string, unknown>;
  resume?: boolean;
  hooks?: RunOptions['hooks'];
  chromePath?: string;
};

/** 进程内跑一个工作流（与 cli.ts 的 runWorkflow 同样的组装，但能挂 hooks）；浏览器随运行结束关闭。 */
export async function runFlow(o: FlowOptions): Promise<RunResult> {
  const workflow = loadWorkflow(join(o.workspace, 'workflows', o.name));
  const executor = await openSession({ ...o, workflow });
  try {
    return await run(workflow, executor, { ...o, mode: 'headless' });
  } finally {
    await executor.close();
  }
}

/** 一次运行的采集输出文件（日期目录取自检查点）。 */
export function outputFile(
  workspace: string,
  runId: string,
  name: string,
  out: string,
  ext = 'jsonl',
) {
  const date = String(new RunStore(workspace, runId).readCheckpoint()?.cursor?.output_date);
  return new Output(workspace, name, date).file(out, ext as 'jsonl');
}

/** 读文件的非空行。 */
export const lines = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l !== '');

/** Lab 服务端的全量数据（/api/rows，每次最多取 1000 行）。cookie 是已登录会话。 */
export async function labRows(base: string, cookie: string): Promise<LabRow[]> {
  const all: LabRow[] = [];
  for (let total = 1; all.length < total; ) {
    const r = await fetch(`${base}/api/rows?offset=${all.length}&limit=1000`, {
      headers: { cookie },
    });
    const d = (await r.json()) as { rows: LabRow[]; total: number };
    if (d.rows.length === 0) break;
    all.push(...d.rows);
    total = d.total;
  }
  return all;
}

/**
 * 清掉用这个工作区的浏览器配置目录启动、却成了孤儿的 Chrome（进程组整体 SIGKILL）。
 * 运行子进程被 SIGKILL 后，puppeteer 起的 Chrome 自成进程组，监督进程清扫子进程组时清不到它，会一直留着。
 * 只在有 /proc 的系统上生效（其余系统什么也不做）。
 */
export function killStrayBrowsers(workspace: string): void {
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {}
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes(`--user-data-dir=${workspace}`)) process.kill(-Number(pid), 'SIGKILL');
    } catch {}
  }
}
