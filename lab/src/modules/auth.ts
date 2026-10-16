/**
 * Obact Lab 模块：登录与账号（PRD 9.3；覆盖 FR-02、FR-08、FR-20、FR-22）。
 *
 * 页面：
 *   GET  /login          登录页（标题“登录”；账号、密码有 label；支持 ?next= 登录后跳回；?out=1 提示已退出）
 *   POST /login          提交：成功后跳到 next 或 /account；密码错误给提示；同一账号连续 3 次错误即锁定
 *   GET  /verify         模拟人机验证页（标题“安全验证”）：dave 登录时先到这里，勾选“我不是机器人”并点“继续”才算登录成功
 *   POST /verify         提交验证
 *   GET  /account        账号页（需要登录）：当前用户、登录时间
 *   POST /logout         退出登录（core 导航栏里的“退出登录”按钮提交到这里）
 * 接口：
 *   GET  /api/auth/me      当前用户与登录时间（需要登录，未登录 401），供测试判断会话是否有效
 *   POST /api/auth/unlock  解锁账号（写接口，记录幂等键）：{user?, key?}，不给 user 则解锁全部，供测试复位
 *
 * 会话过期：core 实现了 faults.session_ttl_ms，过期后访问需要登录的页面会被跳到 /login?next=...，
 * 登录页按 next 跳回。next 只接受本空间内的路径（相对空间根，或带空间前缀），其余一律回 /account。
 *
 * 改版变体（faults.redesign，只改登录页，每个变体只改一个方面）：
 *   1 改 id 与表单字段名  2 改文案（用户名、登录密码、立即登录）  3 改层级（多套几层容器，label 包住输入框）
 *   4 移位置（“登录”按钮移到输入框上方）。其余取值按原版。
 * 人机验证页不随改版变化：它是 BW-8“检测率 100%”的被测对象，签名必须稳定。
 *
 * 随机性：用户和密码是固定的，init 不消耗 space.rng()（不影响其他模块的数据）；
 * 验证令牌用 crypto 随机数（和 core 的会话令牌一样），不占用空间的随机序列。
 *
 * 页面签名参考（测试里用的就是这几条）：
 *   登录页  url /login、标题以“登录”开头、有“账号”文本框和密码框
 *   验证页  url /verify、标题以“安全验证”开头、有“我不是机器人”复选框和“继续”按钮、页面带 data-captcha="mock"
 *   账号页  url /account、有 [data-account-user]
 */
import { randomBytes } from 'node:crypto';
import { type Ctx, esc, type LabModule, page, type Space } from '../core.ts';

/** 连续输错几次密码后锁定。 */
export const MAX_FAILS = 3;

export type AuthUser = {
  name: string;
  password: string;
  /** 每次登录都要过人机验证。 */
  requireVerify: boolean;
  locked: boolean;
  /** 连续密码错误次数；登录成功清零。 */
  fails: number;
  /** 最近一次登录成功的时间（毫秒时间戳）。 */
  lastLoginAt: number | null;
  /** 登录成功的累计次数。 */
  logins: number;
};

/** 密码已对、等待人机验证的登录。 */
export type PendingVerify = { user: string; next: string; created: number };

export type AuthData = {
  users: Record<string, AuthUser>;
  /** 验证令牌 → 待验证的登录。 */
  pending: Record<string, PendingVerify>;
  verify: { issued: number; passed: number };
};

/** 初始用户：alice、bob 普通；carol 用于锁定测试；dave 每次登录都要人机验证。 */
export const INITIAL_USERS: readonly { name: string; password: string; requireVerify: boolean }[] =
  [
    { name: 'alice', password: 'alice123', requireVerify: false },
    { name: 'bob', password: 'bob123', requireVerify: false },
    { name: 'carol', password: 'carol123', requireVerify: false },
    { name: 'dave', password: 'dave123', requireVerify: true },
  ];

const PENDING_COOKIE = 'auth_pending';
const DEFAULT_NEXT = '/account';

const dataOf = (space: Space): AuthData => space.data.auth as AuthData;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 页面外壳用的模块列表：Ctx 没有完整列表，导航里只会有本模块（“账号”）。 */
const shellModules = (): readonly LabModule[] => [mod];

/**
 * 登录后的跳转目标：只接受本空间内的路径（相对空间根，或带空间前缀），
 * 拒绝外站地址（http://…、//…）、反斜杠、换行，以及登录页、验证页自身（避免循环）。
 */
export function safeNext(base: string, raw: unknown): string {
  const s = str(raw).trim();
  const p = s.startsWith(`${base}/`) ? s.slice(base.length) : s;
  if (!/^\/(?![/\\])/.test(p) || /[\r\n\\]/.test(p)) return DEFAULT_NEXT;
  if (/^\/(login|verify)(?:[?#]|$)/.test(p)) return DEFAULT_NEXT;
  return p;
}

/** 北京时间，如 2026-10-16 20:30:05。 */
function fmtTime(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
}

const STYLE = `<style>
  .auth-card { max-width: 360px; }
  .auth-card .field { margin: 10px 0; }
  .auth-card label { display: inline-block; min-width: 4em; }
  .auth-card input[type=text], .auth-card input[type=password] { padding: 4px 6px; width: 200px; }
  .auth-error { color: #b91c1c; }
  .auth-notice { color: #15803d; }
  .auth-hint { color: #666; font-size: 13px; }
  .auth-box { border: 1px solid #ccc; border-radius: 4px; padding: 12px 16px; margin: 12px 0; }
</style>`;

type LoginView = { next: string; username?: string; error?: string; notice?: string };

/** 登录页；faults.redesign 1~4 为改版变体。 */
function loginPage(ctx: Ctx, v: LoginView): string {
  const r = ctx.space.faults.redesign;
  const ids =
    r === 1
      ? { user: 'f-4e1a', pass: 'f-9c0b', btn: 'go-7d2e', uname: 'account', pname: 'passwd' }
      : {
          user: 'username',
          pass: 'password',
          btn: 'login-btn',
          uname: 'username',
          pname: 'password',
        };
  const labels =
    r === 2
      ? { user: '用户名', pass: '登录密码', btn: '立即登录' }
      : { user: '账号', pass: '密码', btn: '登录' };
  const field = (
    label: string,
    id: string,
    name: string,
    type: string,
    value: string,
    auto: string,
  ) => {
    const input = `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" autocomplete="${auto}">`;
    return r === 3
      ? `<label class="field">${esc(label)} ${input}</label>`
      : `<p class="field"><label for="${id}">${esc(label)}</label> ${input}</p>`;
  };
  const button = `<p class="field"><button type="submit" id="${ids.btn}">${esc(labels.btn)}</button></p>`;
  const fields =
    field(labels.user, ids.user, ids.uname, 'text', v.username ?? '', 'username') +
    field(labels.pass, ids.pass, ids.pname, 'password', '', 'current-password');
  const inner = r === 4 ? button + fields : fields + button;
  const form = `<form method="post" action="${ctx.base}/login" id="login-form">
  <input type="hidden" name="next" value="${esc(v.next)}">
  ${r === 3 ? `<div class="card"><div class="card-body"><fieldset><legend>账号登录</legend>${inner}</fieldset></div></div>` : inner}
</form>`;
  const msgs = [
    v.notice ? `<p class="auth-notice" role="status">${esc(v.notice)}</p>` : '',
    v.error ? `<p class="auth-error" role="alert">${esc(v.error)}</p>` : '',
  ].join('');
  return page(
    ctx,
    shellModules(),
    '登录',
    `<section class="auth-card" data-page="login">
<h1>登录</h1>
${msgs}
${form}
</section>`,
    { head: STYLE },
  );
}

function verifyPage(ctx: Ctx, error?: string): string {
  return page(
    ctx,
    shellModules(),
    '安全验证',
    `<section class="auth-card" data-page="verify" data-captcha="mock" aria-label="人机验证">
<h1>安全验证</h1>
<p>为了保护账号安全，请完成人机验证后继续。</p>
<p class="auth-hint">这是 Obact Lab 的模拟验证页，不连接任何真实验证服务。</p>
${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="${ctx.base}/verify" id="verify-form">
  <div class="auth-box"><label><input type="checkbox" id="human" name="human" value="1"> 我不是机器人</label></div>
  <p><button type="submit" id="verify-btn">继续</button></p>
</form>
</section>`,
    { head: STYLE, nav: false },
  );
}

/** 完成登录：换新会话（已登录时先清掉旧会话）并记账。 */
function finishLogin(ctx: Ctx, user: AuthUser): void {
  if (ctx.user) ctx.signOut();
  ctx.signIn(user.name);
  user.lastLoginAt = Date.now();
  user.logins++;
}

const mod: LabModule = {
  name: 'auth',
  title: '账号',
  nav: '/account',

  init(space) {
    const users: Record<string, AuthUser> = {};
    for (const u of INITIAL_USERS) {
      users[u.name] = { ...u, locked: false, fails: 0, lastLoginAt: null, logins: 0 };
    }
    const data: AuthData = { users, pending: {}, verify: { issued: 0, passed: 0 } };
    space.data.auth = data;
  },

  routes(r) {
    r.get('/login', (ctx) => {
      const next = safeNext(ctx.base, ctx.url.searchParams.get('next'));
      const hasNext = ctx.url.searchParams.has('next');
      const notice = ctx.url.searchParams.has('out')
        ? '已退出登录'
        : hasNext
          ? '请先登录后再访问该页面'
          : undefined;
      ctx.html(loginPage(ctx, { next: hasNext ? next : '', notice }));
    });

    r.post('/login', async (ctx) => {
      const data = dataOf(ctx.space);
      const b = await ctx.body();
      const username = str(b.username ?? b.account).trim();
      const password = str(b.password ?? b.passwd);
      const rawNext = b.next ?? ctx.url.searchParams.get('next');
      const next = safeNext(ctx.base, rawNext);
      const keep = str(rawNext) ? next : '';
      const fail = (error: string) => ctx.html(loginPage(ctx, { next: keep, username, error }));
      if (!username || !password) return fail('请输入账号和密码');
      const user = data.users[username];
      if (!user) return fail('账号或密码错误');
      if (user.locked) return fail('账号已锁定，请联系管理员解锁');
      if (password !== user.password) {
        user.fails++;
        ctx.space.log.push({
          at: new Date().toISOString(),
          type: 'login_failed',
          detail: { user: user.name, fails: user.fails },
        });
        if (user.fails >= MAX_FAILS) {
          user.locked = true;
          ctx.space.log.push({ at: new Date().toISOString(), type: 'locked', detail: user.name });
          return fail(`账号已锁定：密码连续错误 ${MAX_FAILS} 次`);
        }
        return fail(`密码错误，再错 ${MAX_FAILS - user.fails} 次将锁定账号`);
      }
      user.fails = 0;
      // 换一次登录就丢掉这个浏览器上一次没完成的验证
      const old = ctx.cookie(PENDING_COOKIE);
      if (old) delete data.pending[old];
      if (user.requireVerify) {
        const token = randomBytes(12).toString('hex');
        data.pending[token] = { user: user.name, next, created: Date.now() };
        data.verify.issued++;
        ctx.setCookie(PENDING_COOKIE, token);
        return ctx.redirect(`${ctx.base}/verify`);
      }
      finishLogin(ctx, user);
      ctx.redirect(`${ctx.base}${next}`);
    });

    r.get('/verify', (ctx) => {
      const token = ctx.cookie(PENDING_COOKIE);
      if (!token || !dataOf(ctx.space).pending[token]) return ctx.redirect(`${ctx.base}/login`);
      ctx.html(verifyPage(ctx));
    });

    r.post('/verify', async (ctx) => {
      const data = dataOf(ctx.space);
      const token = ctx.cookie(PENDING_COOKIE);
      const pending = token ? data.pending[token] : undefined;
      if (!token || !pending) return ctx.redirect(`${ctx.base}/login`);
      const b = await ctx.body();
      if (!b.human) return ctx.html(verifyPage(ctx, '请先勾选“我不是机器人”'));
      const user = data.users[pending.user];
      delete data.pending[token];
      ctx.setCookie(PENDING_COOKIE, '', { maxAge: 0 });
      if (!user || user.locked) return ctx.redirect(`${ctx.base}/login`);
      data.verify.passed++;
      finishLogin(ctx, user);
      ctx.redirect(`${ctx.base}${pending.next}`);
    });

    r.get(
      '/account',
      (ctx) => {
        const user = ctx.user as string;
        const since = Math.max(
          0,
          ...[...ctx.space.sessions.values()].filter((s) => s.user === user).map((s) => s.created),
        );
        const at = since > 0 ? since : (dataOf(ctx.space).users[user]?.lastLoginAt ?? null);
        const time = at
          ? `<time id="login-time" datetime="${new Date(at).toISOString()}">${fmtTime(at)}</time>（北京时间）`
          : '未知';
        ctx.html(
          page(
            ctx,
            shellModules(),
            '账号中心',
            `<section data-page="account" data-account-user="${esc(user)}">
<h1>账号中心</h1>
<p>当前用户：<strong id="current-user">${esc(user)}</strong></p>
<p>登录时间：${time}</p>
</section>`,
          ),
        );
      },
      { auth: true },
    );

    r.post('/logout', (ctx) => {
      ctx.signOut();
      ctx.redirect(`${ctx.base}/login?out=1`);
    });

    r.get(
      '/api/auth/me',
      (ctx) => {
        const user = ctx.user as string;
        const at = dataOf(ctx.space).users[user]?.lastLoginAt ?? null;
        ctx.json({ user, logged_in_at: at ? new Date(at).toISOString() : null });
      },
      { auth: true },
    );

    r.post(
      '/api/auth/unlock',
      async (ctx) => {
        const data = dataOf(ctx.space);
        const b = await ctx.body();
        const name = str(b.user).trim();
        const targets = name ? [data.users[name]] : Object.values(data.users);
        if (targets.some((u) => !u)) return ctx.json({ error: 'no_such_user', user: name }, 404);
        const unlocked: string[] = [];
        for (const u of targets) {
          if (!u) continue;
          u.locked = false;
          u.fails = 0;
          unlocked.push(u.name);
        }
        ctx.record('auth.unlock', str(b.key) || undefined, { users: unlocked });
        ctx.json({ ok: true, unlocked });
      },
      { commit: true },
    );
  },

  state(space) {
    const d = dataOf(space);
    const users: Record<string, unknown> = {};
    for (const u of Object.values(d.users)) {
      users[u.name] = {
        locked: u.locked,
        fails: u.fails,
        last_login: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
        logins: u.logins,
        require_verify: u.requireVerify,
      };
    }
    return {
      users,
      pending_verifications: Object.keys(d.pending).length,
      verify: { ...d.verify },
    };
  },
};

export default mod;
