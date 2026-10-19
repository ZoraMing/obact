// 浏览器池（FR-01、FR-02 登录态复用、FR-03 最小部分）：按账号起浏览器，任务子进程连接，崩溃不影响浏览器和登录态。
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertAccountName,
  BrowserPool,
  observe,
  type PoolExit,
  type PoolOptions,
  Session,
} from '../src/index.ts';
import { CHROME, FULL_CHROME, rejectsWithCode, SKIP } from './helpers.ts';

const TASK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-pool', 'task.ts');

const LOGIN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>登录态测试页</title></head>
<body>
  <h1>登录态测试</h1>
  <label>令牌 <input id="token"></label>
  <button id="save">保存登录态</button>
  <p id="state">未登录</p>
  <script>
    document.getElementById('save').onclick = () => {
      const v = document.getElementById('token').value;
      localStorage.setItem('token', v);
      document.cookie = 'sid=' + v + '; max-age=86400; path=/';
      window.marker = 'live-' + v; // 只存在于页面内存里，用来证明接管的是同一个标签页
      document.getElementById('state').textContent = '已保存：' + v;
    };
  </script>
</body></html>`;

/** 子进程的一次运行：逐行读 stdout 的 JSON，等它退出。 */
type Task = {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  next<T>(): Promise<T>;
};

type LoginResult = { elements: number; fill: string; click: string; wait: string };
type PageState = {
  cookie: string;
  token: string | null;
  marker: string | null;
  state: string | null;
};

describe('浏览器池', { skip: SKIP, timeout: 180_000 }, () => {
  let server: Server;
  let base: string;
  const pools: BrowserPool[] = [];
  const dirs: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/login.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE);
      } else if (url.pathname === '/api/login') {
        // 服务端下发的持久登录 Cookie（HttpOnly，带 Max-Age）
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': `auth=${url.searchParams.get('user')}; Max-Age=86400; Path=/; HttpOnly`,
          })
          .end('{"ok":true}');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await Promise.allSettled(pools.map((p) => p.closeAll()));
    await new Promise<void>((ok) => server.close(() => ok()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function tmpRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'obact-pool-'));
    dirs.push(root);
    return root;
  }

  /** 默认无头：除了 Xvfb 冒烟，其余测试不依赖显示环境。 */
  function mkPool(opts: Partial<PoolOptions> = {}): BrowserPool {
    const pool = new BrowserPool({
      root: tmpRoot(),
      chromePath: CHROME,
      mode: 'headless',
      ...opts,
    });
    pools.push(pool);
    return pool;
  }

  function runTask(ws: string, cmd: 'login' | 'inspect', token: string): Task {
    const child = spawn(process.execPath, [TASK, ws, cmd, base, token], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => {
      err += s;
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) =>
      child.once('exit', (code, signal) => ok({ code, signal })),
    );
    const queue: string[] = [];
    const waiters: ((line: string | null) => void)[] = [];
    let closed = false;
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on('line', (l) => {
      const w = waiters.shift();
      if (w) w(l);
      else queue.push(l);
    });
    rl.on('close', () => {
      closed = true;
      for (const w of waiters.splice(0)) w(null);
    });
    return {
      child,
      exit,
      async next<T>() {
        const line =
          queue.shift() ??
          (closed ? null : await new Promise<string | null>((ok) => waiters.push(ok)));
        if (line === null) throw new Error(`子进程没有输出就退出了：${err}`);
        return JSON.parse(line) as T;
      },
    };
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** 在池进程里用池持有的连接打开页面，读取 document.cookie 与 localStorage。 */
  async function readState(lease: {
    browser: import('puppeteer-core').Browser;
  }): Promise<PageState> {
    const page = await lease.browser.newPage();
    try {
      await page.goto(`${base}/login.html`);
      return await page.evaluate(() => ({
        cookie: document.cookie,
        token: localStorage.getItem('token'),
        marker: null,
        state: document.getElementById('state')?.textContent ?? null,
      }));
    } finally {
      await page.close();
    }
  }

  test('账号名只允许字母数字 _ - .，不能逃出配置目录根', async () => {
    for (const ok of ['alice', 'a_b-c.1', 'A1', '.hidden', 'x'.repeat(64)]) {
      assert.doesNotThrow(() => assertAccountName(ok), ok);
    }
    const pool = mkPool();
    for (const bad of [
      '',
      '.',
      '..',
      '...',
      '../evil',
      'a/b',
      'a\\b',
      'a b',
      '账号',
      'a:b',
      'x'.repeat(65),
    ]) {
      assert.throws(() => assertAccountName(bad), { code: 'invalid_params' }, JSON.stringify(bad));
      await rejectsWithCode(pool.acquire(bad), 'invalid_params');
    }
    await rejectsWithCode(pool.close('../evil'), 'invalid_params');
    assert.equal(existsSync(join(pool.root, '..', 'evil')), false);
    assert.deepEqual(pool.list(), [], '非法账号名不能启动浏览器');
  });

  test('同一账号复用同一个浏览器（含并发）；不同账号不同浏览器、不同配置目录、登录态互不可见', async () => {
    const pool = mkPool();
    assert.equal(pool.mode, 'headless');
    const [a1, a2, a3] = await Promise.all([
      pool.acquire('alice'),
      pool.acquire('alice'),
      pool.acquire('alice'),
    ]);
    assert.equal(a1.pid, a2.pid);
    assert.equal(a1.pid, a3.pid);
    assert.equal(a1.wsEndpoint, a2.wsEndpoint);
    assert.equal(a1.browser, a3.browser, '并发 acquire 共用同一次启动');
    const a4 = await pool.acquire('alice');
    assert.equal(a4.pid, a1.pid);
    assert.equal(a4.wsEndpoint, a1.wsEndpoint);
    assert.equal(a4.browser, a1.browser);
    assert.match(a1.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, '只绑定本机');

    const bob = await pool.acquire('bob');
    assert.notEqual(bob.pid, a1.pid);
    assert.notEqual(bob.wsEndpoint, a1.wsEndpoint);
    assert.notEqual(bob.browser, a1.browser);
    assert.equal(a1.profileDir, join(pool.root, 'alice'));
    assert.equal(bob.profileDir, join(pool.root, 'bob'));
    assert.ok(existsSync(join(a1.profileDir, 'Default')), 'alice 的配置目录被浏览器实际使用');
    assert.ok(existsSync(join(bob.profileDir, 'Default')), 'bob 的配置目录被浏览器实际使用');

    // list：各账号的状态
    const list = pool.list().sort((x, y) => x.account.localeCompare(y.account));
    assert.deepEqual(
      list.map((e) => [e.account, e.pid, e.wsEndpoint, e.leases]),
      [
        ['alice', a1.pid, a1.wsEndpoint, 4],
        ['bob', bob.pid, bob.wsEndpoint, 1],
      ],
    );
    for (const e of list) {
      assert.ok(alive(e.pid));
      assert.equal(e.mode, 'headless');
      assert.ok(
        Math.abs(Date.now() - Date.parse(e.startedAt)) < 120_000,
        `启动时间 ${e.startedAt}`,
      );
    }
    // release 只减计数，浏览器不关
    pool.release('alice');
    pool.release(a1);
    assert.equal(pool.list().find((e) => e.account === 'alice')?.leases, 2);
    assert.ok(alive(a1.pid));

    // 登录态隔离：alice 写了 Cookie 和 localStorage，bob 看不到
    const page = await a1.browser.newPage();
    await page.goto(`${base}/login.html`);
    await page.evaluate(() => {
      localStorage.setItem('token', 'alice-token');
      // biome-ignore lint/suspicious/noDocumentCookie: 测试要写一个普通 Cookie
      document.cookie = 'sid=alice; max-age=86400; path=/';
    });
    await page.close();
    const mine = await readState(a1);
    assert.equal(mine.cookie, 'sid=alice');
    assert.equal(mine.token, 'alice-token');
    const theirs = await readState(bob);
    assert.equal(theirs.cookie, '');
    assert.equal(theirs.token, null);
  });

  test('close(account) 只关一个账号；closeAll 全关；关闭后再 acquire 会重新启动', async () => {
    const pool = mkPool();
    const events: PoolExit[] = [];
    pool.on('exit', (e) => events.push(e));
    const a = await pool.acquire('a');
    const b = await pool.acquire('b');
    assert.equal(await pool.close('a'), true);
    assert.equal(alive(a.pid), false, 'close 要等到进程真正退出');
    assert.equal(await pool.close('a'), false, '重复关闭不报错');
    assert.deepEqual(
      pool.list().map((e) => e.account),
      ['b'],
    );
    assert.ok(alive(b.pid), '别的账号不受影响');
    assert.deepEqual(events, [{ account: 'a', pid: a.pid, unexpected: false }]);

    const a2 = await pool.acquire('a');
    assert.notEqual(a2.pid, a.pid);
    assert.ok(a2.browser.connected);

    await pool.closeAll();
    assert.deepEqual(pool.list(), []);
    assert.equal(alive(a2.pid), false);
    assert.equal(alive(b.pid), false);
    assert.ok(
      events.every((e) => !e.unexpected),
      '主动关闭都不算意外退出',
    );
    await pool.closeAll(); // 空池再关一次也没事
  });

  test('任务子进程连接后 observe / act 正常；子进程被 SIGKILL 后浏览器与标签页还在，新的子进程能接管', async () => {
    const pool = mkPool();
    const lease = await pool.acquire('task-acct');

    // 子进程 1：连接，新开标签页，observe 后用 act 填写并点击，写下 Cookie / localStorage / 页面内存标记
    const t1 = runTask(lease.wsEndpoint, 'login', 'tok');
    const ready = await t1.next<LoginResult & { ready: boolean; pageId: string }>();
    assert.equal(ready.ready, true);
    assert.ok(ready.elements >= 2, `observe 应能看到输入框和按钮：${ready.elements}`);
    assert.deepEqual([ready.fill, ready.click, ready.wait], ['ok', 'ok', 'ok']);
    t1.child.kill('SIGKILL');
    const killed = await t1.exit;
    assert.equal(killed.signal, 'SIGKILL');

    // 任务进程被杀：浏览器进程、池里的登记、连接和标签页都不受影响
    assert.ok(alive(lease.pid), '浏览器进程还活着');
    assert.ok(lease.browser.connected);
    assert.deepEqual(
      pool.list().map((e) => e.account),
      ['task-acct'],
    );
    assert.equal(
      (await lease.browser.pages()).filter((p) => p.url().endsWith('/login.html')).length,
      1,
    );

    // 子进程 2：另一个进程连上同一个浏览器，看到同一个标签页和同一份登录态，并且能继续 act
    const t2 = runTask(lease.wsEndpoint, 'inspect', 'tok');
    const seen = await t2.next<{
      found: boolean;
      pages: number;
      before: PageState;
      again: LoginResult;
      after: PageState;
    }>();
    assert.equal(seen.found, true);
    assert.equal(
      seen.before.marker,
      'live-tok',
      '页面内存里的标记还在：接管的是原来的标签页而不是重新打开',
    );
    assert.equal(seen.before.state, '已保存：tok');
    assert.equal(seen.before.token, 'tok');
    assert.equal(seen.before.cookie, 'sid=tok');
    assert.deepEqual([seen.again.fill, seen.again.click, seen.again.wait], ['ok', 'ok', 'ok']);
    assert.equal(seen.after.state, '已保存：tok-2');
    assert.equal(seen.after.marker, 'live-tok-2');
    assert.equal((await t2.exit).code, 0, '子进程正常断开退出');

    // 子进程正常退出也不会关掉浏览器
    assert.ok(alive(lease.pid));
    assert.equal(
      (await lease.browser.pages()).filter((p) => p.url().endsWith('/login.html')).length,
      1,
    );
    assert.equal(pool.list()[0]?.pid, lease.pid);
  });

  test('池进程自己也能用 Session.attach 接管池里的浏览器（observe 可用）', async () => {
    const pool = mkPool();
    const lease = await pool.acquire('self');
    const session = await Session.attach(lease.browser);
    const pageId = await session.pages.newPage({ url: `${base}/login.html` });
    const ob = await observe(session, { pageId });
    assert.ok(ob.elements.some((e) => e.name === '保存登录态'));
    await session.close(); // 只断开，浏览器由池管理
    assert.ok(alive(lease.pid));
  });

  test('closeAll 后用同一个根目录重新起池：持久 Cookie 和 localStorage 还在（登录态复用）', async () => {
    const root = tmpRoot();
    const pool1 = mkPool({ root });
    const first = await pool1.acquire('login-acct');
    const page = await first.browser.newPage();
    await page.goto(`${base}/api/login?user=u1`); // 服务端 Set-Cookie（HttpOnly，Max-Age）
    await page.goto(`${base}/login.html`);
    await page.evaluate(() => {
      localStorage.setItem('token', 'persisted');
      // biome-ignore lint/suspicious/noDocumentCookie: 测试要写一个带 Max-Age 的持久 Cookie
      document.cookie = 'pref=dark; max-age=86400; path=/';
    });
    await pool1.closeAll();
    assert.equal(alive(first.pid), false);
    assert.deepEqual(pool1.list(), []);

    const pool2 = mkPool({ root });
    const second = await pool2.acquire('login-acct');
    assert.notEqual(second.pid, first.pid, '是新启动的浏览器');
    assert.equal(second.profileDir, first.profileDir);
    const cookies = await second.browser.cookies();
    const auth = cookies.find((c) => c.name === 'auth');
    assert.equal(auth?.value, 'u1', '服务端下发的 HttpOnly 登录 Cookie');
    assert.equal(auth?.httpOnly, true);
    assert.equal(auth?.session, false, '持久 Cookie，不是会话 Cookie');
    assert.equal(cookies.find((c) => c.name === 'pref')?.value, 'dark');
    const state = await readState(second);
    assert.equal(state.token, 'persisted');
    assert.match(state.cookie, /pref=dark/);
    // 换一个账号看不到
    const other = await pool2.acquire('someone-else');
    assert.equal((await other.browser.cookies()).length, 0);
  });

  test('浏览器被外部杀掉：自动移出池并通知；下次 acquire 重新启动，配置目录不变', async () => {
    const pool = mkPool();
    const events: PoolExit[] = [];
    pool.on('exit', (e) => events.push(e));
    const lease = await pool.acquire('victim');
    const gone = once(pool, 'exit');
    process.kill(lease.pid, 'SIGKILL');
    const [info] = (await gone) as [PoolExit];
    assert.deepEqual(info, { account: 'victim', pid: lease.pid, unexpected: true });
    assert.deepEqual(pool.list(), [], '已自动移出池');

    const again = await pool.acquire('victim');
    assert.notEqual(again.pid, lease.pid);
    assert.notEqual(again.wsEndpoint, lease.wsEndpoint);
    assert.equal(again.profileDir, lease.profileDir);
    assert.ok(again.browser.connected);
    const page = await again.browser.newPage();
    await page.goto(`${base}/login.html`);
    assert.equal(await page.title(), '登录态测试页');
    await page.close();
    assert.equal(events.length, 1, '同一次退出只通知一次');
  });

  test('浏览器被杀后立刻 acquire（事件还没来得及处理）也能探出并重启', async () => {
    const pool = mkPool();
    const events: PoolExit[] = [];
    pool.on('exit', (e) => events.push(e));
    const lease = await pool.acquire('race');
    process.kill(lease.pid, 'SIGKILL');
    const again = await pool.acquire('race'); // 不等 exit 事件
    assert.notEqual(again.pid, lease.pid);
    assert.ok(again.browser.connected);
    assert.ok(alive(again.pid));
    assert.equal(await (await again.browser.newPage()).evaluate(() => 1 + 1), 2);
    assert.equal(alive(lease.pid), false);
    assert.deepEqual(
      events.map((e) => [e.account, e.pid, e.unexpected]),
      [['race', lease.pid, true]],
      '只通知一次，且标记为意外退出',
    );
    // 旧租约的 release 不会误减新浏览器的计数
    pool.release(lease);
    assert.equal(pool.list()[0]?.leases, 1);
  });

  test('浏览器卡死（进程被冻结）：探活超时后杀掉重启；探活不能被缓存的结果糊弄', async () => {
    const pool = mkPool({ probeTimeoutMs: 800 });
    const lease = await pool.acquire('frozen');
    await pool.acquire('frozen'); // 复用一次：探活成功过之后，卡死的浏览器也必须探得出来
    process.kill(lease.pid, 'SIGSTOP');
    const again = await pool.acquire('frozen');
    assert.notEqual(again.pid, lease.pid);
    assert.equal(await (await again.browser.newPage()).evaluate(() => 1 + 1), 2);
    assert.equal(alive(lease.pid), false, '冻结的旧浏览器已被杀掉');
  });

  test('没指定浏览器：acquire 直接报 invalid_params，不留下半成品', async () => {
    const saved = process.env.CHROME_PATH;
    delete process.env.CHROME_PATH;
    try {
      const pool = new BrowserPool({ root: tmpRoot(), mode: 'headless' });
      pools.push(pool);
      await rejectsWithCode(pool.acquire('nobody'), 'invalid_params');
      assert.deepEqual(pool.list(), []);
    } finally {
      if (saved !== undefined) process.env.CHROME_PATH = saved;
    }
  });
});

/** 有头模式 + Xvfb：只在 Linux 且装了 Xvfb 时跑。 */
const XVFB_SKIP: false | string =
  process.platform !== 'linux'
    ? '只有 Linux 需要 Xvfb（其他平台有头模式直接用系统显示）'
    : spawnSync('Xvfb', ['-help'], { stdio: 'ignore' }).error
      ? '没有安装 Xvfb（Debian / Ubuntu：apt install xvfb），跳过有头模式冒烟'
      : false;

describe('浏览器池：有头模式与 Xvfb', { skip: SKIP || XVFB_SKIP, timeout: 120_000 }, () => {
  const dirs: string[] = [];
  const pools: BrowserPool[] = [];
  const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };

  before(() => {
    // 模拟无显示器的环境
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });
  after(async () => {
    await Promise.allSettled(pools.map((p) => p.closeAll()));
    for (const k of ['DISPLAY', 'WAYLAND_DISPLAY'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function mkPool(opts: Partial<PoolOptions> = {}): BrowserPool {
    const root = mkdtempSync(join(tmpdir(), 'obact-pool-xvfb-'));
    dirs.push(root);
    const pool = new BrowserPool({ root, chromePath: FULL_CHROME, ...opts });
    pools.push(pool);
    return pool;
  }
  /** 经函数取值，避免 TypeScript 把 pool.xvfb 在 assert.equal(…, undefined) 之后一直收窄成 undefined。 */
  const xvfbOf = (pool: BrowserPool) => pool.xvfb;
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  const chromeDisplay = (pid: number) =>
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find((kv) => kv.startsWith('DISPLAY='))
      ?.slice('DISPLAY='.length);

  test('默认有头：没有 DISPLAY 时池自起 Xvfb，浏览器是真正的有头，observe 可用；closeAll 后 Xvfb 退出', async () => {
    const pool = mkPool();
    assert.equal(pool.mode, 'headed', '默认有头');
    assert.equal(xvfbOf(pool), undefined, '用到之前不启动');

    const lease = await pool.acquire('xv');
    const xvfb = xvfbOf(pool);
    assert.ok(xvfb, '池应起了 Xvfb');
    assert.match(xvfb.display, /^:\d+$/);
    assert.equal(gone(xvfb.pid), false, 'Xvfb 在运行');
    assert.equal(process.env.DISPLAY, undefined, '不改动本进程的 DISPLAY');
    assert.equal(chromeDisplay(lease.pid), xvfb.display, '浏览器连的是池起的 Xvfb');
    assert.equal(pool.list()[0]?.display, xvfb.display);

    const session = await Session.attach(lease.browser);
    const pageId = await session.pages.newPage({
      url: `data:text/html;charset=utf-8,${encodeURIComponent('<button>你好</button>')}`,
    });
    const ob = await observe(session, { pageId });
    assert.ok(ob.elements.some((e) => e.role === 'button' && e.name === '你好'));
    const ua = await session.pages.get(pageId).evaluate(() => navigator.userAgent);
    assert.doesNotMatch(ua, /Headless/, '有头浏览器的 UA 不含 Headless');
    await session.close();

    // 同一个池再起别的账号：共用这一个 Xvfb
    const other = await pool.acquire('xv2');
    assert.equal(xvfbOf(pool)?.pid, xvfb.pid);
    assert.equal(chromeDisplay(other.pid), xvfb.display);

    await pool.closeAll();
    assert.equal(xvfbOf(pool), undefined);
    assert.equal(gone(xvfb.pid), true, 'closeAll 后 Xvfb 进程已退出');
    assert.equal(gone(lease.pid), true);
    assert.equal(gone(other.pid), true);

    // 关闭后池还能用：重新起 Xvfb 和浏览器，再关
    const again = await pool.acquire('xv');
    const xvfb2 = xvfbOf(pool);
    assert.ok(xvfb2);
    assert.equal(gone(xvfb2.pid), false);
    await pool.closeAll();
    assert.equal(gone(xvfb2.pid), true);
    assert.equal(gone(again.pid), true);
  });

  test('已有显示环境（DISPLAY 已设置）时不再自起 Xvfb', async () => {
    // 测试自己起一个 Xvfb 当作“系统显示”
    const ext = spawn(
      'Xvfb',
      ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    );
    const display = await new Promise<string>((ok, fail) => {
      let buf = '';
      ext.stdio[3]?.on('data', (s: Buffer) => {
        buf += s.toString();
        if (buf.includes('\n')) ok(`:${buf.trim()}`);
      });
      ext.once('error', fail);
      ext.once('exit', () => fail(new Error('外部 Xvfb 提前退出')));
    });
    process.env.DISPLAY = display;
    try {
      const pool = mkPool();
      const lease = await pool.acquire('ext');
      assert.equal(xvfbOf(pool), undefined, '有显示器就不自起');
      assert.equal(chromeDisplay(lease.pid), display);
      await pool.closeAll();
    } finally {
      delete process.env.DISPLAY;
      ext.kill('SIGTERM');
      await once(ext, 'exit');
    }
  });

  test('有头但没有显示器、也找不到 Xvfb：明确报错，池里不留半成品', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = join(tmpdir(), 'obact-pool-no-such-bin');
    try {
      const pool = mkPool();
      await assert.rejects(pool.acquire('nox'), (e: { code?: string; message?: string }) => {
        assert.equal(e.code, 'internal');
        assert.match(e.message ?? '', /Xvfb/);
        return true;
      });
      assert.equal(xvfbOf(pool), undefined);
      assert.deepEqual(pool.list(), []);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
