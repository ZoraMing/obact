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
import { FakeExecutor } from './fake-executor.ts';

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
    const child = (name: string, steps: object[]) => {
      mkdirSync(join(ws, 'workflows', name), { recursive: true });
      writeFileSync(join(ws, 'workflows', name, 'workflow.json'), JSON.stringify({ name }));
      writeFileSync(
        join(ws, 'workflows', name, 'steps.jsonl'),
        steps.map((s) => JSON.stringify(s)).join('\n'),
      );
    };
    child('login', [click('c1', '#user-{{var:name}}')]);
    child('broken', [click('b1', '#broken', { on_fail: 'stop' })]);
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
