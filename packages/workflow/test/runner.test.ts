// 工作流 runner（FR-16~19、FR-25、FR-26、FR-37）：用假执行器测逻辑，不开浏览器。
// 崩溃用假执行器抛不带 code 的异常模拟（进程死亡），续跑用同一个工作区、同一个 run_id 再调用 run。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { run } from '../src/runner.ts';
import { RunStore } from '../src/store.ts';
import type { RunEvents, RunOptions, Step, Workflow } from '../src/types.ts';
import { FakeExecutor, type Reply } from './fake-executor.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'obact-runner-'));
  dirs.push(d);
  return d;
}

// ---------- 步骤与工作流的简写 ----------

const step = (id: string, op: string, extra: object = {}) => ({ step_id: id, op, ...extra });
const click = (id: string, css: string, extra: object = {}) =>
  step(id, 'click', { pageId: 'p1', target: { css }, ...extra });
const fill = (id: string, css: string, value: string, extra: object = {}) =>
  step(id, 'fill', { pageId: 'p1', target: { css }, value, ...extra });
const loop = (id: string, over: unknown, as: string, extra: object = {}) =>
  step(id, 'loop_begin', { over, as, ...extra });
const END = step('le', 'loop_end');
const pay = (id: string, css: string, key: string, extra: object = {}) =>
  click(id, css, { once_only: true, idempotency_key: key, ...extra });

/** 在工作区里放一个可被 call 的子工作流。 */
function child(ws: string, name: string, steps: object[]): void {
  const dir = join(ws, 'workflows', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ name }));
  writeFileSync(join(dir, 'steps.jsonl'), steps.map((x) => JSON.stringify(x)).join('\n'));
}

type Setup = {
  meta?: object;
  fake?: FakeExecutor;
  ws?: string;
  params?: string;
  opts?: Partial<RunOptions>;
};

/** 跑一遍；返回结果、假执行器、记录到的事件、运行存储和检查点。 */
async function go(steps: object[], o: Setup = {}) {
  const ws = o.ws ?? tmp();
  if (o.params) writeFileSync(join(ws, 'params.yaml'), o.params);
  const fake = o.fake ?? new FakeExecutor();
  const ev = { step: [] as unknown[], need_human: [] as unknown[], unverified: [] as unknown[] };
  const events: RunEvents = {
    step: (e) => ev.step.push(e),
    need_human: (e) => ev.need_human.push(e),
    unverified: (e) => ev.unverified.push(e),
  };
  const meta = { name: 't', ...o.meta };
  const wf = { name: 't', dir: '', meta, steps: steps as Step[], signatures: [], rules: [] };
  const opts = { runId: 'r1', workspace: ws, events, ...o.opts };
  const result = await run(wf as Workflow, fake, opts);
  const store = new RunStore(ws, 'r1');
  return { result, fake, ev, ws, store, cp: store.readCheckpoint() };
}

/** 模拟崩溃：run 抛出不带 code 的异常，检查点停在崩溃前最后一次写入处。 */
const crashes = (steps: object[], o: Setup) => assert.rejects(go(steps, o), /crash/);
const resume = (steps: object[], ws: string, o: Setup = {}) =>
  go(steps, { ...o, ws, opts: { ...o.opts, resume: true } });

// ---------- 控制流、重试与失败处理、留痕 ----------

describe('控制流与失败处理', () => {
  test('嵌套循环、if / else、break、set_var', async () => {
    const { result, fake } = await go([
      step('v', 'set_var', { name: 'list', value: [1, 2] }),
      loop('l1', '{{var:list}}', 'x'),
      loop('l2', ['a', 'b', 'c'], 'y'),
      click('c', '#c-{{var:x}}-{{var:y}}'),
      step('i', 'if', { value: '{{var:y}}', equals: 'b' }),
      step('b', 'break'),
      step('e', 'else'),
      click('t', '#e-{{var:x}}-{{var:y}}'),
      step('f', 'end_if'),
      step('l3', 'loop_end'),
      click('d', '#done-{{var:x}}'),
      step('l4', 'loop_end'),
    ]);
    assert.equal(result.state, 'DONE');
    const one = ['#c-1-a', '#e-1-a', '#c-1-b', '#done-1'];
    assert.deepEqual(fake.keys(), [...one, ...one.map((k) => k.replace('1', '2'))]);
  });

  test('if 用检查项判断；空循环不进入循环体', async () => {
    const fake = new FakeExecutor();
    fake.checkPass = (_p, checks) => JSON.stringify(checks).includes('yes');
    const ifOf = (id: string, text: string) =>
      step(id, 'if', { pageId: 'p1', checks: [{ text_present: text }] });
    await go(
      [step('t', 'set_var', { name: 't', value: 'yes' }), ifOf('i1', '{{var:t}}')]
        .concat([click('a', '#a'), step('e1', 'end_if')])
        .concat([ifOf('i2', 'no'), click('b', '#b'), step('e2', 'end_if')])
        .concat([loop('l', [], 'x'), click('c', '#c'), END, click('d', '#d')]),
      { fake },
    );
    assert.deepEqual(fake.keys(), ['#a', '#d']);
  });

  // 重试次数与三种 on_fail（缺省 human）：[说明, 步骤字段, 回复, 状态, #a 调用数, #b 调用数]
  const failCases: [string, object, string[], string, number, number][] = [
    ['retry 2 后成功', { retry: { max: 2 } }, ['timeout', 'timeout', 'ok'], 'DONE', 3, 1],
    ['retry 用尽 + stop', { retry: { max: 2 }, on_fail: 'stop' }, ['timeout'], 'FAILED', 3, 0],
    ['skip：记录并继续', { on_fail: 'skip' }, ['not_found'], 'DONE', 1, 1],
    ['human', { on_fail: 'human' }, ['not_found'], 'NEED_HUMAN', 1, 0],
    ['缺省即 human', {}, ['obscured'], 'NEED_HUMAN', 1, 0],
  ];
  for (const [name, extra, replies, state, calls, next] of failCases) {
    test(`失败处理：${name}`, async () => {
      const fake = new FakeExecutor().plan('#a', ...replies);
      const { result, ev, cp } = await go([click('s1', '#a', extra), click('s2', '#b')], { fake });
      assert.deepEqual([result.state, cp?.state], [state, state]);
      assert.deepEqual([fake.count('#a'), fake.count('#b')], [calls, next]);
      assert.equal(ev.need_human.length, state === 'NEED_HUMAN' ? 1 : 0);
      if (state === 'NEED_HUMAN') assert.equal(cp?.step_id, 's1', '续跑从失败的步骤重做');
      if (name.startsWith('skip'))
        assert.deepEqual([result.stats.failed, result.stats.skipped], [1, 1]);
    });
  }

  test('pre 前置检查不通过：不执行动作，按失败处理', async () => {
    const fake = new FakeExecutor();
    fake.checkPass = () => false;
    const { result } = await go([click('s1', '#a', { pre: [{ url_matches: '/o' }] })], { fake });
    assert.deepEqual([result.state, result.error?.code], ['NEED_HUMAN', 'assertion_failed']);
    assert.equal(fake.acts.length, 0);
  });

  test('call：以 args 为初始变量，共用执行器；失败向上传递', async () => {
    const ws = tmp();
    child(ws, 'login', [click('c1', '#user-{{var:name}}')]);
    child(ws, 'broken', [click('b1', '#broken', { on_fail: 'stop' })]);
    const call = (workflow: string, extra: object = {}) =>
      step('k', 'call', { workflow, ...extra });
    const ok = await go([call('login', { args: { name: 'amy' } }), click('s2', '#next')], { ws });
    assert.deepEqual(ok.fake.keys(), ['#user-amy', '#next']);
    const fake = new FakeExecutor().plan('#broken', 'not_found');
    const bad = await go([call('broken'), click('s2', '#next')], { ws, fake });
    assert.deepEqual(
      [bad.result.state, bad.result.step_id, bad.result.error?.step_id],
      ['FAILED', 'k', 'b1'],
    );
    const gone = await go([call('nope', { on_fail: 'stop' })], { ws });
    assert.equal(gone.result.error?.code, 'invalid_params');
  });

  test('敏感变量的标记按工作流环境隔离：子工作流里同名的非敏感 set_var 不会清掉根工作流的标记；敏感实参传给子工作流仍打码', async () => {
    const ws = tmp();
    const params = 'global:\n  api_token: tok-999\n  password: hunter2\n';
    child(ws, 'plain', [step('s1', 'set_var', { name: 'tok', value: 'plain' })]);
    child(ws, 'use', [fill('u1', '#h', 'Bearer {{var:t}}'), fill('u2', '#p', '{{var:pw}}')]);
    const steps = [
      step('v', 'set_var', { name: 'tok', value: '{{param:api_token}}' }),
      step('k1', 'call', { workflow: 'plain' }),
      fill('f', '#h', 'Bearer {{var:tok}}'),
      step('k2', 'call', {
        workflow: 'use',
        args: { t: '{{var:tok}}', pw: '{{param:password}}' },
      }),
    ];
    const { result, fake, store } = await go(steps, { ws, params });
    assert.equal(result.state, 'DONE');
    const values = fake.acts.map((a) => (a as { value?: unknown }).value);
    assert.deepEqual(values, ['Bearer tok-999', 'Bearer tok-999', 'hunter2'], '执行器收到真实值');
    for (const f of ['steps.log', 'trajectory.jsonl', 'checkpoint.json']) {
      assert.doesNotMatch(readFileSync(join(store.dir, f), 'utf8'), /tok-999|hunter2/, f);
    }
  });

  test('留痕：敏感值不进 steps.log、trajectory 与检查点', async () => {
    const params = 'global:\n  password: hunter2\n  api_token: tok-999\n';
    const { result, fake, store, cp } = await go(
      [
        click('a', '#a'),
        fill('p', '#pw', '{{param:password}}'),
        step('v', 'set_var', { name: 'tok', value: '{{param:api_token}}' }),
        fill('h', '#h', 'Bearer {{var:tok}}'),
        step('w', 'set_var', { name: 'plain', value: 'visible' }),
        step('x', 'set_var', { name: 'cred', value: { user: 'u', password: 'zzz-7' } }),
      ],
      { params },
    );
    assert.equal(result.stats.steps, 6);
    const values = fake.acts.map((a) => (a as { value?: unknown }).value);
    assert.deepEqual(values.slice(1), ['hunter2', 'Bearer tok-999'], '执行器收到的是真实值');
    const read = (f: string) => readFileSync(join(store.dir, f), 'utf8');
    for (const f of ['steps.log', 'trajectory.jsonl', 'checkpoint.json']) {
      assert.doesNotMatch(read(f), /hunter2|tok-999|zzz-7/, f);
    }
    assert.match(read('steps.log'), /\*\*\*/);
    assert.equal(read('steps.log').trim().split('\n').length, 6);
    assert.equal(
      read('trajectory.jsonl').trim().split('\n').length,
      3,
      '只有交给 act 的步骤有轨迹',
    );
    assert.deepEqual(
      cp?.vars,
      { plain: 'visible' },
      '检查点不写敏感变量，也不写脱敏会改变内容的变量',
    );
  });
});

// ---------- 单次提交 ----------

/** 一次提交 + 一个后续步骤；retry 故意设成 3，看 once_only 是否忽略它。 */
const submit = [pay('s1', '#pay', 'k1', { retry: { max: 3 } }), click('s2', '#after')];

/** 订单循环：前置路径登录；每条先提交再记账；跳过模式重置页面时重放登录并检查锚点。 */
const orders = (items: string[], extra: object = {}, login: object = {}) => [
  click('login', '#login', { section: 'preamble', ...login }),
  loop('l', items, 'row', { anchor: [{ url_matches: '/list' }], ...extra }),
  pay('pay', '#pay-{{var:row}}', 'pay-{{var:row}}'),
  click('log', '#log-{{var:row}}'),
  END,
];

describe('单次提交', () => {
  const dlg = (dispatched?: boolean) => ({
    code: 'dialog_blocking',
    details: dispatched === undefined ? {} : { dispatched },
  });
  // 错误码 × 结果类别：done 写成功记录；failed 按普通失败（转人工）；其余是待核实原因，记录后停止
  const table: [Reply, string][] = [
    ['ok', 'done'],
    ['assertion_failed', 'post_failed'],
    ['timeout', 'post_timeout'],
    ['navigation_failed', 'navigation_lost'],
    ['browser_disconnected', 'browser_lost'],
    [dlg(true), 'stuck'],
    [dlg(false), 'failed'],
    [dlg(), 'failed'],
    ['internal', 'post_failed'], // 未列出的错误码：无法确认是否发出，保守按状态未明
    ...['not_found', 'not_unique', 'not_actionable', 'obscured', 'stale_ref'].map(
      (c): [Reply, string] => [c, 'failed'],
    ),
    ...['invalid_params', 'landing_mismatch', 'page_not_found'].map((c): [Reply, string] => [
      c,
      'failed',
    ]),
    ['response_timeout', 'post_timeout'],
    // 执行器明确给出 dispatched 时以它为准，不再看错误码：派发后才出现的 page_not_found / invalid_params 是已发出
    [{ code: 'page_not_found', details: { dispatched: true } }, 'post_failed'],
    [{ code: 'invalid_params', details: { dispatched: true } }, 'post_failed'],
    [{ code: 'not_found', details: { dispatched: true } }, 'post_failed'],
    [{ code: 'timeout', details: { dispatched: true } }, 'post_timeout'],
    // 派发前的失败（定位超时之类）确定没发出，哪怕错误码在“状态未明”那一类
    [{ code: 'timeout', details: { dispatched: false } }, 'failed'],
    [{ code: 'assertion_failed', details: { dispatched: false } }, 'failed'],
    [{ code: 'internal', details: { dispatched: false } }, 'failed'],
  ];
  for (const [reply, kind] of table) {
    test(`错误码 × 结果：${JSON.stringify(reply)} → ${kind}`, async () => {
      const fake = new FakeExecutor().plan('#pay', reply);
      const { result, ev, store, cp } = await go(submit, { fake });
      const state = { done: 'DONE', failed: 'NEED_HUMAN' }[kind] ?? 'STOPPED';
      assert.deepEqual([result.state, cp?.state], [state, state]);
      assert.equal(fake.count('#pay'), 1, '单次提交永不重试，retry 无效');
      assert.equal(store.hasSideEffect('k1'), kind === 'done');
      assert.equal(fake.count('#after'), kind === 'done' ? 1 : 0);
      const records = store.listUnverified().map((r) => [r.idempotency_key, r.reason]);
      assert.deepEqual(records, state === 'STOPPED' ? [['k1', kind]] : []);
      assert.equal(ev.unverified.length, records.length);
    });
  }

  test('先写检查点再执行；pre 不通过时动作没发出，不算状态未明', async () => {
    const ws = tmp();
    const fake = new FakeExecutor();
    let seen: unknown;
    fake.onAct = () => {
      seen ??= new RunStore(ws, 'r1').readCheckpoint();
    };
    await go(submit, { ws, fake });
    assert.partialDeepStrictEqual(seen, { state: 'RUNNING', step_id: 's1' });

    const blocked = new FakeExecutor();
    blocked.checkPass = () => false;
    const r = await go([pay('s1', '#pay', 'k2', { pre: [{ url_matches: '/x' }] })], {
      fake: blocked,
    });
    assert.equal(r.result.state, 'NEED_HUMAN');
    assert.equal(r.store.listUnverified().length, 0);
  });

  test('幂等键已有成功记录：跳过并记 skipped，不执行动作', async () => {
    const ws = tmp();
    new RunStore(ws, 'r1').recordSideEffect({ step_id: 's1', idempotency_key: 'k1' });
    const { result, fake, ev } = await go(submit, { ws });
    assert.deepEqual(fake.keys(), ['#after']);
    assert.equal((ev.step[0] as { status: string }).status, 'skipped');
    assert.equal(result.stats.skipped, 1);
  });

  test('状态未明的键核实前不再执行；核实为未完成后可以重做', async () => {
    const ws = tmp();
    const first = await go(submit, { ws, fake: new FakeExecutor().plan('#pay', 'timeout') });
    assert.equal(first.result.state, 'STOPPED');
    const again = await go(submit, { ws });
    assert.deepEqual([again.result.state, again.fake.count('#pay')], ['STOPPED', 0]);
    again.store.resolveUnverified('k1', { outcome: 'not_done' });
    const redo = await go(submit, { ws });
    assert.deepEqual([redo.result.state, redo.fake.count('#pay')], ['DONE', 1]);
  });

  test('once_only 挂在 call 等非动作步骤上：加载校验拒绝，什么都不执行（子流程里提交成功却被记成整步成功的漏洞）', async () => {
    const ws = tmp();
    child(ws, 'sub', [click('c1', '#submit'), click('c2', '#verify', { on_fail: 'stop' })]);
    const steps = [
      step('k', 'call', { workflow: 'sub', once_only: true, idempotency_key: 'sub-1' }),
      click('after', '#after'),
    ];
    const { result, fake, store } = await go(steps, {
      ws,
      fake: new FakeExecutor().plan('#verify', 'not_found'),
    });
    assert.deepEqual([result.state, result.error?.code], ['FAILED', 'invalid_params']);
    assert.match(result.error?.message ?? '', /once_only/);
    assert.equal(fake.acts.length, 0);
    assert.equal(store.listSideEffects().length, 0);
  });

  // 幂等键渲染后只能是非空字符串或数字；整体是单个模板时保持原类型，对象会变成 "[object Object]"、空串会变成空键
  const keyCases: [string, unknown, boolean][] = [
    ['对象', { id: 1 }, false],
    ['数组', ['a'], false],
    ['null', null, false],
    ['空串', '', false],
    ['布尔', true, false],
    ['数字', 7, true],
    ['非空字符串', 'a1', true],
  ];
  for (const [name, value, ok] of keyCases) {
    test(`幂等键渲染结果：${name}${ok ? ' 可用' : '，在动作发出前按未发出处理'}`, async () => {
      const steps = [loop('l', [{ k: value }], 'row'), pay('p', '#pay', '{{var:row.k}}'), END];
      const { result, fake, store } = await go(steps);
      if (ok) {
        assert.equal(result.state, 'DONE');
        assert.deepEqual(
          store.listSideEffects().map((r) => r.idempotency_key),
          [String(value)],
        );
        return;
      }
      assert.deepEqual([result.state, result.error?.code], ['NEED_HUMAN', 'invalid_params']);
      assert.equal(fake.acts.length, 0, '动作没有发出');
      assert.equal(store.listSideEffects().length + store.listUnverified().length, 0);
    });
  }

  test('子工作流里不允许 once_only', async () => {
    const ws = tmp();
    child(ws, 'sub', [pay('s1', '#pay', 'k9')]);
    const { result, fake } = await go([step('k', 'call', { workflow: 'sub', on_fail: 'stop' })], {
      ws,
    });
    assert.equal(result.error?.code, 'invalid_params');
    assert.equal(fake.acts.length, 0);
  });

  describe('on_unverified', () => {
    const keysOf = (r: Awaited<ReturnType<typeof go>>) =>
      r.store.listUnverified().map((x) => x.idempotency_key);

    test('skip：记入待核实 → 重放前置路径 → 处理下一条；成功一条后连续计数清零', async () => {
      const fake = new FakeExecutor().plan('#pay-a', 'timeout').plan('#pay-c', 'timeout');
      fake.plan('#login', { pages: ['p2'] }); // 前置路径的 opens 在重置时要能重新绑定
      const steps = orders(['a', 'b', 'c', 'd'], { on_unverified: 'skip' }, { opens: 'aux' });
      const r = await go(steps, { fake });
      assert.equal(r.result.state, 'DONE');
      assert.deepEqual(keysOf(r), ['pay-a', 'pay-c']);
      assert.deepEqual(
        fake.keys().filter((k) => k.startsWith('#log-')),
        ['#log-b', '#log-d'],
      );
      assert.equal(fake.count('#login'), 3, '开头一次 + 每次跳过后重置一次');
    });

    test('skip：连续 2 条状态未明则停止', async () => {
      const fake = new FakeExecutor().plan('#pay-a', 'timeout').plan('#pay-b', 'timeout');
      const r = await go(orders(['a', 'b', 'c'], { on_unverified: 'skip' }), { fake });
      assert.equal(r.result.state, 'STOPPED');
      assert.deepEqual(keysOf(r), ['pay-a', 'pay-b']);
      assert.equal(fake.count('#pay-c'), 0);
    });

    test('skip：重置后锚点不满足 → FAILED', async () => {
      const fake = new FakeExecutor().plan('#pay-a', 'timeout');
      fake.checkPass = () => false;
      const r = await go(orders(['a', 'b'], { on_unverified: 'skip' }), { fake });
      assert.deepEqual([r.result.state, r.result.error?.code], ['FAILED', 'assertion_failed']);
      assert.equal(fake.count('#pay-b'), 0);
    });

    // 优先级：命令行选项 > 循环 > 工作流 > stop
    const skip = { on_unverified: 'skip' };
    const stop = { on_unverified: 'stop' };
    const priority: [string, object, object, Partial<RunOptions>, string][] = [
      ['缺省 stop', {}, {}, {}, 'STOPPED'],
      ['循环 skip', {}, skip, {}, 'DONE'],
      ['工作流 skip', skip, {}, {}, 'DONE'],
      ['循环 stop 压过工作流 skip', skip, stop, {}, 'STOPPED'],
      ['选项 skip 覆盖循环 stop', {}, stop, { onUnverified: 'skip' }, 'DONE'],
    ];
    for (const [name, meta, extra, opts, state] of priority) {
      test(`模式优先级：${name}`, async () => {
        const fake = new FakeExecutor().plan('#pay-a', 'timeout');
        const r = await go(orders(['a', 'b'], extra), { fake, meta, opts });
        assert.equal(r.result.state, state);
      });
    }

    test('不在循环里的状态未明：即使 skip 也只能停', async () => {
      const fake = new FakeExecutor().plan('#pay', 'timeout');
      assert.equal((await go(submit, { fake, meta: skip })).result.state, 'STOPPED');
    });
  });
});

// ---------- 检查点、续跑与多页面 ----------

describe('续跑', () => {
  const rows = [
    click('login', '#login', { section: 'preamble' }),
    loop('l', ['r1', 'r2', 'r3'], 'row'),
    click('a', '#a-{{var:row}}'),
    click('b', '#b-{{var:row}}'),
    END,
  ];

  test('循环条目中途崩溃：重放前置路径，从该条目开头重做；完成后再续跑是空操作', async () => {
    const ws = tmp();
    await crashes(rows, { ws, fake: new FakeExecutor().plan('#b-r2', 'crash') });
    const cp = new RunStore(ws, 'r1').readCheckpoint();
    assert.partialDeepStrictEqual(cp, { state: 'RUNNING', step_id: 'l', loop_index: { l: 1 } });
    const r = await resume(rows, ws);
    assert.equal(r.result.state, 'DONE');
    assert.deepEqual(r.fake.keys(), ['#login', '#a-r2', '#b-r2', '#a-r3', '#b-r3']);
    const again = await resume(rows, ws);
    assert.deepEqual([again.result.state, again.fake.acts.length], ['DONE', 0]);
  });

  test('前置路径重放失败：FAILED，检查点仍停在原位，修好后可再续跑', async () => {
    const ws = tmp();
    await crashes(rows, { ws, fake: new FakeExecutor().plan('#b-r2', 'crash') });
    const broken = await resume(rows, ws, { fake: new FakeExecutor().plan('#login', 'not_found') });
    assert.deepEqual([broken.result.state, broken.result.error?.step_id], ['FAILED', 'login']);
    assert.partialDeepStrictEqual(broken.cp, { step_id: 'l', loop_index: { l: 1 } });
    const fixed = await resume(rows, ws);
    assert.deepEqual(fixed.fake.keys(), ['#login', '#a-r2', '#b-r2', '#a-r3', '#b-r3']);
  });

  test('没有检查点：不能续跑', async () => {
    const r = await resume(rows, tmp());
    assert.deepEqual([r.result.state, r.result.error?.code], ['FAILED', 'invalid_params']);
  });

  // 检查点停在 once_only 上、没有成功记录：按崩溃记状态未明；转人工后的续跑是重做，不算崩溃
  const midCrash: [string, string, string[], string[]][] = [
    ['stop', 'STOPPED', ['#login'], ['pay-a']],
    ['skip', 'DONE', ['#login', '#login', '#pay-c', '#log-c'], ['pay-a', 'pay-c']],
  ];
  for (const [mode, state, keys, done] of midCrash) {
    test(`once_only 中间崩溃：记 crash，按 on_unverified=${mode} 处理`, async () => {
      const ws = tmp();
      const steps = orders(['a', 'b', 'c'], { on_unverified: mode });
      await crashes(steps, { ws, fake: new FakeExecutor().plan('#pay-b', 'crash') });
      const r = await resume(steps, ws);
      assert.equal(r.result.state, state);
      assert.deepEqual(r.fake.keys(), keys, '已提交的 a 跳过，未明的 b 不重做');
      assert.deepEqual(
        r.store.listUnverified().map((x) => [x.idempotency_key, x.reason]),
        [['pay-b', 'crash']],
      );
      assert.deepEqual(
        r.store.listSideEffects().map((x) => x.idempotency_key),
        done,
      );
    });
  }

  test('崩在 side effect 写入之后、检查点推进之前：该条按已完成跳过，下一条照常执行，不被误判为崩溃', async () => {
    const ws = tmp();
    const steps = orders(['a', 'b', 'c'], { on_unverified: 'skip' });
    await crashes(steps, { ws, fake: new FakeExecutor().plan('#pay-b', 'crash') });
    new RunStore(ws, 'r1').recordSideEffect({ step_id: 'pay', idempotency_key: 'pay-b' });
    const r = await resume(steps, ws);
    assert.equal(r.result.state, 'DONE');
    assert.deepEqual(r.fake.keys(), ['#login', '#log-b', '#pay-c', '#log-c']);
    assert.equal(r.store.listUnverified().length, 0);
  });

  test('转人工后续跑：重做该步，不记状态未明', async () => {
    const ws = tmp();
    const steps = orders(['a', 'b']);
    await go(steps, { ws, fake: new FakeExecutor().plan('#pay-b', 'not_found') });
    const r = await resume(steps, ws);
    assert.deepEqual([r.result.state, r.fake.count('#pay-b')], ['DONE', 1]);
    assert.equal(r.store.listUnverified().length, 0);
  });

  test('循环变量不从检查点恢复：含密码的条目续跑后由 over 重新渲染', async () => {
    const ws = tmp();
    mkdirSync(join(ws, 'files'));
    const users = [
      { name: 'u1', password: 'pw-1' },
      { name: 'u2', password: 'pw-2' },
    ];
    writeFileSync(join(ws, 'files', 'users.json'), JSON.stringify(users));
    const steps = [
      loop('l', '{{file:users.json}}', 'u'),
      fill('f', '#pw', '{{var:u.password}}'),
      click('g', '#go-{{var:u.name}}'),
      END,
    ];
    await crashes(steps, { ws, fake: new FakeExecutor().plan('#go-u2', 'crash') });
    assert.doesNotMatch(readFileSync(join(ws, 'runs', 'r1', 'checkpoint.json'), 'utf8'), /pw-/);
    const r = await resume(steps, ws);
    const typed = r.fake.acts
      .filter((a) => a.op === 'fill')
      .map((a) => (a as { value?: unknown }).value);
    assert.deepEqual(typed, ['pw-2']);
  });

  test('extract 的行写入 Output 按主键去重；续跑不重复；DONE 后导出带 BOM 的 CSV', async () => {
    const ws = tmp();
    const meta = { outputs: { items: { key: 'id', export: ['csv'] } } };
    const source = { type: 'dom', kind: 'table', root: { css: '#t' } };
    const steps = [
      loop('l', [1, 2, 3], 'pg'),
      step('e', 'extract', { pageId: 'p1', source, into: 'items' }),
      END,
    ];
    const pages = [
      [1, 2],
      [2, 3],
      [3, 4],
    ].map((ids) => ids.map((id) => ({ id })));
    const first = new FakeExecutor();
    first.extractRows = (_s, n) => {
      if (n === 2) throw new Error('crash');
      return pages[n] ?? [];
    };
    await crashes(steps, { ws, meta, fake: first });
    const second = new FakeExecutor();
    second.extractRows = (_s, n) => pages[n + 2] ?? [];
    const r = await resume(steps, ws, { meta, fake: second });
    assert.deepEqual(r.result.stats.rows, { items: 1 }, '续跑只新增 id=4');
    const dir = join(ws, 'outputs', 't', String(r.cp?.cursor?.output_date));
    assert.equal(readFileSync(join(dir, 'items.csv'), 'utf8'), '﻿id\r\n1\r\n2\r\n3\r\n4\r\n');
  });
});

describe('多页面', () => {
  const open = (id: string, alias = 'docs') =>
    click(id, `#${id}`, { opens: alias, on_fail: 'stop' });
  const useDocs = (id: string) => click(id, `#${id}`, { pageId: 'docs', on_fail: 'stop' });
  const close = step('c', 'close_page', { pageId: 'docs' });
  const pages = (...ids: string[]): Reply => ({ pages: ids });

  // 别名绑定与解析的各个分支：[说明, 步骤, 动作回复, 期望的错误码或 DONE]
  const table: [string, object[], Record<string, Reply>, string][] = [
    ['别名没有绑定', [useDocs('u')], {}, 'page_not_found'],
    ['opens 没有打开新页面', [open('o1')], { '#o1': pages() }, 'not_found'],
    ['opens 打开了多个新页面', [open('o1')], { '#o1': pages('p2', 'p3') }, 'not_unique'],
    [
      '别名已占用且页面仍开着',
      [open('o1'), open('o2')],
      { '#o1': pages('p2'), '#o2': pages('p3') },
      'invalid_params',
    ],
    ['保留别名 main 不能被 opens', [open('o1', 'main')], { '#o1': pages('p2') }, 'invalid_params'],
    [
      '绑定的页面已关闭',
      [open('o1'), close, useDocs('u')],
      { '#o1': pages('p2') },
      'page_not_found',
    ],
    [
      '占用但已关闭：可以重绑',
      [open('o1'), close, open('o2'), useDocs('u')],
      { '#o1': pages('p2'), '#o2': pages('p3') },
      'DONE',
    ],
  ];
  for (const [name, steps, plans, expected] of table) {
    test(`别名：${name}`, async () => {
      const fake = new FakeExecutor();
      for (const [k, v] of Object.entries(plans)) fake.plan(k, v);
      const { result } = await go(steps, { fake });
      assert.equal(result.state, expected === 'DONE' ? 'DONE' : 'FAILED');
      if (expected !== 'DONE') assert.equal(result.error?.code, expected);
      else assert.equal((fake.acts.at(-1) as { pageId?: string }).pageId, 'p3');
      if (name === '别名没有绑定') assert.equal(fake.acts.length, 0, '不会交给 executor');
    });
  }

  test('文档页取值回填：main 由 executor 提供；as 存入变量；崩溃续跑不重开文档页', async () => {
    const ws = tmp();
    const source = { type: 'dom', kind: 'kv', root: { css: '#params' } };
    const steps = [
      click('s1', '#doc', { pageId: 'main', opens: 'docs' }),
      step('s2', 'extract', { pageId: 'docs', source, as: 'param' }),
      close,
      step('s4', 'checkpoint'),
      fill('s5', '#mem', '{{var:param.mem}}', { pageId: 'main' }),
      pay('s6', '#save', 'srv-1', { pageId: 'main' }),
    ];
    const setup = (crash: boolean) => {
      const fake = new FakeExecutor().plan('#doc', pages('p2'));
      fake.main = 'p9';
      fake.open.add('p9');
      fake.extractRows = () => [{ mem: '4096' }];
      return crash ? fake.plan('#mem', 'crash') : fake;
    };
    await crashes(steps, { ws, fake: setup(true) });
    const r = await resume(steps, ws, { fake: setup(false) });
    assert.equal(r.result.state, 'DONE');
    const acts = r.fake.acts.map((a) => [a.op, (a as { pageId?: string }).pageId]);
    assert.deepEqual(acts, [
      ['fill', 'p9'],
      ['click', 'p9'],
    ]);
    assert.equal(
      (r.fake.acts[0] as { value?: unknown }).value,
      '4096',
      'param 从检查点的 vars 恢复',
    );
    assert.deepEqual(
      r.store.listSideEffects().map((x) => x.idempotency_key),
      ['srv-1'],
    );
  });

  test('别名不进检查点：续跑后辅助页不恢复，用到时 page_not_found', async () => {
    const ws = tmp();
    const steps = [open('o1'), step('k', 'checkpoint'), useDocs('u')];
    const first = new FakeExecutor().plan('#o1', pages('p2')).plan('#u', 'crash');
    await crashes(steps, { ws, fake: first });
    const r = await resume(steps, ws);
    assert.deepEqual([r.result.error?.code, r.result.step_id], ['page_not_found', 'u']);
  });
});
