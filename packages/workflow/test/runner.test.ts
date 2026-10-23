// 工作流 runner（FR-16~19、FR-25、FR-26、FR-37）：用假执行器测逻辑，不开浏览器。
// 崩溃用 hooks 或假执行器抛不带 code 的异常模拟，续跑用同一个工作区、同一个 run_id 再调用 run。
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

const click = (id: string, css: string, extra: object = {}) => ({
  step_id: id,
  op: 'click',
  pageId: 'p1',
  target: { css },
  ...extra,
});

/** 在工作区里放一个可被 call 的子工作流。 */
function child(ws: string, name: string, steps: object[]): void {
  mkdirSync(join(ws, 'workflows', name), { recursive: true });
  writeFileSync(join(ws, 'workflows', name, 'workflow.json'), JSON.stringify({ name }));
  writeFileSync(
    join(ws, 'workflows', name, 'steps.jsonl'),
    steps.map((x) => JSON.stringify(x)).join('\n'),
  );
}

function workflowOf(steps: object[], meta: object = {}, name = 't'): Workflow {
  return {
    name,
    dir: '',
    meta: { name, ...meta },
    steps: steps as Step[],
    signatures: [],
    rules: [],
  };
}

type Setup = {
  meta?: object;
  fake?: FakeExecutor;
  ws?: string;
  params?: string;
  opts?: Partial<RunOptions>;
};

/** 跑一遍；返回结果、假执行器、记录到的事件和运行目录里的文件。 */
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
  const result = await run(workflowOf(steps, o.meta), fake, {
    runId: 'r1',
    workspace: ws,
    events,
    ...o.opts,
  });
  const store = new RunStore(ws, 'r1');
  const read = (f: string) => readFileSync(join(store.dir, f), 'utf8');
  return { result, fake, ev, ws, store, cp: store.readCheckpoint(), read };
}

describe('S1 最小路径', () => {
  test('控制流：嵌套循环、if / else、break、set_var', async () => {
    const { result, fake } = await go([
      { step_id: 'v', op: 'set_var', name: 'list', value: [1, 2] },
      { step_id: 'l1', op: 'loop_begin', over: '{{var:list}}', as: 'x' },
      { step_id: 'l2', op: 'loop_begin', over: ['a', 'b', 'c'], as: 'y' },
      click('c', '#c-{{var:x}}-{{var:y}}'),
      { step_id: 'i', op: 'if', value: '{{var:y}}', equals: 'b' },
      { step_id: 'b', op: 'break' },
      { step_id: 'e', op: 'else' },
      click('t', '#e-{{var:x}}-{{var:y}}'),
      { step_id: 'f', op: 'end_if' },
      { step_id: 'l3', op: 'loop_end' },
      click('d', '#done-{{var:x}}'),
      { step_id: 'l4', op: 'loop_end' },
    ]);
    assert.equal(result.state, 'DONE');
    assert.deepEqual(fake.keys(), [
      ...['#c-1-a', '#e-1-a', '#c-1-b', '#done-1'],
      ...['#c-2-a', '#e-2-a', '#c-2-b', '#done-2'],
    ]);
  });

  test('if 用检查项判断；空循环不进入循环体', async () => {
    const fake = new FakeExecutor();
    fake.checkPass = (_p, checks) => JSON.stringify(checks).includes('yes');
    const { result } = await go(
      [
        { step_id: 'i1', op: 'if', pageId: 'p1', checks: [{ text_present: 'yes' }] },
        click('a', '#a'),
        { step_id: 'i2', op: 'end_if' },
        { step_id: 'i3', op: 'if', pageId: 'p1', checks: [{ text_present: 'no' }] },
        click('b', '#b'),
        { step_id: 'i4', op: 'end_if' },
        { step_id: 'l', op: 'loop_begin', over: [], as: 'x' },
        click('c', '#c'),
        { step_id: 'le', op: 'loop_end' },
        click('d', '#d'),
      ],
      { fake },
    );
    assert.equal(result.state, 'DONE');
    assert.deepEqual(fake.keys(), ['#a', '#d']);
  });

  // 重试次数与三种 on_fail（缺省为 human）
  const failCases = [
    {
      name: 'retry 2 次后成功',
      step: { retry: { max: 2 } },
      replies: ['timeout', 'timeout', 'ok'],
      state: 'DONE',
      calls: 3,
      next: 1,
    },
    {
      name: 'retry 用尽 + stop',
      step: { retry: { max: 2 }, on_fail: 'stop' },
      replies: ['timeout'],
      state: 'FAILED',
      calls: 3,
      next: 0,
    },
    {
      name: '不重试 + skip',
      step: { on_fail: 'skip' },
      replies: ['not_found'],
      state: 'DONE',
      calls: 1,
      next: 1,
    },
    {
      name: '不重试 + human',
      step: { on_fail: 'human' },
      replies: ['not_found'],
      state: 'NEED_HUMAN',
      calls: 1,
      next: 0,
    },
    {
      name: '缺省 on_fail 即 human',
      step: {},
      replies: ['obscured'],
      state: 'NEED_HUMAN',
      calls: 1,
      next: 0,
    },
  ];
  for (const c of failCases) {
    test(`失败处理：${c.name}`, async () => {
      const fake = new FakeExecutor().plan('#a', ...c.replies);
      const { result, ev, cp } = await go([click('s1', '#a', c.step), click('s2', '#b')], { fake });
      assert.equal(result.state, c.state);
      assert.equal(fake.count('#a'), c.calls);
      assert.equal(fake.count('#b'), c.next);
      assert.equal(cp?.state, c.state);
      if (c.state !== 'DONE' && c.state !== 'FAILED') assert.equal(ev.need_human.length, 1);
      if (c.state === 'NEED_HUMAN') {
        assert.equal(cp?.step_id, 's1', '转人工的检查点停在失败的步骤上，续跑从它重做');
        assert.equal(result.error?.step_id, 's1');
      }
      if (c.name.endsWith('skip'))
        assert.deepEqual([result.stats.failed, result.stats.skipped], [1, 1]);
    });
  }

  test('pre 前置检查不通过：不执行动作，按失败处理', async () => {
    const fake = new FakeExecutor();
    fake.checkPass = () => false;
    const { result } = await go([click('s1', '#a', { pre: [{ url_matches: '/orders' }] })], {
      fake,
    });
    assert.equal(result.state, 'NEED_HUMAN');
    assert.equal(result.error?.code, 'assertion_failed');
    assert.equal(fake.acts.length, 0);
  });

  test('call：子工作流以 args 为初始变量，共用执行器；失败向上传递', async () => {
    const ws = tmp();
    child(ws, 'login', [click('c1', '#user-{{var:name}}')]);
    child(ws, 'broken', [click('b1', '#broken', { on_fail: 'stop' })]);
    const fake = new FakeExecutor().plan('#broken', 'not_found');
    const ok = await go(
      [
        { step_id: 'k', op: 'call', workflow: 'login', args: { name: 'amy' } },
        click('s2', '#next'),
      ],
      { ws, fake },
    );
    assert.equal(ok.result.state, 'DONE');
    assert.deepEqual(fake.keys(), ['#user-amy', '#next']);

    const bad = await go([{ step_id: 'k', op: 'call', workflow: 'broken' }, click('s2', '#next')], {
      ws,
      fake: new FakeExecutor().plan('#broken', 'not_found'),
      opts: { runId: 'r2' },
    });
    assert.equal(bad.result.state, 'FAILED');
    assert.deepEqual([bad.result.step_id, bad.result.error?.step_id], ['k', 'b1']);
    const missing = await go([{ step_id: 'k', op: 'call', workflow: 'nope', on_fail: 'stop' }], {
      ws,
      opts: { runId: 'r3' },
    });
    assert.equal(missing.result.error?.code, 'invalid_params');
  });

  test('留痕：事件、steps.log、trajectory；敏感值不进日志、留痕与检查点', async () => {
    const { result, fake, ev, read, cp } = await go(
      [
        click('a', '#a'),
        {
          step_id: 'p',
          op: 'fill',
          pageId: 'p1',
          target: { css: '#pw' },
          value: '{{param:password}}',
        },
        { step_id: 'v', op: 'set_var', name: 'tok', value: '{{param:api_token}}' },
        {
          step_id: 'h',
          op: 'fill',
          pageId: 'p1',
          target: { css: '#h' },
          value: 'Bearer {{var:tok}}',
        },
        { step_id: 'w', op: 'set_var', name: 'plain', value: 'visible' },
      ],
      { params: 'global:\n  password: hunter2\n  api_token: tok-999\n' },
    );
    assert.equal(result.state, 'DONE');
    const values = fake.acts.map((a) => (a as { value?: unknown }).value);
    assert.deepEqual(values.slice(1), ['hunter2', 'Bearer tok-999'], '执行器收到的是真实值');
    for (const f of ['steps.log', 'trajectory.jsonl', 'checkpoint.json']) {
      assert.doesNotMatch(read(f), /hunter2|tok-999/, f);
    }
    assert.match(read('steps.log'), /\*\*\*/);
    assert.equal(read('steps.log').trim().split('\n').length, 5);
    assert.equal(
      read('trajectory.jsonl').trim().split('\n').length,
      3,
      '只有交给 act 的步骤有轨迹',
    );
    assert.deepEqual(cp?.vars, { plain: 'visible' }, '检查点不写敏感变量');
    assert.deepEqual(
      ev.step.map((e) => (e as { status: string }).status),
      ['ok', 'ok', 'ok', 'ok', 'ok'],
    );
    assert.equal(result.stats.steps, 5);
  });
});

// ---------- S2 单次提交 ----------

const pay = (id: string, css: string, key: string, extra: object = {}) =>
  click(id, css, { once_only: true, idempotency_key: key, ...extra });

/** 一次提交 + 一个后续步骤；retry 故意设成 3，看 once_only 是否忽略它。 */
const submit = [pay('s1', '#pay', 'k1', { retry: { max: 3 } }), click('s2', '#after')];

/** 订单循环：前置路径登录；每条先提交（单次提交）再记账；跳过模式重置页面时重放登录并检查锚点。 */
const orders = (items: string[], loop: object = {}) => [
  click('login', '#login', { section: 'preamble' }),
  {
    step_id: 'l',
    op: 'loop_begin',
    over: items,
    as: 'row',
    anchor: [{ url_matches: '/list' }],
    ...loop,
  },
  pay('pay', '#pay-{{var:row}}', 'pay-{{var:row}}'),
  click('log', '#log-{{var:row}}'),
  { step_id: 'le', op: 'loop_end' },
];

describe('S2 单次提交', () => {
  const dialog = (dispatched?: boolean) => ({
    code: 'dialog_blocking',
    details: dispatched === undefined ? {} : { dispatched },
  });
  // 错误码 × 结果类别：done 写成功记录；unverified 记待核实并停止；failed 按普通失败（转人工）
  const table: [string, Reply, 'done' | 'failed' | string][] = [
    ['成功', 'ok', 'done'],
    ['assertion_failed', 'assertion_failed', 'post_failed'],
    ['timeout', 'timeout', 'post_timeout'],
    ['navigation_failed', 'navigation_failed', 'navigation_lost'],
    ['browser_disconnected', 'browser_disconnected', 'browser_lost'],
    ['dialog_blocking，dispatched=true', dialog(true), 'stuck'],
    ['dialog_blocking，dispatched=false', dialog(false), 'failed'],
    ['dialog_blocking，无 dispatched', dialog(), 'failed'],
    ['internal（无法确认是否发出，保守处理）', 'internal', 'post_failed'],
    ...[
      ...['not_found', 'not_unique', 'not_actionable', 'obscured', 'stale_ref'],
      ...['invalid_params', 'landing_mismatch', 'page_not_found'],
    ].map((code): [string, Reply, string] => [code, code, 'failed']),
  ];
  for (const [name, reply, kind] of table) {
    test(`错误码 × 结果：${name} → ${kind}`, async () => {
      const fake = new FakeExecutor().plan('#pay', reply);
      const { result, ev, store, cp } = await go(submit, { fake });
      assert.equal(fake.count('#pay'), 1, '单次提交永不重试，retry 无效');
      assert.equal(store.hasSideEffect('k1'), kind === 'done');
      const records = store.listUnverified();
      const state = { done: 'DONE', failed: 'NEED_HUMAN' }[kind] ?? 'STOPPED';
      assert.equal(result.state, state);
      assert.equal(cp?.state, state);
      assert.equal(fake.count('#after'), kind === 'done' ? 1 : 0);
      if (state === 'STOPPED') {
        assert.deepEqual(
          records.map((r) => [r.idempotency_key, r.reason]),
          [['k1', kind]],
        );
        assert.equal(ev.unverified.length, 1);
        assert.equal(cp?.step_id, 's1');
      } else assert.equal(records.length, 0);
    });
  }

  test('先写检查点再执行：动作到达时检查点已指向该步', async () => {
    const ws = tmp();
    const fake = new FakeExecutor();
    let seen: unknown;
    fake.onAct = (a) => {
      if (a.op === 'click' && a.target?.css === '#pay') {
        seen = new RunStore(ws, 'r1').readCheckpoint();
      }
    };
    await go(submit, { ws, fake });
    assert.partialDeepStrictEqual(seen, { state: 'RUNNING', step_id: 's1' });
  });

  test('幂等键已有成功记录：跳过并记 skipped，不执行动作', async () => {
    const ws = tmp();
    new RunStore(ws, 'r1').recordSideEffect({ step_id: 's1', idempotency_key: 'k1' });
    const { result, fake, ev } = await go(submit, { ws });
    assert.equal(result.state, 'DONE');
    assert.deepEqual(fake.keys(), ['#after']);
    assert.equal((ev.step[0] as { status: string }).status, 'skipped');
    assert.equal(result.stats.skipped, 1);
  });

  test('状态未明的键未核实前不再执行；核实为未完成后可以重做', async () => {
    const ws = tmp();
    const first = await go(submit, { ws, fake: new FakeExecutor().plan('#pay', 'timeout') });
    assert.equal(first.result.state, 'STOPPED');
    const again = await go(submit, { ws });
    assert.equal(again.result.state, 'STOPPED');
    assert.equal(again.fake.count('#pay'), 0);
    again.store.resolveUnverified('k1', { outcome: 'not_done' });
    const redo = await go(submit, { ws });
    assert.equal(redo.result.state, 'DONE');
    assert.equal(redo.fake.count('#pay'), 1);
  });

  test('子工作流里不允许 once_only', async () => {
    const ws = tmp();
    child(ws, 'sub', [pay('s1', '#pay', 'k9')]);
    const { result, fake } = await go(
      [{ step_id: 'k', op: 'call', workflow: 'sub', on_fail: 'stop' }],
      { ws },
    );
    assert.equal(result.error?.code, 'invalid_params');
    assert.equal(fake.acts.length, 0);
  });

  describe('on_unverified', () => {
    const keysOf = (r: Awaited<ReturnType<typeof go>>) =>
      r.store.listUnverified().map((x) => x.idempotency_key);

    test('skip：记入待核实 → 重放前置路径 → 处理下一条；中间成功一条后连续计数清零', async () => {
      const fake = new FakeExecutor().plan('#pay-a', 'timeout').plan('#pay-c', 'timeout');
      const r = await go(orders(['a', 'b', 'c', 'd'], { on_unverified: 'skip' }), { fake });
      assert.equal(r.result.state, 'DONE');
      assert.deepEqual(keysOf(r), ['pay-a', 'pay-c']);
      assert.deepEqual(
        fake.keys().filter((k) => k.startsWith('#log-')),
        ['#log-b', '#log-d'],
      );
      assert.equal(fake.count('#login'), 3, '开头一次 + 每次跳过后重置一次');
      assert.equal(r.result.stats.unverified, 2);
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
      assert.equal(r.result.state, 'FAILED');
      assert.equal(r.result.error?.code, 'assertion_failed');
      assert.equal(fake.count('#pay-b'), 0);
    });

    // 优先级：命令行选项 > 循环 > 工作流 > stop
    const priority: [string, object, object, Partial<RunOptions>, string][] = [
      ['缺省 stop', {}, {}, {}, 'STOPPED'],
      ['循环 skip', {}, { on_unverified: 'skip' }, {}, 'DONE'],
      ['工作流 skip', { on_unverified: 'skip' }, {}, {}, 'DONE'],
      [
        '循环 stop 压过工作流 skip',
        { on_unverified: 'skip' },
        { on_unverified: 'stop' },
        {},
        'STOPPED',
      ],
      ['选项 skip 覆盖循环 stop', {}, { on_unverified: 'stop' }, { onUnverified: 'skip' }, 'DONE'],
    ];
    for (const [name, meta, loop, opts, state] of priority) {
      test(`模式优先级：${name}`, async () => {
        const fake = new FakeExecutor().plan('#pay-a', 'timeout');
        const r = await go(orders(['a', 'b'], loop), { fake, meta, opts });
        assert.equal(r.result.state, state);
      });
    }

    test('不在循环里的状态未明：即使 skip 也只能停', async () => {
      const fake = new FakeExecutor().plan('#pay', 'timeout');
      const r = await go(submit, { fake, meta: { on_unverified: 'skip' } });
      assert.equal(r.result.state, 'STOPPED');
    });
  });
});
