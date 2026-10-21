// Lab 模块：登录与账号（PRD 9.3；FR-02、FR-08、FR-20、FR-22；BW-8 的被测页面）。
// 协议层（fetch）：锁定、解锁幂等键、人机验证主流程；浏览器层（observe + act）：登录跳回 next、
// 错 3 次锁定、dave 的人机验证、会话过期、退出登录、改版变体。等待都是条件等待。
//
// 这里只装配 auth 和一个测试用的受保护页面（vault），不加载 lab/src/modules 下的其他模块：
// 并行开发时别的模块写到一半不会连累本文件。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { type ActOptions, act, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult, PageSignature } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { createLab, type Lab } from '../src/app.ts';
import { esc, type LabModule, page } from '../src/core.ts';
import auth, { INITIAL_USERS, MAX_FAILS } from '../src/modules/auth.ts';
import { CHROME, control, SKIP } from './helpers.ts';

const contracts = new Contracts();

/** 测试用模块：一个需要登录的页面，用来验证带查询串的 next 能原样跳回。 */
const vault: LabModule = {
  name: 'vault',
  title: '保险库',
  nav: '/vault',
  init(space) {
    space.data.vault = {};
  },
  routes(r) {
    r.get(
      '/vault',
      (ctx) =>
        ctx.html(
          page(
            ctx,
            [auth, vault],
            '保险库',
            `<h1>保险库</h1><p>标签：${esc(ctx.url.searchParams.get('tab') ?? '无')}</p>`,
          ),
        ),
      { auth: true },
    );
  },
};

type AuthState = {
  users: Record<
    string,
    {
      locked: boolean;
      fails: number;
      last_login: string | null;
      logins: number;
      require_verify: boolean;
    }
  >;
  pending_verifications: number;
  verify: { issued: number; passed: number };
};

let lab: Lab;
const authState = async (space: string) =>
  (await control(lab, space).state()).modules.auth as AuthState;

before(async () => {
  lab = await createLab({ modules: [auth, vault] });
});
after(async () => {
  await lab?.close();
});

// ---------------------------------------------------------------------------------------------
// 协议层
// ---------------------------------------------------------------------------------------------

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
      const kv = c.split(';')[0] as string;
      const i = kv.indexOf('=');
      const name = kv.slice(0, i);
      const value = kv.slice(i + 1);
      if (!value || /Max-Age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  get(path: string) {
    return this.req(path);
  }
  form(path: string, fields: Record<string, string>) {
    return this.req(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }
  /** 提交登录表单（密码默认是该用户的正确密码）。 */
  login(username: string, password?: string, next?: string) {
    const pw = password ?? INITIAL_USERS.find((u) => u.name === username)?.password ?? '';
    return this.form('/login', { username, password: pw, ...(next === undefined ? {} : { next }) });
  }
}

describe('登录与账号：协议层', () => {
  test('登录时间属于当前会话：同一账号在另一个浏览器后来登录，先登录的会话仍显示自己的时间', async () => {
    const sp = 'auth-session-time';
    const a = new Client(sp);
    const b = new Client(sp);
    await a.login('alice');
    // 等到毫秒数前进，保证两次登录的时间戳不同（条件等待，不是固定延时）
    const t0 = Date.now();
    while (Date.now() === t0) await new Promise((r) => setTimeout(r, 1));
    await b.login('alice');
    const loginAt = async (c: Client) =>
      ((await (await c.get('/api/auth/me')).json()) as { logged_in_at: string }).logged_in_at;
    const [ta, tb] = [await loginAt(a), await loginAt(b)];
    assert.ok(Date.parse(ta) < Date.parse(tb), `A ${ta} 应早于 B ${tb}`);
    // 账号页显示的也是各自会话的时间
    assert.match(await (await a.get('/account')).text(), new RegExp(`datetime="${ta}"`));
    assert.match(await (await b.get('/account')).text(), new RegExp(`datetime="${tb}"`));
  });

  test('next 含中文等非 ASCII 字符：登录成功后按 UTF-8 百分号编码跳回，已有的 %xx 保持原样', async () => {
    const sp = 'auth-next-utf8';
    const r = await new Client(sp).login('alice', undefined, '/vault?q=订单#位置');
    assert.equal(r.status, 303, '之前这里是 500，而且会话已经建立');
    assert.equal(
      r.headers.get('location'),
      `/s/${sp}/vault?q=%E8%AE%A2%E5%8D%95#%E4%BD%8D%E7%BD%AE`,
    );
    const r2 = await new Client(sp).login('alice', undefined, '/vault?q=%E8%AE%A2');
    assert.equal(r2.headers.get('location'), `/s/${sp}/vault?q=%E8%AE%A2`);
  });

  test('next 只接受本空间内的路径：外站地址和 . / .. 段（含 %2e）回账号页，文件名里的 .. 不受影响', async () => {
    const sp = 'auth-next-dots';
    for (const next of [
      '/../other/orders',
      '/%2e%2e/other/orders',
      '/orders/%2E/x',
      `/s/${sp}/../other/orders`,
      '//evil.example/x',
      'http://evil.example/x',
    ]) {
      const r = await new Client(sp).login('alice', undefined, next);
      assert.equal(r.headers.get('location'), `/s/${sp}/account`, next);
    }
    const r = await new Client(sp).login('alice', undefined, '/vault/a..b?tab=1&from=..');
    assert.equal(r.headers.get('location'), `/s/${sp}/vault/a..b?tab=1&from=..`);
  });

  test('锁定：连续 3 次错误锁定，锁定后密码对也进不去；成功登录清零计数；各账号互不影响', async () => {
    const sp = 'auth-lock';
    const c = new Client(sp);
    // bob：错 2 次后登录成功，计数清零，再错 2 次仍未锁定
    await c.login('bob', 'x');
    await c.login('bob', 'x');
    assert.equal((await c.login('bob')).status, 303);
    assert.equal((await authState(sp)).users.bob?.fails, 0);
    const other = new Client(sp);
    await other.login('bob', 'x');
    await other.login('bob', 'x');
    assert.equal((await authState(sp)).users.bob?.locked, false);

    // carol：错 3 次锁定；第 3 次起显示“账号已锁定”
    const t1 = await (await other.login('carol', 'x')).text();
    assert.match(t1, /再错 2 次/);
    assert.doesNotMatch(t1, /账号已锁定/);
    await other.login('carol', 'x');
    const t3 = await (await other.login('carol', 'x')).text();
    assert.match(t3, new RegExp(`账号已锁定：密码连续错误 ${MAX_FAILS} 次`));
    const after = await other.login('carol');
    assert.equal(after.status, 200, '锁定后密码正确也不能登录');
    assert.match(await after.text(), /账号已锁定，请联系管理员解锁/);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    const s = await authState(sp);
    assert.equal(s.users.carol?.locked, true);
    assert.equal(s.users.carol?.fails, MAX_FAILS, '锁定后不再累加');
    assert.equal(s.users.carol?.logins, 0);
    assert.equal(s.users.alice?.locked, false);
    assert.equal(s.users.bob?.locked, false);
    // 别的账号照常登录
    assert.equal((await new Client(sp).login('alice')).status, 303);
    const log = (await control(lab, sp).state()).log;
    assert.equal(log.filter((x) => x.type === 'locked').length, 1);
  });

  test('解锁接口：按账号或全部解锁，记录幂等键，未知账号 404', async () => {
    const sp = 'auth-unlock';
    const c = new Client(sp);
    for (const u of ['bob', 'carol']) for (let i = 0; i < MAX_FAILS; i++) await c.login(u, 'x');
    assert.deepEqual(
      Object.entries((await authState(sp)).users)
        .filter(([, u]) => u.locked)
        .map(([k]) => k),
      ['bob', 'carol'],
    );
    const post = (body: unknown) =>
      c.req('/api/auth/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const one = await post({ user: 'carol', key: 'unlock-1' });
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { ok: true, unlocked: ['carol'] });
    const s1 = await authState(sp);
    assert.deepEqual([s1.users.carol?.locked, s1.users.carol?.fails], [false, 0]);
    assert.equal(s1.users.bob?.locked, true, '只解锁指定账号');
    assert.equal((await c.login('carol')).status, 303, '解锁后能登录');
    await post({ user: 'carol', key: 'unlock-1' });
    const subs = (await control(lab, sp).state()).submissions;
    const sub = subs.find((x) => x.key === 'unlock-1');
    assert.equal(sub?.op, 'auth.unlock');
    assert.equal(sub?.count, 2, '同一幂等键重复提交按次数记录');
  });

  test('人机验证（协议层）：dave 密码对后先到 /verify，勾选并继续才建立会话', async () => {
    const sp = 'auth-verify';
    const c = new Client(sp);
    assert.equal(
      (await c.get('/verify')).headers.get('location'),
      `/s/${sp}/login`,
      '没有待验证登录',
    );
    // 密码错的 dave 不会到验证页
    const bad = await c.login('dave', 'x');
    assert.equal(bad.status, 200);

    const r = await c.login('dave', undefined, '/vault?tab=4');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `/s/${sp}/verify`);
    assert.equal((await c.get('/api/auth/me')).status, 401, '验证前没有会话');
    assert.equal((await c.get('/account')).status, 303, '验证前不能进账号页');
    let s = await authState(sp);
    assert.deepEqual([s.pending_verifications, s.verify], [1, { issued: 1, passed: 0 }]);
    assert.equal(s.users.dave?.logins, 0);

    const html = await (await c.get('/verify')).text();
    assert.match(html, /<title>安全验证 - Obact Lab<\/title>/);
    assert.match(html, /data-captcha="mock"/);
    assert.match(html, /<input type="checkbox" id="human" name="human" value="1"> 我不是机器人/);
    assert.match(html, /<button type="submit"[^>]*>继续<\/button>/);
    assert.doesNotMatch(html, /class="lab-nav"/, '验证页不带导航');

    const miss = await c.form('/verify', {});
    assert.equal(miss.status, 200);
    assert.match(await miss.text(), /请先勾选“我不是机器人”/);
    assert.equal((await c.get('/api/auth/me')).status, 401, '没勾选不算登录');

    const done = await c.form('/verify', { human: '1' });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), `/s/${sp}/vault?tab=4`, '验证后回到 next');
    assert.equal(((await (await c.get('/api/auth/me')).json()) as { user: string }).user, 'dave');
    s = await authState(sp);
    assert.deepEqual([s.pending_verifications, s.verify], [0, { issued: 1, passed: 1 }]);
    assert.equal(s.users.dave?.logins, 1);
    // 验证令牌用完即废
    assert.equal((await c.get('/verify')).headers.get('location'), `/s/${sp}/login`);
    assert.equal(
      (await c.form('/verify', { human: '1' })).headers.get('location'),
      `/s/${sp}/login`,
    );
    // 再登录一次还要再验证
    const again = await c.login('dave');
    assert.equal(again.headers.get('location'), `/s/${sp}/verify`);
    assert.equal((await authState(sp)).verify.issued, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// 浏览器层：observe + act
// ---------------------------------------------------------------------------------------------

/** 页面签名（FR-08）：登录页、人机验证页、账号页。 */
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
  { id: 'account', url: '/account$', must_exist: [{ css: '[data-account-user]' }] },
];

type Env = { browser: Browser; session: Session; profileDir: string };

describe('登录与账号：浏览器流程（observe + act）', { skip: SKIP }, () => {
  let env: Env;
  const opened: string[] = [];

  before(async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'obact-lab-auth-'));
    const browser = await launchBrowser({
      profileDir,
      chromePath: CHROME,
      mode: process.env.HEADED === '1' ? 'headed' : 'headless',
    });
    env = { browser, session: await Session.attach(browser), profileDir };
  });
  after(async () => {
    await env?.session.close({ closeBrowser: true });
    if (env) rmSync(env.profileDir, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const pageId of opened.splice(0)) {
      await act(env.session, { op: 'close_page', pageId }).catch(() => {});
    }
  });

  const open = async (space: string, path: string): Promise<string> => {
    const pageId = await env.session.pages.newPage();
    opened.push(pageId);
    await env.session.pages.get(pageId).goto(lab.url(space) + path, { waitUntil: 'load' });
    return pageId;
  };

  async function run(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await act(env.session, a, { signatures: SIGS, ...opts });
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await run(a, opts);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const ob = async (pageId: string) => {
    const r = await observe(env.session, { pageId }, { signatures: SIGS });
    contracts.assert('observe.Result', r);
    return r;
  };
  const url = (pageId: string) => env.session.pages.get(pageId).url();

  const USER = { role: 'textbox', name: '账号' };
  const PASS = { role: 'textbox', name: '密码' };
  const LOGIN_BTN = { role: 'button', name: '登录' };

  /**
   * 在登录页填写并点“登录”。post 是提交后要等到的检查（默认等到离开登录页或出现错误提示）。
   * 登录页和提交后的页面都是整页加载，检查通过即说明新页面已就绪。
   */
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
        { target: USER, value: user },
        { target: PASS, value: password },
      ],
    });
    return ok({ op: 'click', pageId, target: LOGIN_BTN, post });
  }

  const meStatus = (pageId: string, space: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(async (u) => (await fetch(u)).status, `/s/${space}/api/auth/me`);

  test('正常登录：被拦到登录页（签名 login），登录后跳回带查询串的原页面', async () => {
    const sp = 'auth-b-next';
    const pageId = await open(sp, '/vault?tab=2');
    assert.match(url(pageId), new RegExp(`/s/${sp}/login\\?next=%2Fvault%3Ftab%3D2$`));
    const first = await ob(pageId);
    assert.equal(first.signature, 'login');
    assert.equal(
      first.elements.find((e) => e.role === 'textbox' && e.name === '密码')?.input_type,
      'password',
    );
    assert.ok(first.elements.some((e) => e.role === 'button' && e.name === '登录'));
    assert.match(first.text_md, /请先登录后再访问该页面/);

    const r = await submitLogin(pageId, 'alice', 'alice123', [
      { url_matches: '/vault\\?tab=2$' },
      { text_present: '标签：2' },
    ]);
    assert.equal(r.effects.navigated, true);
    assert.match(url(pageId), new RegExp(`/s/${sp}/vault\\?tab=2$`));
    await ok({
      op: 'assert',
      pageId,
      checks: [{ element_present: { css: '.lab-user' } }, { text_present: 'alice' }],
    });
    assert.equal((await ob(pageId)).signature, null, '保险库页不属于任何登录签名');

    // 去账号页：显示当前用户和登录时间
    await ok({
      op: 'click',
      pageId,
      target: { role: 'link', name: '账号' },
      post: [{ signature: 'account' }],
    });
    await ok({
      op: 'assert',
      pageId,
      checks: [
        { text_present: '当前用户：alice' },
        { text_present: '登录时间：' },
        { element_present: { css: 'time#login-time' } },
        { value_equals: { target: { css: '#current-user' }, value: 'alice' } },
      ],
    });
    const st = (await authState(sp)).users.alice;
    assert.equal(st?.logins, 1);
    assert.ok(st?.last_login);
    assert.equal(await meStatus(pageId, sp), 200);
  });

  test('没有 next 时登录后进账号页；用 act 直接导航到登录页也一样', async () => {
    const sp = 'auth-b-plain';
    const pageId = await open(sp, '/login');
    const o = await ob(pageId);
    assert.equal(o.signature, 'login');
    assert.doesNotMatch(o.text_md, /请先登录/);
    await submitLogin(pageId, 'bob', 'bob123', [{ signature: 'account' }]);
    await ok({ op: 'assert', pageId, checks: [{ text_present: '当前用户：bob' }] });
    // 已登录再去 /login 仍是登录页；换成 alice 登录会换掉会话
    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${lab.url(sp)}/login`,
      post: [{ signature: 'login' }],
    });
    await submitLogin(pageId, 'alice', 'alice123', [{ text_present: '当前用户：alice' }]);
    assert.deepEqual(
      (await control(lab, sp).state()).sessions.map((x) => x.user),
      ['alice'],
    );
  });

  test('错 3 次锁定：每次的提示、锁定后密码对也进不去、解锁后能登录', async () => {
    const sp = 'auth-b-lock';
    const pageId = await open(sp, '/login?next=%2Fvault%3Ftab%3D3');
    await submitLogin(pageId, 'carol', 'wrong-1', [
      { text_present: '密码错误，再错 2 次将锁定账号' },
    ]);
    assert.equal((await ob(pageId)).signature, 'login');
    assert.equal((await authState(sp)).users.carol?.fails, 1);
    // 错误后账号框保留原值
    await ok({
      op: 'assert',
      pageId,
      checks: [{ value_equals: { target: USER, value: 'carol' } }],
    });
    await submitLogin(pageId, 'carol', 'wrong-2', [{ text_present: '再错 1 次将锁定账号' }]);
    await ok({ op: 'assert', pageId, checks: [{ text_absent: '账号已锁定' }] });

    await submitLogin(pageId, 'carol', 'wrong-3', [{ text_present: '账号已锁定' }]);
    let s = await authState(sp);
    assert.equal(s.users.carol?.locked, true);
    assert.equal(s.users.carol?.fails, MAX_FAILS);
    assert.equal((await ob(pageId)).signature, 'login', '锁定后仍停在登录页');

    // 锁定后，密码对也不行
    await submitLogin(pageId, 'carol', 'carol123', [{ text_present: '请联系管理员解锁' }]);
    s = await authState(sp);
    assert.equal(s.users.carol?.logins, 0);
    assert.equal((await control(lab, sp).state()).sessions.length, 0);
    // 别的账号不受影响，但这里只验证它没被牵连
    assert.deepEqual([s.users.alice?.locked, s.users.alice?.fails], [false, 0]);

    // 解锁接口复位后，同一个页面上登录成功并回到 next（next 在整个重试过程中一直保留）
    const un = await fetch(`${lab.url(sp)}/api/auth/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'carol', key: 'b-lock-unlock' }),
    });
    assert.equal(un.status, 200);
    await submitLogin(pageId, 'carol', 'carol123', [{ url_matches: '/vault\\?tab=3$' }]);
    s = await authState(sp);
    assert.deepEqual(
      [s.users.carol?.locked, s.users.carol?.fails, s.users.carol?.logins],
      [false, 0, 1],
    );
  });

  test('dave 人机验证：用页面签名识别验证页；没勾选不算登录；勾选后才登录；每次登录都要验证', async () => {
    const sp = 'auth-b-dave';
    const pageId = await open(sp, '/login?next=%2Fvault%3Ftab%3D5');
    await submitLogin(pageId, 'dave', 'dave123', [{ signature: 'captcha' }]);

    // observe 带签名：识别出验证页（BW-8），登录签名不会同时命中
    const cap = await ob(pageId);
    assert.equal(cap.signature, 'captcha');
    assert.match(url(pageId), new RegExp(`/s/${sp}/verify$`));
    const box = cap.elements.find((e) => e.role === 'checkbox');
    assert.equal(box?.name, '我不是机器人');
    assert.ok(cap.elements.some((e) => e.role === 'button' && e.name === '继续'));
    assert.ok(!cap.elements.some((e) => e.role === 'textbox'), '验证页没有账号密码框');
    const signed = await observe(
      env.session,
      { pageId },
      { signatures: SIGS.filter((x) => x.id !== 'captcha') },
    );
    assert.equal(signed.signature, null, '没有 captcha 签名时认不出验证页');
    await ok({ op: 'assert', pageId, checks: [{ signature: 'captcha' }] });

    // 验证前没有会话
    let s = await authState(sp);
    assert.equal(s.users.dave?.logins, 0);
    assert.equal(s.pending_verifications, 1);
    assert.equal((await control(lab, sp).state()).sessions.length, 0);
    assert.equal(await meStatus(pageId, sp), 401);

    // 绕过验证直接去账号页：被拦回登录页（next 指向账号页）
    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${lab.url(sp)}/account`,
      post: [{ signature: 'login' }],
    });
    assert.match(url(pageId), /login\?next=%2Faccount$/);
    // 验证令牌还有效：回到验证页继续
    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${lab.url(sp)}/verify`,
      post: [{ signature: 'captcha' }],
    });

    // 没勾选就点“继续”：提示并停在验证页，仍未登录
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '继续' },
      post: [{ text_present: '请先勾选“我不是机器人”' }],
    });
    assert.equal((await ob(pageId)).signature, 'captcha');
    assert.equal(await meStatus(pageId, sp), 401);
    assert.equal((await authState(sp)).users.dave?.logins, 0);

    // 勾选后继续：登录成功，回到最初的 next
    await ok({ op: 'click', pageId, target: { role: 'checkbox', name: '我不是机器人' } });
    await ok({
      op: 'assert',
      pageId,
      checks: [{ expr: "document.getElementById('human').checked === true" }],
    });
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '继续' },
      post: [{ url_matches: '/vault\\?tab=5$' }, { text_present: '标签：5' }],
    });
    s = await authState(sp);
    assert.equal(s.users.dave?.logins, 1);
    assert.ok(s.users.dave?.last_login);
    assert.deepEqual([s.pending_verifications, s.verify], [0, { issued: 1, passed: 1 }]);
    assert.deepEqual(
      (await control(lab, sp).state()).sessions.map((x) => x.user),
      ['dave'],
    );
    assert.equal(await meStatus(pageId, sp), 200);

    // 退出后再登录：dave 每次登录都要验证
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '退出登录' },
      post: [{ signature: 'login' }],
    });
    await submitLogin(pageId, 'dave', 'dave123', [{ signature: 'captcha' }]);
    assert.equal((await authState(sp)).verify.issued, 2);
    assert.equal(await meStatus(pageId, sp), 401);
  });

  test('会话过期：设小 session_ttl_ms 后再访问被跳回登录页，重新登录后回到原页面', async () => {
    const sp = 'auth-b-ttl';
    const pageId = await open(sp, '/vault?tab=3');
    await submitLogin(pageId, 'alice', 'alice123', [{ text_present: '标签：3' }]);

    await control(lab, sp).faults({ session_ttl_ms: 300 });
    // 条件等待：接口开始返回 401，说明会话已过期（页面内轮询）
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ expr: `(await fetch('/s/${sp}/api/auth/me')).status === 401` }],
      timeout_ms: 10_000,
    });
    // 过期后再访问需要登录的页面：跳到 /login?next=...
    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${lab.url(sp)}/vault?tab=3`,
      post: [{ signature: 'login' }],
    });
    assert.match(url(pageId), new RegExp(`/s/${sp}/login\\?next=%2Fvault%3Ftab%3D3$`));
    const o = await ob(pageId);
    assert.equal(o.signature, 'login');
    assert.match(o.text_md, /请先登录后再访问该页面/);
    assert.ok((await control(lab, sp).state()).log.some((x) => x.type === 'session_expired'));
    assert.equal((await control(lab, sp).state()).sessions.length, 0);

    // 重新登录（先把过期时间还原，免得新会话马上又过期）：回到原页面，查询串还在
    await control(lab, sp).faults({ session_ttl_ms: null });
    await submitLogin(pageId, 'alice', 'alice123', [
      { url_matches: '/vault\\?tab=3$' },
      { text_present: '标签：3' },
    ]);
    assert.equal(await meStatus(pageId, sp), 200);
    assert.equal((await authState(sp)).users.alice?.logins, 2);
  });

  test('退出登录：点导航栏的“退出登录”，回到登录页，会话销毁，再访问需要登录', async () => {
    const sp = 'auth-b-logout';
    const pageId = await open(sp, '/account');
    assert.equal((await ob(pageId)).signature, 'login');
    await submitLogin(pageId, 'bob', 'bob123', [{ signature: 'account' }]);
    const before = await ob(pageId);
    assert.equal(before.signature, 'account');
    assert.ok(before.elements.some((e) => e.role === 'button' && e.name === '退出登录'));
    assert.equal((await control(lab, sp).state()).sessions.length, 1);

    const r = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '退出登录' },
      post: [{ signature: 'login' }, { text_present: '已退出登录' }],
    });
    assert.equal(r.effects.navigated, true);
    assert.match(url(pageId), new RegExp(`/s/${sp}/login\\?out=1$`));
    const after = await ob(pageId);
    assert.ok(!after.elements.some((e) => e.name === '退出登录'), '退出后导航栏没有退出按钮');
    assert.equal((await control(lab, sp).state()).sessions.length, 0);
    assert.equal(await meStatus(pageId, sp), 401);

    await ok({
      op: 'navigate_page',
      pageId,
      type: 'url',
      url: `${lab.url(sp)}/account`,
      post: [{ signature: 'login' }],
    });
    assert.match(url(pageId), /login\?next=%2Faccount$/);
    // 重新登录回到账号页
    await submitLogin(pageId, 'bob', 'bob123', [{ signature: 'account' }]);
    assert.equal((await authState(sp)).users.bob?.logins, 2);
  });

  test('改版变体：改 id 后按 id 定位失败而按角色名称仍可用；改文案后登录签名不再命中', async () => {
    const sp = 'auth-b-redesign';
    const ctl = control(lab, sp);
    const pageId = await open(sp, '/login');
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
    assert.equal(stale.status, 'error');
    assert.equal(stale.error?.code, 'not_found', stale.error?.message);
    assert.equal((await ob(pageId)).signature, 'login', '只改 id，页面签名仍然命中');
    await submitLogin(pageId, 'alice', 'alice123', [{ signature: 'account' }]);
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '退出登录' },
      post: [{ signature: 'login' }],
    });

    await ctl.faults({ redesign: 2 });
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    const o = await ob(pageId);
    assert.equal(o.signature, null, '改文案后“账号”文本框找不到，签名不再命中：用来尽早发现改版');
    assert.ok(o.elements.some((e) => e.role === 'textbox' && e.name === '用户名'));
    const miss = await run({ op: 'click', pageId, target: LOGIN_BTN, timeout_ms: 1000 });
    assert.equal(miss.status, 'error');
    assert.equal(miss.error?.code, 'not_found', miss.error?.message);
  });
});
