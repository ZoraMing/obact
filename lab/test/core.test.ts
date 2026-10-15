import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../src/app.ts';
import { type LabModule, page } from '../src/core.ts';
import { control } from './helpers.ts';

/** 测试用的最小模块：一个计数器、一个需要登录的页面和一个写接口。 */
const counter: LabModule = {
  name: 'counter',
  title: '计数器',
  nav: '/counter',
  init(space) {
    space.data.counter = { n: 0, start: Math.floor(space.rng() * 1000) };
  },
  routes(r) {
    r.get('/counter', (ctx) => ctx.html(page(ctx, [counter], '计数器', '<h1>计数器</h1>')), {
      auth: true,
    });
    r.post('/login', async (ctx) => {
      const b = await ctx.body();
      ctx.signIn(String(b.user));
      ctx.redirect(`${ctx.base}/counter`);
    });
    r.get('/api/counter', (ctx) => ctx.json(ctx.space.data.counter));
    r.post(
      '/api/counter/:step',
      async (ctx) => {
        const b = await ctx.body();
        const d = ctx.space.data.counter as { n: number };
        d.n += Number(ctx.params.step);
        ctx.record('add', b.key as string | undefined, { step: ctx.params.step });
        ctx.json(d);
      },
      { commit: true },
    );
  },
  state: (space) => space.data.counter,
};

describe('Lab 公共部分：数据空间、控制接口、登录态、故障注入', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [counter] });
  });
  after(async () => {
    await lab?.close();
  });

  const post = (space: string, path: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${lab.url(space)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  test('空间互相独立；同名空间重置后数据相同；reset 可换种子', async () => {
    await post('a', '/api/counter/5', { key: 'k1' });
    const a = control(lab, 'a');
    const b = control(lab, 'b');
    assert.equal(((await a.state()).modules.counter as { n: number }).n, 5);
    assert.equal(((await b.state()).modules.counter as { n: number }).n, 0);
    const start = ((await a.state()).modules.counter as { start: number }).start;
    await a.reset();
    const s = await a.state();
    assert.deepEqual(s.modules.counter, { n: 0, start });
    assert.equal(s.submissions.length, 0);
    await a.reset(42);
    assert.notEqual(((await a.state()).modules.counter as { start: number }).start, start);
  });

  test('提交按幂等键计数', async () => {
    const c = control(lab, 'idem');
    await post('idem', '/api/counter/1', { key: 'same' });
    await post('idem', '/api/counter/1', { key: 'same' });
    await post('idem', '/api/counter/1', {});
    const s = await c.state();
    assert.equal(s.submissions.find((x) => x.key === 'same')?.count, 2);
    assert.equal(s.submissions.length, 2);
  });

  test('需要登录的页面跳到登录页；会话 cookie 限定在空间内；会话过期', async () => {
    const r = await fetch(`${lab.url('auth')}/counter`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/s/auth/login?next=%2Fcounter');
    const res = await fetch(`${lab.url('auth')}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=alice',
      redirect: 'manual',
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /Path=\/s\/auth\//);
    const token = cookie.split(';')[0] as string;
    const ok = await fetch(`${lab.url('auth')}/counter`, {
      headers: { cookie: token },
      redirect: 'manual',
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<span class="lab-user">alice<\/span>/);
    await control(lab, 'auth').faults({ session_ttl_ms: 0 });
    await new Promise((r) => setTimeout(r, 5));
    const expired = await fetch(`${lab.url('auth')}/counter`, {
      headers: { cookie: token },
      redirect: 'manual',
    });
    assert.equal(expired.status, 303);
  });

  test('故障：延迟、偶发 500、丢弃响应', async () => {
    const c = control(lab, 'f');
    await c.faults({ delay_ms: 150 });
    const t = Date.now();
    await fetch(`${lab.url('f')}/api/counter`);
    assert.ok(Date.now() - t >= 140);
    await c.faults({ delay_ms: 0, error_rate: 1 });
    assert.equal((await fetch(`${lab.url('f')}/api/counter`)).status, 500);
    // 页面不受接口故障影响
    assert.notEqual((await fetch(`${lab.url('f')}/`)).status, 500);
    await c.faults({ error_rate: 0, drop_rate: 1 });
    await assert.rejects(fetch(`${lab.url('f')}/api/counter`));
    await c.faults({ drop_rate: 0 });
    assert.equal((await fetch(`${lab.url('f')}/api/counter`)).status, 200);
    const s = await c.state();
    assert.ok(s.log.some((x) => x.type === 'fault_500'));
    assert.ok(s.log.some((x) => x.type === 'fault_drop'));
  });

  test('故障：提交超时但已落库', async () => {
    const c = control(lab, 'ct');
    await c.faults({ commit_timeout: true });
    await assert.rejects(post('ct', '/api/counter/3', { key: 'once' }, AbortSignal.timeout(300)));
    const s = await c.state();
    assert.equal((s.modules.counter as { n: number }).n, 3, '已落库');
    assert.equal(s.submissions.find((x) => x.key === 'once')?.count, 1);
  });

  test('非法空间名、根路径跳转', async () => {
    assert.equal((await fetch(`${lab.base}/s/a.b/`)).status, 400);
    const r = await fetch(`${lab.base}/`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/s/default/');
  });
});
