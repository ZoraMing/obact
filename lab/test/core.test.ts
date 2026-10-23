// Lab 公共部分（PRD 9.3、9.5）：数据空间、三个控制接口、故障注入、幂等键对账。
// 每条测试对应一个需求或 M1 评审里的 lab-* / sec-* 缺陷（见各用例名里的编号）。
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../src/app.ts';
import { type LabModule, LOG_MAX, MAX_BODY, page, Router } from '../src/core.ts';
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
      ctx.signIn(String((await ctx.body()).user));
      ctx.redirect(`${ctx.base}/counter`);
    });
    r.get('/api/counter', (ctx) => ctx.json(ctx.space.data.counter));
    r.get('/api/boom', () => {
      throw new Error('boom-secret');
    });
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

describe('Lab 公共部分：路由、数据空间、控制接口、登录态、故障注入', () => {
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
  const n = async (space: string) =>
    ((await control(lab, space).state()).modules.counter as { n: number }).n;

  test('commit 路由不在 /api/ 下时注册即报错（lab-9：否则故障注入不生效，用例会在没有故障时通过）', () => {
    const r = new Router('t');
    assert.throws(() => r.post('/pay', () => {}, { commit: true }), /\/api\//);
    r.post('/api/pay', () => {}, { commit: true });
    assert.equal(r.routes.length, 1);
  });

  test('空间互相独立；同名空间重置后数据相同，reset 可换种子；无键提交的 auto-N 按空间从 1 起（lab-5）', async () => {
    await post('a', '/api/counter/5', { key: 'k1' });
    await post('a', '/api/counter/1', {});
    await post('b', '/api/counter/1', {});
    const a = control(lab, 'a');
    assert.equal(await n('a'), 6);
    assert.equal(await n('b'), 1, '另一个空间不受影响');
    const keys = (await control(lab, 'b').state()).submissions.map((s) => s.key);
    assert.deepEqual(keys, ['auto-1'], 'b 的第一个无键提交也是 auto-1');
    const start = ((await a.state()).modules.counter as { start: number }).start;
    await a.reset();
    const s = await a.state();
    assert.deepEqual(s.modules.counter, { n: 0, start });
    assert.equal(s.submissions.length, 0);
    await a.reset(42);
    assert.notEqual(((await a.state()).modules.counter as { start: number }).start, start);
  });

  test('同一个幂等键再次提交按次数记录、保留首次载荷；操作或载荷不同标 conflict，相同则不标（lab-2）', async () => {
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

  test('控制接口校验输入：表单里的数字与布尔会转换，未知键、非法值、非对象体回 400 且不改任何开关（lab-3）', async () => {
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
    assert.deepEqual([faults.commit_timeout, faults.redesign, faults.error_rate], [false, 1, 0.25]);
    for (const body of [
      '{"delay":500}', // 拼错的键
      '{"error_rate":2}', // 超出 0~1
      '{"commit_timeout":"yes"}',
      '{"redesign":1.5}',
      '{"redesign_after_requests":0}',
      '{"drop_rate":0.5,"popup_rate":"x"}', // 一项非法时前面合法的也不能生效
      'null',
      '{',
    ]) {
      const r = await raw('faults', body, 'application/json');
      assert.equal(r.status, 400, body);
      assert.equal(((await r.json()) as { error: string }).error, 'bad_request');
    }
    assert.deepEqual((await c.state()).faults, faults, '被拒绝的请求没有改动任何开关');

    assert.equal((await raw('reset', '{"seed":1.5}', 'application/json')).status, 400);
    assert.equal((await raw('reset', '{"sead":1}', 'application/json')).status, 400);
    const seeded = await raw('reset', 'seed=5', form);
    assert.equal(((await seeded.json()) as { seed: number }).seed, 5, '表单里的 seed 也生效');
  });

  test('百分号编码不合法的 Cookie、空间名、路径参数回正常响应或 400，不是 500（lab-8）', async () => {
    // 别处残留的 cookie 不能让整个空间（含控制接口）对这个浏览器全部失败
    const withCookie = await fetch(`${lab.url('pct')}/_lab/state`, {
      headers: { cookie: 'foo=%zz; bar=100%' },
    });
    assert.equal(withCookie.status, 200);
    assert.equal((await fetch(`${lab.base}/s/%E0%A4%A/_lab/state`)).status, 400);
    assert.equal((await post('pct', '/api/counter/%E0%A4%A', {})).status, 400);
    assert.equal(await n('pct'), 0, '请求没有被执行');
  });

  test('请求体超过 1 MiB 回 413，不缓存也不执行，控制接口同样；之后的请求照常（lab-10）', async () => {
    const r = await post('big', '/api/counter/1', { key: 'big', pad: 'x'.repeat(MAX_BODY + 1) });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'payload_too_large' });
    assert.equal((await post('big', '/_lab/faults', { pad: 'x'.repeat(MAX_BODY) })).status, 413);
    assert.equal(await n('big'), 0, '超限的写请求没有执行');
    assert.equal((await post('big', '/api/counter/1', { key: 'small' })).status, 200);
  });

  test('事件日志只保留最近 500 条，丢掉最早的（lab-14）', async () => {
    const c = control(lab, 'logcap');
    for (let i = 0; i < LOG_MAX + 10; i++) await c.faults({ delay_ms: i });
    await c.faults({ delay_ms: 0 });
    const log = (await c.state()).log;
    assert.equal(log.length, LOG_MAX);
    assert.deepEqual(log.at(-1)?.detail, { delay_ms: 0 }, '最后一条是最新的');
    assert.deepEqual(log[0]?.detail, { delay_ms: 11 }, '最早的 11 条已被丢掉');
  });

  test('只接受本机两个站点的 Host；控制接口不接受跨站 POST；500 不回堆栈（sec-15）', async (t) => {
    const u = new URL(lab.base);
    const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
          .on('error', reject)
          .end(body);
      });
    const state = '/s/sec/_lab/state';
    assert.equal(await raw('GET', state, { host: 'evil.example' }), 403);
    assert.equal(await raw('GET', state, { host: `evil.example:${u.port}` }), 403);
    assert.equal(await raw('GET', state, { host: `localhost:${u.port}` }), 200);

    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const faults = (site: string, body: string) =>
      raw('POST', '/s/sec/_lab/faults', { ...form, 'sec-fetch-site': site }, body);
    for (const site of ['cross-site', 'same-site'])
      assert.equal(await faults(site, 'error_rate=1'), 403);
    assert.equal((await control(lab, 'sec').state()).faults.error_rate, 0, '跨站请求没有改动开关');
    assert.equal(await faults('same-origin', 'delay_ms=0'), 200, '同源页面发来的可以');

    // 服务端出错只回固定文案，堆栈（含绝对路径）写日志
    const logged = t.mock.method(console, 'error', () => {});
    const boom = await fetch(`${lab.url('sec')}/api/boom`);
    assert.equal(boom.status, 500);
    assert.equal(await boom.text(), '内部错误');
    assert.equal(logged.mock.callCount(), 1);
  });

  test('需要登录的页面跳到登录页；会话 cookie 限定在空间内，空间之间不串登录态（FR-02）', async () => {
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
    const visit = (space: string) =>
      fetch(`${lab.url(space)}/counter`, { headers: { cookie }, redirect: 'manual' });
    assert.equal((await visit('auth')).status, 200);
    assert.equal((await visit('other')).status, 303, '同一个会话令牌在别的空间无效');
  });

  test('故障：延迟、偶发 500、丢弃响应只作用于 /api/', async () => {
    const c = control(lab, 'f');
    const api = () => fetch(`${lab.url('f')}/api/counter`);
    await c.faults({ delay_ms: 150 });
    const t = Date.now();
    await api();
    assert.ok(Date.now() - t >= 140);
    await c.faults({ delay_ms: 0, error_rate: 1 });
    assert.equal((await api()).status, 500);
    assert.notEqual((await fetch(`${lab.url('f')}/`)).status, 500, '页面不受接口故障影响');
    await c.faults({ error_rate: 0, drop_rate: 1 });
    await assert.rejects(api());
    await c.faults({ drop_rate: 0 });
    assert.equal((await api()).status, 200);
    const log = (await c.state()).log;
    assert.ok(log.some((x) => x.type === 'fault_500') && log.some((x) => x.type === 'fault_drop'));
  });

  test('故障：定时改版按“第 N 个请求后”或“T 毫秒后”自动切换，只切一次，控制接口不计数，默认关闭（lab-12）', async () => {
    const c = control(lab, 'rd');
    const hit = () => fetch(`${lab.url('rd')}/api/counter`);
    const redesign = async () => (await c.state()).faults.redesign;
    const switches = async () =>
      (await c.state()).log.filter((x) => x.type === 'redesign_switch').map((x) => x.detail);
    for (let i = 0; i < 3; i++) await hit();
    assert.equal(await redesign(), 0, '默认关闭，没设置时不会自己切');

    // 之后的 2 个请求仍是旧版，第 3 个请求起是新版；读 state 和改 faults 都不算请求
    await c.faults({ redesign_after_requests: 2, redesign_to: 3 });
    await hit();
    await c.state();
    await hit();
    assert.equal(await redesign(), 0);
    await hit();
    assert.equal(await redesign(), 3);
    assert.equal((await c.state()).faults.redesign_after_requests, null, '切完即关闭');
    await hit();
    assert.deepEqual(await switches(), [{ from: 0, to: 3, by: 'requests' }], '只切一次');

    // 时间：还没到点不切；到点后的下一个请求切（0 毫秒即下一个请求）；改成 null 即取消
    await c.faults({ redesign: 0, redesign_after_ms: 3_600_000, redesign_to: 1 });
    await hit();
    assert.equal(await redesign(), 0);
    await c.faults({ redesign_after_ms: 0 });
    await hit();
    assert.equal(await redesign(), 1);
    assert.deepEqual((await switches()).at(-1), { from: 0, to: 1, by: 'ms' });
    await c.faults({ redesign: 0, redesign_after_requests: 1 });
    await c.faults({ redesign_after_requests: null });
    await hit();
    await hit();
    assert.equal(await redesign(), 0);
  });

  test('故障：提交超时与丢弃响应对写接口都是“已落库但客户端拿不到响应”，重试同一个键才会被记成重复（lab-1）', async () => {
    const c = control(lab, 'cw');
    await c.faults({ commit_timeout: true });
    await assert.rejects(post('cw', '/api/counter/3', { key: 'once' }, AbortSignal.timeout(300)));
    await c.faults({ commit_timeout: false, drop_rate: 1 });
    await assert.rejects(post('cw', '/api/counter/4', { key: 'dropped' }));
    await c.faults({ drop_rate: 0 });
    const s = await c.state();
    assert.equal((s.modules.counter as { n: number }).n, 7, '两次写操作都已执行');
    assert.deepEqual(
      s.submissions.map((x) => [x.key, x.count]),
      [
        ['once', 1],
        ['dropped', 1],
      ],
    );
    assert.ok(s.log.some((x) => x.type === 'fault_commit_timeout'));
    // 盲目重试的实现在对账里会露馅
    await post('cw', '/api/counter/4', { key: 'dropped' });
    assert.equal((await c.state()).submissions.find((x) => x.key === 'dropped')?.count, 2);
  });
});
