// E2E 的公共部分（orders、kill-resume、multipage 三个用例共用）：工作区、监督进程下跑子进程、订单取数与服务端对账。
// 判据一律以 Lab 服务端（_lab/state）为准：Lab 的幂等键是页面每次提交随机生成的（重做会换新键），
// 所以按提交载荷里的对象（订单号、服务器编号）汇总，同一对象收到几次请求就是几次提交。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lab } from '../../../../lab/src/app.ts';
import type { Order } from '../../../../lab/src/modules/orders/data.ts';
import { CHROME, control, loginCookie } from '../../../../lab/test/helpers.ts';
import { sweepBrowser } from '../../src/executor.ts';
import { RunStore } from '../../src/store.ts';
import { type SupervisorEvent, superviseRun } from '../../src/supervisor.ts';

export const NAME = 'orders-audit';
/** 订单批量审核的条数；单次运行超过 2 分钟就降到 200。 */
export const BATCH = 500;

const P = '"pageId":"main"';
const PRE = `"section":"preamble",${P}`;
/** 前置路径（登录）→ 循环：打开详情页 → 点“审核通过”（弹确认框）→ 接受确认框（单次提交，后置检查页面提示；检查等 5 秒默认超时）。 */
const STEPS = `
{"step_id":"open","op":"navigate_page",${PRE},"url":"{{param:base}}/login"}
{"step_id":"user","op":"fill",${PRE},"target":{"css":"#username"},"value":"alice"}
{"step_id":"pass","op":"fill",${PRE},"target":{"css":"#password"},"value":"{{param:password}}"}
{"step_id":"login","op":"click",${PRE},"target":{"css":"#login-btn"},"post":[{"url_matches":"/account$"}]}
{"step_id":"loop","op":"loop_begin","over":"{{file:inputs/orders.json}}","as":"order","key":"{{var:order.id}}","anchor":[{"url_matches":"/account$"}]}
{"step_id":"detail","op":"navigate_page",${P},"url":"{{param:base}}/orders/{{var:order.id}}","post":[{"text_present":"审核通过"}]}
{"step_id":"ask","op":"click",${P},"target":{"role":"button","name":"审核通过"}}
{"step_id":"approve","op":"handle_dialog",${P},"action":"accept","once_only":true,"idempotency_key":"audit:{{var:order.id}}","post":[{"text_present":"已审核 1 条"}]}
{"step_id":"end","op":"loop_end"}
`.trim();

const dirs: string[] = [];
export const cleanup = () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};

/** 新工作区：放好工作流（steps.jsonl 的文本）与参数库（global 下的键值）。 */
export function workspace(name: string, steps: string, params: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), 'obact-e2e-'));
  dirs.push(ws);
  const dir = join(ws, 'workflows', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'steps.jsonl'), steps);
  const yaml = Object.entries(params).map(([k, v]) => `  ${k}: ${v}`);
  writeFileSync(join(ws, 'params.yaml'), `global:\n${yaml.join('\n')}\n`);
  return ws;
}

/** 击杀点，见 child.ts。 */
export type Kill = { at: string; nth: number };
const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

/**
 * 在监督进程下跑工作流（运行 id 固定为 r）：子进程 child.ts 按 kills 依次自杀，监督进程以续跑模式拉起；
 * 校验“每个击杀点各杀一次、最后一次正常退出”，返回运行结束时的检查点状态。
 */
export async function supervised(ws: string, workflow: string, kills: Kill[], skip = false) {
  const cfg = { workspace: ws, runId: 'r', workflow, chromePath: CHROME, kills };
  const events: SupervisorEvent[] = [];
  const out = await superviseRun({
    command: [process.execPath, ...process.execArgv, CHILD],
    env: { OBACT_E2E: JSON.stringify({ ...cfg, ...(skip && { onUnverified: 'skip' }) }) },
    heartbeatFile: join(ws, 'runs', 'r', 'heartbeat'),
    heartbeatTimeoutMs: 20_000,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'exit') sweepBrowser(ws, 'r', e.pid); // 与命令行一致：子进程被杀后清扫它的浏览器
    },
  });
  const signals = events.flatMap((e) => (e.type === 'exit' ? [e.signal] : []));
  const want = [...kills.map(() => 'SIGKILL'), null];
  assert.deepEqual(signals, want, `每个击杀点各杀一次：${JSON.stringify(kills)}`);
  assert.equal(out.restarts, kills.length);
  return new RunStore(ws, 'r').readCheckpoint()?.state;
}

/** 重置 Lab 空间为 total 条订单，取其中待审核的前 n 条订单号（按订单号升序）。 */
export async function pendingOrders(lab: Lab, space: string, total: number, n: number) {
  await control(lab, space).reset({ orders: total });
  const cookie = await loginCookie(lab, space);
  const q = `status=${encodeURIComponent('待审核')}&sort=id&dir=asc&page_size=${n}`;
  const r = await fetch(`${lab.url(space)}/api/orders?${q}`, { headers: { cookie } });
  const ids = ((await r.json()) as { items: Order[] }).items.map((o) => o.id);
  assert.equal(ids.length, n, '待审核订单不够');
  return ids;
}

/** 新工作区：审核工作流、参数库（Lab 地址与密码）、待审核订单清单（inputs/orders.json）。 */
export function auditWorkspace(lab: Lab, space: string, ids: string[]): string {
  const ws = workspace(NAME, STEPS, { password: 'alice123', base: lab.url(space) });
  mkdirSync(join(ws, 'files', 'inputs'), { recursive: true });
  writeFileSync(
    join(ws, 'files', 'inputs', 'orders.json'),
    JSON.stringify(ids.map((id) => ({ id }))),
  );
  return ws;
}

/** 服务端视角：每个订单收到的审核请求数、被审核接口改过状态的订单（按先后）。 */
export async function serverView(lab: Lab, space: string) {
  const st = await control(lab, space).state();
  const hits = new Map<string, number>();
  for (const s of st.submissions) {
    if (s.op !== 'approve') continue;
    for (const id of (s.payload as { ids: string[] }).ids)
      hits.set(id, (hits.get(id) ?? 0) + s.count);
  }
  return { hits, changed: (st.modules.orders as { changed_ids: string[] }).changed_ids };
}
export type View = Awaited<ReturnType<typeof serverView>>;

/**
 * 引擎产物（side_effects.jsonl、unverified.jsonl）与服务端互相对账，返回 { done, unv }（订单号，按记录先后）：
 * 服务端每个订单至多一次提交；落库的订单要么引擎确认完成、要么在待核实清单里；引擎确认完成的服务端一定已落库。
 */
export function reconcile(ws: string, runId: string, v: View) {
  const store = new RunStore(ws, runId);
  const ids = (keys: string[]) => keys.map((k) => k.replace(/^audit:/, ''));
  const done = ids(store.listSideEffects().map((x) => x.idempotency_key));
  const unv = ids(store.listUnverified().map((x) => x.idempotency_key));
  assert.equal(new Set(done).size + new Set(unv).size, done.length + unv.length, '引擎记录无重复');
  assert.deepEqual(
    done.filter((id) => unv.includes(id)),
    [],
    '确认完成与待核实互斥',
  );
  assert.deepEqual(
    [...v.hits].filter(([, n]) => n !== 1),
    [],
    '服务端每个订单至多一次提交',
  );
  assert.deepEqual([...v.hits.keys()].sort(), [...v.changed].sort(), '提交过的订单都落库一次');
  const committed = [...v.hits.keys()];
  assert.deepEqual(
    committed.filter((id) => !done.includes(id) && !unv.includes(id)),
    [],
    '服务端没有引擎不知道的提交',
  );
  assert.deepEqual(
    done.filter((id) => !v.hits.has(id)),
    [],
    '确认完成的订单服务端都已落库',
  );
  return { done, unv };
}
