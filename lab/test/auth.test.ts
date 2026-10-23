// Lab 模块：登录与账号（PRD 9.3；FR-02、FR-08、FR-20、FR-22；BW-8 的被测页面）。
// 协议层（fetch）：登录时间、next 的安全处理、锁定与解锁、人机验证主流程；
// 浏览器层（observe + act）：登录跳回 next、dave 的人机验证、会话过期、改版变体。等待都是条件等待。
// 只装配 auth 模块：登录后的跳转目标用账号页自己（/account?tab=…，查询串原样保留）。
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { ActOptions } from '@obact/core';
import type { Action, ActResult, PageSignature } from '@obact/schemas';
import { createLab, type Lab } from '../src/app.ts';
import auth, { INITIAL_USERS, MAX_FAILS } from '../src/modules/auth.ts';
import { control, type LabEnv, SKIP, setup } from './helpers.ts';

type AuthState = {
  users: Record<string, { locked: boolean; fails: number; logins: number }>;
  pending_verifications: number;
  verify: { issued: number; passed: number };
};

describe('登录与账号：协议层', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth] });
  });
  after(async () => {
    await lab?.close();
  });

  const authState = async (space: string) =>
    (await control(lab, space).state()).modules.auth as AuthState;

  /** 带 cookie 罐的最小客户端；不自动跟随跳转，方便检查 Location。 */
  class Client {
    readonly cookies = new Map<string, string>();
    readonly space: string;
    constructor(space: string) {
      this.space = space;
    }
    async req(path: string, init: RequestInit = {}): Promise<Response> {
      const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${lab.url(this.space)}${path}`, {
        ...init,
        redirect: 'manual',
        headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) },
      });
      // 按顺序处理 Set-Cookie：先删后设时，最终是新值（浏览器同样如此）
      for (const c of res.headers.getSetCookie()) {
        const [name = '', value = ''] = (c.split(';')[0] ?? '').split('=');
        if (!value || /Max-Age=0/i.test(c)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      return res;
    }
    get(path: string) {
      return this.req(path);
    }
    form(path: string, fields: Record<string, string>) {
      const body = new URLSearchParams(fields).toString();
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      return this.req(path, { method: 'POST', headers, body });
    }
    /** 提交登录表单（密码默认是该用户的正确密码）。 */
    login(username: string, password?: string, next?: string) {
      const pw = password ?? INITIAL_USERS.find((u) => u.name === username)?.password ?? '';
      return this.form('/login', { username, password: pw, ...(next ? { next } : {}) });
    }
  }

  test('登录时间属于当前会话：同一账号在另一个浏览器后来登录，先登录的会话仍显示自己的时间（lab-13）', async () => {
    const a = new Client('auth-session-time');
    const b = new Client('auth-session-time');
    await a.login('alice');
    // 等到毫秒数前进，保证两次登录的时间戳不同（条件等待，不是固定延时）
    for (const t0 = Date.now(); Date.now() === t0; ) await new Promise((r) => setTimeout(r, 1));
    await b.login('alice');
    const loginAt = async (c: Client) =>
      ((await (await c.get('/api/auth/me')).json()) as { logged_in_at: string }).logged_in_at;
    const [ta, tb] = [await loginAt(a), await loginAt(b)];
    assert.ok(Date.parse(ta) < Date.parse(tb), `A ${ta} 应早于 B ${tb}`);
    assert.match(await (await a.get('/account')).text(), new RegExp(`datetime="${ta}"`));
  });

  test('next 只接受本空间内的路径（lab-6）；含中文等非 ASCII 字符时按 UTF-8 百分号编码跳回，不是 500（lab-7）', async () => {
    const sp = 'auth-next';
    const location = async (next: string) =>
      (await new Client(sp).login('alice', undefined, next)).headers.get('location');
    for (const next of [
      '/../other/orders',
      '/%2e%2e/other/orders',
      `/s/${sp}/../other/orders`,
      '//evil.example/x',
      'http://evil.example/x',
    ]) {
      assert.equal(await location(next), `/s/${sp}/account`, next);
    }
    assert.equal(await location('/vault/a..b?from=..'), `/s/${sp}/vault/a..b?from=..`);
    assert.equal(
      await location('/account?q=订单#位置'),
      `/s/${sp}/account?q=%E8%AE%A2%E5%8D%95#%E4%BD%8D%E7%BD%AE`,
    );
    assert.equal(await location('/account?q=%E8%AE%A2'), `/s/${sp}/account?q=%E8%AE%A2`);
  });

  test('锁定：连续 3 次错误锁定（成功登录清零计数），锁定后密码对也进不去；解锁接口按账号解锁并记录幂等键', async () => {
    const sp = 'auth-lock';
    const c = new Client(sp);
    await c.login('bob', 'x');
    await c.login('bob', 'x');
    assert.equal((await c.login('bob')).status, 303);
    assert.equal((await authState(sp)).users.bob?.fails, 0, '成功登录清零计数');

    for (let i = 0; i < MAX_FAILS; i++) await c.login('carol', 'x');
    const locked = await c.login('carol');
    assert.equal(locked.status, 200, '锁定后密码正确也不能登录');
    assert.match(await locked.text(), /账号已锁定/);
    let s = await authState(sp);
    assert.deepEqual(
      [s.users.carol?.locked, s.users.carol?.fails, s.users.carol?.logins],
      [true, MAX_FAILS, 0],
    );
    assert.equal((await new Client(sp).login('alice')).status, 303, '别的账号照常登录');

    const unlock = (user: string) => c.form('/api/auth/unlock', { user, key: 'unlock-1' });
    assert.deepEqual(await (await unlock('carol')).json(), { ok: true, unlocked: ['carol'] });
    s = await authState(sp);
    assert.deepEqual([s.users.carol?.locked, s.users.carol?.fails], [false, 0]);
    assert.equal((await c.login('carol')).status, 303, '解锁后能登录');
    await unlock('carol');
    const sub = (await control(lab, sp).state()).submissions.find((x) => x.key === 'unlock-1');
    assert.deepEqual([sub?.op, sub?.count], ['auth.unlock', 2], '同一幂等键重复提交按次数记录');
    assert.equal((await unlock('nobody')).status, 404);
  });

  test('人机验证（BW-8）：dave 密码对后先到 /verify，勾选并继续才建立会话，令牌用完即废', async () => {
    const sp = 'auth-verify';
    const c = new Client(sp);
    assert.equal((await c.get('/verify')).headers.get('location'), `/s/${sp}/login`);

    const r = await c.login('dave', undefined, '/account?tab=4');
    assert.equal(r.headers.get('location'), `/s/${sp}/verify`);
    assert.equal((await c.get('/api/auth/me')).status, 401, '验证前没有会话');
    assert.equal((await c.get('/account')).status, 303, '绕过验证直接进账号页被拦回登录页');
    let s = await authState(sp);
    assert.deepEqual([s.pending_verifications, s.verify], [1, { issued: 1, passed: 0 }]);
    assert.match(await (await c.get('/verify')).text(), /data-captcha="mock"/);

    const miss = await c.form('/verify', {});
    assert.match(await miss.text(), /请先勾选“我不是机器人”/);
    assert.equal((await c.get('/api/auth/me')).status, 401, '没勾选不算登录');

    const done = await c.form('/verify', { human: '1' });
    assert.equal(done.headers.get('location'), `/s/${sp}/account?tab=4`, '验证后回到 next');
    assert.equal(((await (await c.get('/api/auth/me')).json()) as { user: string }).user, 'dave');
    s = await authState(sp);
    assert.deepEqual([s.pending_verifications, s.verify], [0, { issued: 1, passed: 1 }]);
    assert.equal((await c.get('/verify')).headers.get('location'), `/s/${sp}/login`);
    assert.equal(
      (await c.login('dave')).headers.get('location'),
      `/s/${sp}/verify`,
      '每次登录都要验证',
    );
  });
});

/** 页面签名（FR-08）：登录页、人机验证页。 */
const SIGS: PageSignature[] = [
  {
    id: 'captcha',
    kind: 'captcha',
    url: '/verify(\\?|$)',
    title: '^安全验证',
    must_exist: [{ role: 'checkbox', name: '我不是机器人' }, { css: '[data-captcha="mock"]' }],
  },
  {
    id: 'login',
    kind: 'login',
    url: '/login(\\?|$)',
    title: '^登录',
    must_exist: [{ role: 'textbox', name: '账号' }, { css: 'input[type=password]' }],
  },
];

describe('登录与账号：浏览器流程（observe + act）', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [auth] });
  });
  after(async () => {
    await env?.close();
  });
  afterEach(() => env.closePages());

  const run = (a: Action, o?: ActOptions) => env.run(a, { signatures: SIGS, ...o });
  const ok = (a: Action, o?: ActOptions) => env.ok(a, { signatures: SIGS, ...o });
  const ob = (pageId: string) => env.look(pageId, { signatures: SIGS });
  const url = (pageId: string) => env.session.pages.get(pageId).url();
  const sessions = async (space: string) => (await control(env.lab, space).state()).sessions;
  const meStatus = (pageId: string, space: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(async (u) => (await fetch(u)).status, `/s/${space}/api/auth/me`);

  const LOGIN_BTN = { role: 'button', name: '登录' };

  /** 在登录页填写并点“登录”；post 是提交后要等到的检查（登录页是整页加载，检查通过即新页面已就绪）。 */
  async function submitLogin(
    pageId: string,
    user: string,
    password: string,
    post: NonNullable<Action['post']>,
  ): Promise<ActResult> {
    await ok({
      op: 'fill_form',
      pageId,
      elements: [
        { target: { role: 'textbox', name: '账号' }, value: user },
        { target: { role: 'textbox', name: '密码' }, value: password },
      ],
    });
    return ok({ op: 'click', pageId, target: LOGIN_BTN, post });
  }
  const logout = (pageId: string) =>
    ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '退出登录' },
      post: [{ signature: 'login' }, { text_present: '已退出登录' }],
    });

  test('被拦到登录页（签名 login），登录后跳回带查询串的原页面；退出登录后会话销毁', async () => {
    const sp = 'auth-b-next';
    const pageId = await env.open(sp, '/account?tab=2');
    assert.match(url(pageId), new RegExp(`/s/${sp}/login\\?next=%2Faccount%3Ftab%3D2$`));
    const first = await ob(pageId);
    assert.equal(first.signature, 'login');
    assert.equal(first.elements.find((e) => e.name === '密码')?.input_type, 'password');

    const r = await submitLogin(pageId, 'alice', 'alice123', [
      { url_matches: '/account\\?tab=2$' },
    ]);
    assert.equal(r.effects.navigated, true);
    await ok({
      op: 'assert',
      pageId,
      checks: [
        { text_present: '当前用户：alice' },
        { value_equals: { target: { css: '#current-user' }, value: 'alice' } },
      ],
    });
    assert.equal(await meStatus(pageId, sp), 200);

    await logout(pageId);
    assert.deepEqual(await sessions(sp), []);
    assert.equal(await meStatus(pageId, sp), 401);
  });

  test('dave 人机验证（BW-8）：签名识别验证页；没勾选不算登录；勾选后回到 next', async () => {
    const sp = 'auth-b-dave';
    const pageId = await env.open(sp, '/login?next=%2Faccount%3Ftab%3D5');
    await submitLogin(pageId, 'dave', 'dave123', [{ signature: 'captcha' }]);
    const cap = await ob(pageId);
    assert.equal(cap.signature, 'captcha');
    assert.ok(cap.elements.some((e) => e.role === 'checkbox' && e.name === '我不是机器人'));
    assert.ok(!cap.elements.some((e) => e.role === 'textbox'), '验证页没有账号密码框');
    assert.deepEqual(await sessions(sp), [], '验证前没有会话');

    // 没勾选就点“继续”：提示并停在验证页，仍未登录
    const next = { role: 'button', name: '继续' };
    await ok({ op: 'click', pageId, target: next, post: [{ text_present: '请先勾选' }] });
    assert.equal(await meStatus(pageId, sp), 401);
    // 勾选后继续：登录成功，回到最初的 next
    await ok({ op: 'click', pageId, target: { role: 'checkbox', name: '我不是机器人' } });
    await ok({ op: 'click', pageId, target: next, post: [{ url_matches: '/account\\?tab=5$' }] });
    assert.deepEqual(
      (await sessions(sp)).map((x) => x.user),
      ['dave'],
    );
  });

  test('会话过期（session_ttl_ms，TS-07）：再访问被跳回登录页，重新登录后回到原页面', async () => {
    const sp = 'auth-b-ttl';
    const pageId = await env.open(sp, '/account?tab=3');
    await submitLogin(pageId, 'alice', 'alice123', [{ url_matches: '/account\\?tab=3$' }]);
    await control(env.lab, sp).faults({ session_ttl_ms: 1 });
    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${env.lab.url(sp)}/account?tab=3`,
      post: [{ signature: 'login' }, { text_present: '请先登录后再访问该页面' }],
    });
    // 先把过期时间还原，免得新会话马上又过期；重新登录后回到原页面，查询串还在
    await control(env.lab, sp).faults({ session_ttl_ms: null });
    await submitLogin(pageId, 'alice', 'alice123', [{ url_matches: '/account\\?tab=3$' }]);
    assert.equal(await meStatus(pageId, sp), 200);
  });

  test('改版变体（FR-07、FR-20）：改 id 后按 id 定位失败而按角色名称仍可用；改文案后登录签名不再命中', async () => {
    const sp = 'auth-b-redesign';
    const ctl = control(env.lab, sp);
    const pageId = await env.open(sp, '/login');
    assert.equal((await ob(pageId)).signature, 'login');
    await ok({ op: 'fill', pageId, target: { css: '#username' }, value: 'alice' });

    await ctl.faults({ redesign: 1 });
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    const stale = await run({
      op: 'fill',
      pageId,
      target: { css: '#username' },
      value: 'alice',
      timeout_ms: 1000,
    });
    assert.equal(stale.error?.code, 'not_found', stale.error?.message);
    assert.equal((await ob(pageId)).signature, 'login', '只改 id，页面签名仍然命中');
    await submitLogin(pageId, 'alice', 'alice123', [{ text_present: '当前用户：alice' }]);
    await logout(pageId);

    await ctl.faults({ redesign: 2 });
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    const o = await ob(pageId);
    assert.equal(o.signature, null, '改文案后“账号”文本框找不到，签名不再命中：用来尽早发现改版');
    assert.ok(o.elements.some((e) => e.role === 'textbox' && e.name === '用户名'));
    const miss = await run({ op: 'click', pageId, target: LOGIN_BTN, timeout_ms: 1000 });
    assert.equal(miss.error?.code, 'not_found', miss.error?.message);
  });
});
