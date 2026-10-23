// 真执行器冒烟（Lab 订单后台 + 登录，真浏览器）：CoreExecutor 上跑完一个小工作流（登录 → 页面与接口抽取 →
// 单次审核），再经命令行（监督进程 + 子进程）跑一遍；服务端状态与运行产物互相对账。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLab, type Lab } from '../../../lab/src/app.ts';
import auth from '../../../lab/src/modules/auth.ts';
import type { Order } from '../../../lab/src/modules/orders/data.ts';
import orders from '../../../lab/src/modules/orders.ts';
import { CHROME, control, loginCookie, SKIP } from '../../../lab/test/helpers.ts';
import { runWorkflow } from '../src/cli.ts';
import { openSession } from '../src/executor.ts';
import { Output } from '../src/output.ts';
import { RunStore } from '../src/store.ts';
import { loadWorkflow } from '../src/workflow.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NAME = 'orders-smoke';
const P = '"pageId":"main"';
const PRE = `"section":"preamble",${P}`;

/** 登录（前置路径）→ 订单列表 → 页面抽取、接口抽取 → 打开一条待审核订单并审核（单次提交）。 */
const STEPS = String.raw`
{"step_id":"open","op":"navigate_page",${PRE},"url":"{{var:base}}/login"}
{"step_id":"user","op":"fill",${PRE},"target":{"css":"#username"},"value":"alice"}
{"step_id":"pass","op":"fill",${PRE},"target":{"css":"#password"},"value":"{{param:password}}"}
{"step_id":"login","op":"click",${PRE},"target":{"css":"#login-btn"},"post":[{"url_matches":"/account$"}]}
{"step_id":"list","op":"navigate_page",${P},"url":"{{var:base}}/orders","post":[{"text_present":"共 200 条"}]}
{"step_id":"dom","op":"extract",${P},"into":"orders","source":{"type":"dom","kind":"table","root":{"css":"#order-table"},"fields":{"id":"td:nth-child(2)"}}}
{"step_id":"wait","op":"wait_for",${P},"until":[{"text_present":"共 200 条"}]}
{"step_id":"api","op":"extract",${P},"into":"raw","source":{"type":"response","url":"/api/orders\\?page_size=500","path":"items"}}
{"step_id":"detail","op":"navigate_page",${P},"url":"{{var:base}}/orders/{{var:order_id}}","post":[{"text_present":"审核通过"}]}
{"step_id":"ask","op":"click",${P},"target":{"role":"button","name":"审核通过"}}
{"step_id":"approve","op":"handle_dialog",${P},"action":"accept","once_only":true,"idempotency_key":"approve-{{var:order_id}}","post":[{"text_present":"已审核 1 条"}]}
`.trim();

/** 命令行子进程（异步：Lab 就在本进程里，不能阻塞事件循环）。 */
const cli = (args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, CHROME_PATH: CHROME }, timeout: 120_000 },
      (e, out, err) => resolve({ code: e ? Number(e.code ?? 1) : 0, out, err }),
    ),
  );

describe('真执行器与命令行', { skip: SKIP }, () => {
  let lab: Lab;
  const dirs: string[] = [];
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** 新工作区：放好工作流和参数库。 */
  function workspace(): string {
    const ws = mkdtempSync(join(tmpdir(), 'obact-executor-'));
    dirs.push(ws);
    const dir = join(ws, 'workflows', NAME);
    mkdirSync(dir, { recursive: true });
    const key = { key: 'id' };
    const meta = {
      name: NAME,
      intercept: ['/api/orders\\?page_size'],
      outputs: { orders: key, raw: key },
    };
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'steps.jsonl'), STEPS);
    writeFileSync(join(ws, 'params.yaml'), 'global:\n  password: alice123\n');
    return ws;
  }

  /** 一个 Lab 空间：选一条待审核订单，返回工作流变量和服务端对账函数。 */
  async function labSpace(space: string) {
    const cookie = await loginCookie(lab, space);
    const list = async (status: string) => {
      const r = await fetch(`${lab.url(space)}/api/orders?status=${status}&page_size=500`, {
        headers: { cookie },
      });
      return ((await r.json()) as { items: Order[] }).items;
    };
    const order_id = ((await list('待审核'))[0] as Order).id;
    const approved = (await list('已审核')).length;
    const verify = async () => {
      const subs = (await control(lab, space).state()).submissions.filter(
        (x) => x.op === 'approve',
      );
      assert.deepEqual(
        subs.map((x) => x.count),
        [1],
        '审核只提交了一次',
      );
      const now = await list('已审核');
      assert.equal(now.length, approved + 1);
      assert.ok(now.some((o) => o.id === order_id));
    };
    return { vars: { base: lab.url(space), order_id }, order_id, verify };
  }

  /** 运行产物对账：side_effects 有这条订单的审核，Output 里有页面抽取与接口抽取的数据。 */
  function checkArtifacts(ws: string, runId: string, order_id: string) {
    const store = new RunStore(ws, runId);
    const cp = store.readCheckpoint();
    assert.equal(cp?.state, 'DONE');
    assert.deepEqual(
      store.listSideEffects().map((x) => x.idempotency_key),
      [`approve-${order_id}`],
    );
    const out = new Output(ws, NAME, String(cp?.cursor?.output_date));
    const ids = (name: string) =>
      readFileSync(out.file(name, 'jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as Order).id);
    const [dom, raw] = [ids('orders'), new Set(ids('raw'))];
    assert.equal(dom.length, 20, '列表第一页 20 行');
    assert.equal(raw.size, 200, '接口一次返回全部 200 条');
    assert.ok(
      dom.every((id) => raw.has(id)),
      '页面抽到的订单都在接口数据里',
    );
  }

  test('runWorkflow：CoreExecutor 上跑完工作流，服务端恰好一次提交', async () => {
    const ws = workspace();
    const s = await labSpace('exec-run');
    const o = { workspace: ws, runId: 'direct', workflow: NAME, chromePath: CHROME, vars: s.vars };
    const r = await runWorkflow(o);
    assert.equal(r.state, 'DONE', JSON.stringify(r.error));
    await s.verify();
    checkArtifacts(ws, 'direct', s.order_id);
  });

  test('CoreExecutor：act 不抛异常、检查项、页面登记、失败现场截图', async () => {
    const ws = workspace();
    const workflow = loadWorkflow(join(ws, 'workflows', NAME));
    const ex = await openSession({ workspace: ws, runId: 'shots', workflow, chromePath: CHROME });
    try {
      const page = ex.mainPage();
      assert.ok(ex.pageOpen(page));
      const miss = await ex.act({
        op: 'click',
        pageId: page,
        target: { css: '#nope' },
        timeout_ms: 300,
      });
      assert.equal(miss.error?.code, 'not_found');
      assert.deepEqual(await ex.check(page, [{ url_matches: 'about:blank' }]), { pass: true });
      const no = await ex.check(page, [{ text_present: '不存在的文字' }]);
      assert.ok(!no.pass && /不存在的文字/.test(no.detail ?? ''));
      const shot = await ex.screenshot(page, 'blank_1');
      assert.ok(shot && existsSync(join(ws, shot)), `截图 ${shot}`);
      assert.equal((await ex.act({ op: 'close_page', pageId: page })).status, 'ok');
      assert.equal(ex.pageOpen(page), false);
    } finally {
      await ex.close();
    }
  });

  test('命令行：obact run 经监督进程跑到 DONE，status、unverified 可查；参数与工作流错误有退出码', async () => {
    const ws = workspace();
    const s = await labSpace('exec-cli');
    const vars = Object.entries(s.vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
    const r = await cli(['run', NAME, '--workspace', ws, '--run-id', 'viacli', ...vars]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    await s.verify();
    checkArtifacts(ws, 'viacli', s.order_id);

    const at = (...a: string[]) => cli([...a, '--workspace', ws]);
    const st = await at('status', 'viacli');
    assert.match(st.out, /状态：DONE/);
    assert.match(st.out, /单次提交成功 1 次；待核实 0 条/);
    assert.match((await at('unverified', 'viacli')).out, /待核实清单为空/);
    assert.match((await at('resume', 'viacli')).out, /已完成/);
    assert.equal((await at('run', NAME, '--run-id', 'viacli')).code, 1, '重名运行');
    assert.equal((await at('run', 'nope')).code, 1, '工作流不存在');
    assert.equal((await cli(['run'])).code, 2, '缺参数');
    assert.equal((await cli(['status', 'viacli', '--bogus'])).code, 2, '未知选项');
  });
});
