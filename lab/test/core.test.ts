import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../src/app.ts';
import { type LabModule, MAX_BODY, page, Router } from '../src/core.ts';
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

describe('Lab 公共部分：路由注册', () => {
  test('commit 路由不在 /api/ 下时注册即报错（否则故障注入不生效，用例会在没有故障时通过）', () => {
    const r = new Router('t');
    assert.throws(() => r.post('/pay', () => {}, { commit: true }), /\/api\//);
    r.post('/api/pay', () => {}, { commit: true });
    r.post('/pay-form', () => {});
    assert.equal(r.routes.length, 2);
  });
});

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

  test('同一个键再次提交：保留首次载荷；操作或载荷不同标 conflict，相同则不标', async () => {
    const c = control(lab, 'reuse');
    await post('reuse', '/api/counter/1', { key: 'k' });
    await post('reuse', '/api/counter/1', { key: 'k' });
    const same = (await c.state()).submissions.find((x) => x.key === 'k');
    assert.equal(same?.count, 2);
    assert.equal(same?.conflict, undefined, '载荷相同的重试不是冲突');
    await post('reuse', '/api/counter/7', { key: 'k' });
    const reused = (await c.state()).submissions.find((x) => x.key === 'k');
    assert.equal(reused?.count, 3);
    assert.deepEqual(reused?.payload, { step: '1' }, '载荷保持首次提交的内容，不被后来的覆盖');
    assert.equal(reused?.conflict, true);
  });

  test('控制接口校验输入：表单里的数字与布尔会转换，未知键、非法值、非对象体回 400 且不改任何开关', async () => {
    const c = control(lab, 'cv');
    const raw = (path: string, body: string, type: string) =>
      fetch(`${lab.url('cv')}/_lab/${path}`, {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
    const form = 'application/x-www-form-urlencoded';
    // 表单编码里 commit_timeout=false 必须是关闭，redesign=1 必须是数字 1
    const ok = await raw('faults', 'commit_timeout=false&redesign=1&error_rate=0.25', form);
    assert.equal(ok.status, 200);
    const faults = (await ok.json()) as Record<string, unknown>;
    assert.equal(faults.commit_timeout, false);
    assert.equal(faults.redesign, 1);
    assert.equal(faults.error_rate, 0.25);

    for (const [body, what] of [
      ['{"delay":500}', '拼错的键'],
      ['{"error_rate":"abc"}', '非数字'],
      ['{"error_rate":2}', '超出 0~1'],
      ['{"commit_timeout":"yes"}', '非布尔'],
      ['{"redesign":1.5}', '非整数'],
      ['{"delay_ms":-1}', '负数'],
      ['{"drop_rate":0.5,"popup_rate":"x"}', '一项非法时前面合法的也不能生效'],
      ['null', 'JSON null'],
      ['[1]', '数组'],
      ['{', 'JSON 不合法'],
    ] as const) {
      const r = await raw('faults', body, 'application/json');
      assert.equal(r.status, 400, what);
      assert.equal(((await r.json()) as { error: string }).error, 'bad_request');
    }
    const after = (await c.state()).faults;
    assert.deepEqual(after, faults, '被拒绝的请求没有改动任何开关');
    assert.equal((await raw('faults', 'session_ttl_ms=null', form)).status, 200);
    assert.equal((await c.state()).faults.session_ttl_ms, null);

    assert.equal((await raw('reset', '{"seed":1.5}', 'application/json')).status, 400);
    assert.equal((await raw('reset', 'null', 'application/json')).status, 400);
    assert.equal((await raw('reset', '{"sead":1}', 'application/json')).status, 400);
    const seeded = await raw('reset', 'seed=5', form);
    assert.equal(seeded.status, 200);
    assert.equal(((await seeded.json()) as { seed: number }).seed, 5, '表单里的 seed 也生效');
    assert.equal((await c.state()).seed, 5);
  });

  test('百分号编码不合法的 Cookie、空间名、路径参数回正常响应或 400，不是 500', async () => {
    const c = control(lab, 'pct');
    // 别处残留的 cookie 不能让整个空间（含控制接口）对这个浏览器全部失败
    const withCookie = await fetch(`${lab.url('pct')}/_lab/state`, {
      headers: { cookie: 'foo=%zz; bar=100%' },
    });
    assert.equal(withCookie.status, 200);
    assert.equal((await fetch(`${lab.base}/s/%E0%A4%A/_lab/state`)).status, 400);
    const param = await post('pct', '/api/counter/%E0%A4%A', {});
    assert.equal(param.status, 400);
    assert.equal(((await c.state()).modules.counter as { n: number }).n, 0, '请求没有被执行');
  });

  test('请求体超过 1 MiB 回 413，不缓存也不执行；之后的请求照常', async () => {
    const c = control(lab, 'big');
    const r = await post('big', '/api/counter/1', { key: 'big', pad: 'x'.repeat(MAX_BODY + 1) });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'payload_too_large' });
    // 控制接口同样有上限，不会被当成“不是对象”回 400
    assert.equal((await post('big', '/_lab/faults', { pad: 'x'.repeat(MAX_BODY) })).status, 413);
    const s = await c.state();
    assert.equal((s.modules.counter as { n: number }).n, 0, '超限的写请求没有执行');
    assert.equal(s.submissions.length, 0);
    assert.equal((await post('big', '/api/counter/1', { key: 'small' })).status, 200);
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

  test('故障：丢弃响应对写接口是“已落库但连接被断开”，重试同一个键才会被记成重复', async () => {
    const c = control(lab, 'dw');
    await c.faults({ drop_rate: 1 });
    await assert.rejects(post('dw', '/api/counter/4', { key: 'dropped' }));
    await c.faults({ drop_rate: 0 });
    const s = await c.state();
    assert.equal((s.modules.counter as { n: number }).n, 4, '写操作已执行，不是请求没到服务端');
    assert.equal(s.submissions.find((x) => x.key === 'dropped')?.count, 1);
    assert.ok(s.log.some((x) => x.type === 'fault_drop'));
    // 盲目重试的实现在对账里会露馅
    await post('dw', '/api/counter/4', { key: 'dropped' });
    assert.equal((await c.state()).submissions.find((x) => x.key === 'dropped')?.count, 2);
  });
});
