import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { type LaunchOptions, launchBrowser, resolveChromePath } from './browser.ts';
import { ObactError } from './errors.ts';
import { checkBrowserVersion } from './version.ts';

const ACCOUNT = /^[A-Za-z0-9_.-]{1,64}$/;

/** 账号名会直接拼进配置目录路径：只允许字母数字 _ - .，且不能全是点（防 . 和 .. 逃出根目录）。 */
export function assertAccountName(account: string): void {
  if (typeof account !== 'string' || !ACCOUNT.test(account) || /^\.+$/.test(account)) {
    throw new ObactError(
      'invalid_params',
      `账号名不合法：${JSON.stringify(account)}（只允许字母、数字、_ - .，最长 64 个字符）`,
      { account },
    );
  }
}

export type PoolOptions = {
  /** 配置目录根，如 workspace/profiles；每个账号用 <root>/<账号>。 */
  root: string;
  /** Chrome for Testing 可执行文件；省略时读环境变量 CHROME_PATH。 */
  chromePath?: string;
  /** 默认有头（FR-01）；无显示器的 Linux 上池自己起 Xvfb。 */
  mode?: LaunchOptions['mode'];
  /** 追加给每个浏览器的启动参数。 */
  args?: string[];
  /** 优雅关闭浏览器的等待时间，超时改杀进程。默认 10 秒。 */
  closeTimeoutMs?: number;
  /** 复用前探活的等待时间，超时视为浏览器卡死，杀掉重启。默认 5 秒。 */
  probeTimeoutMs?: number;
};

/** acquire 的返回：任务进程拿 wsEndpoint 用 connectBrowser 连接；browser 是池进程自己持有的连接。 */
export type PoolLease = {
  account: string;
  wsEndpoint: string;
  browser: Browser;
  pid: number;
  profileDir: string;
};

export type PoolEntryInfo = {
  account: string;
  pid: number;
  wsEndpoint: string;
  /** 浏览器启动时间，ISO 8601。 */
  startedAt: string;
  profileDir: string;
  mode: NonNullable<LaunchOptions['mode']>;
  /** 池自起的 Xvfb 显示号（如 ':0'）；用外部显示器或无头时为空。 */
  display?: string;
  /** acquire 后尚未 release 的次数。 */
  leases: number;
};

/** 浏览器退出事件：unexpected 为 true 表示不是池主动关的（崩溃、被外部杀掉）。 */
export type PoolExit = { account: string; pid: number; unexpected: boolean };

/** 浏览器启动后的警告（目前只有版本低于已验证区间，PRD 8.3）；每个浏览器进程启动时最多一次。 */
export type PoolWarning = { account: string; pid: number; message: string };

type Entry = {
  account: string;
  profileDir: string;
  browser: Browser;
  proc: ChildProcess;
  pid: number;
  wsEndpoint: string;
  startedAt: number;
  display?: string;
  leases: number;
  /** 池主动关闭中；此时的退出不算意外。 */
  closing: boolean;
  exited: Promise<void>;
};

type XvfbHandle = { proc: ChildProcess; pid: number; display: string; exited: Promise<void> };

const hasExited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

function exitPromise(p: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (hasExited(p)) return done();
    p.once('exit', () => done());
  });
}

/** 等 p 完成，最多 ms 毫秒；超时返回 'timeout'（并清掉定时器，不拖住事件循环），p 失败则原样抛出。 */
async function race(ms: number, p: Promise<unknown>): Promise<'ok' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(() => 'ok' as const),
      new Promise<'timeout'>((done) => {
        timer = setTimeout(() => done('timeout'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次真正的 CDP 往返（浏览器级会话发 Browser.getVersion）。不能用 browser.version() 探活：
 * puppeteer 会缓存它的结果，第一次成功之后，卡死或已被杀的浏览器也会“探活成功”。
 */
async function ping(browser: Browser): Promise<void> {
  const session = await browser.target().createCDPSession();
  try {
    await session.send('Browser.getVersion');
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * 启动 Xvfb。显示号交给 Xvfb 自己挑（-displayfd 在选定空闲号、可以连接之后才写出来），
 * 比自己扫 /tmp/.X11-unix 再启动少一次抢号的竞争。
 */
async function startXvfb(): Promise<XvfbHandle> {
  const proc = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const exited = exitPromise(proc);
  // 持续读走 stderr，避免管道写满；失败时把末尾几行带进错误信息
  let stderr = '';
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (s: string) => {
    stderr = (stderr + s).slice(-2000);
  });
  const fd = proc.stdio[3] as NodeJS.ReadableStream;
  fd.setEncoding('utf8');
  let display: string;
  try {
    display = await new Promise<string>((ok, fail) => {
      let buf = '';
      const timer = setTimeout(() => fail(new Error('等待 Xvfb 就绪超时')), 15_000);
      fd.on('data', (s: string) => {
        buf += s;
        const m = /^(\d+)\n/.exec(buf);
        if (m) {
          clearTimeout(timer);
          ok(`:${m[1]}`);
        }
      });
      proc.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(
          e.code === 'ENOENT'
            ? new Error(
                '找不到 Xvfb（Debian/Ubuntu：apt install xvfb），或改用无头模式 / 设置 DISPLAY',
              )
            : e,
        );
      });
      proc.once('exit', (code, signal) => {
        clearTimeout(timer);
        fail(new Error(`Xvfb 提前退出（code=${code} signal=${signal}）：${stderr.trim()}`));
      });
    });
  } catch (e) {
    if (proc.pid !== undefined) {
      if (!hasExited(proc)) proc.kill('SIGKILL');
      await exited;
    }
    throw new ObactError('internal', `无法启动 Xvfb：${(e as Error).message}`);
  }
  return { proc, pid: proc.pid as number, display, exited };
}

/**
 * 最小浏览器池（FR-01、FR-02 登录态复用、FR-03 最小部分）：
 * - 每个账号一个独立配置目录 <root>/<账号> 和一个浏览器；同一账号复用已在运行的浏览器。
 * - 浏览器由池进程启动，任务进程只用 wsEndpoint 连接（connectBrowser），任务进程崩溃或被杀不影响浏览器。
 * - 浏览器意外退出会自动从池中移除，下次 acquire 重新启动（配置目录不变，持久 Cookie 保留）。
 * - 有头模式在没有显示器的 Linux 上由池启动 Xvfb，closeAll 时关掉。
 * 并行与排队规则放 M4。
 */
export class BrowserPool extends EventEmitter<{
  exit: [info: PoolExit];
  warning: [info: PoolWarning];
}> {
  readonly root: string;
  readonly mode: NonNullable<LaunchOptions['mode']>;
  readonly #chromePath: string | undefined;
  readonly #args: string[];
  readonly #closeTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #entries = new Map<string, Entry>();
  /** 每个账号同一时刻只有一个“探活 + 启动”在进行，并发的 acquire 共用它。 */
  readonly #ensuring = new Map<string, Promise<Entry>>();
  /** 已被移出池、进程还没退干净的浏览器（按账号）。 */
  readonly #draining = new Map<string, Promise<void>>();
  #xvfb: Promise<XvfbHandle> | undefined;
  #xvfbInfo: XvfbHandle | undefined;
  #closing: Promise<void> | undefined;
  readonly #killXvfbOnExit = () => {
    try {
      this.#xvfbInfo?.proc.kill('SIGTERM');
    } catch {}
  };

  constructor(opts: PoolOptions) {
    super();
    this.root = resolve(opts.root);
    this.mode = opts.mode ?? 'headed';
    this.#chromePath = opts.chromePath;
    this.#args = opts.args ?? [];
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? 10_000;
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  }

  /** 池自起的 Xvfb（没有起过或已关闭时为空）。 */
  get xvfb(): { display: string; pid: number } | undefined {
    return this.#xvfbInfo && { display: this.#xvfbInfo.display, pid: this.#xvfbInfo.pid };
  }

  profileDir(account: string): string {
    assertAccountName(account);
    return join(this.root, account);
  }

  /** 取得账号的浏览器：已在运行就复用，没有或已退出就启动。 */
  async acquire(account: string): Promise<PoolLease> {
    assertAccountName(account);
    while (this.#closing) await this.#closing;
    const entry = await this.#ensure(account);
    entry.leases++;
    return {
      account,
      wsEndpoint: entry.wsEndpoint,
      browser: entry.browser,
      pid: entry.pid,
      profileDir: entry.profileDir,
    };
  }

  /**
   * 归还一次 acquire。浏览器不会因此关闭（登录态要长期复用）。
   * 传 acquire 的返回值时，若该浏览器已被替换（崩溃后重启），则忽略，不误减新浏览器的计数。
   */
  release(target: string | Pick<PoolLease, 'account' | 'browser'>): void {
    const account = typeof target === 'string' ? target : target.account;
    const entry = this.#entries.get(account);
    if (!entry) return;
    if (typeof target !== 'string' && target.browser !== entry.browser) return;
    if (entry.leases > 0) entry.leases--;
  }

  /** 关闭一个账号的浏览器（优雅关闭，Cookie 落盘）。返回是否真的关了一个在运行的浏览器。 */
  async close(account: string): Promise<boolean> {
    assertAccountName(account);
    await this.#ensuring.get(account)?.catch(() => {});
    const entry = this.#entries.get(account);
    if (!entry) return false;
    await this.#terminate(entry, { graceful: true, unexpected: false });
    return true;
  }

  /** 关闭所有浏览器，再关掉池自起的 Xvfb。关闭期间的 acquire 会等它结束后重新启动。 */
  closeAll(): Promise<void> {
    this.#closing ??= this.#closeAll().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #closeAll(): Promise<void> {
    await Promise.allSettled([...this.#ensuring.values()]);
    await Promise.allSettled(
      [...this.#entries.values()].map((e) =>
        this.#terminate(e, { graceful: true, unexpected: false }),
      ),
    );
    await this.#stopXvfb();
  }

  list(): PoolEntryInfo[] {
    return [...this.#entries.values()].map((e) => ({
      account: e.account,
      pid: e.pid,
      wsEndpoint: e.wsEndpoint,
      startedAt: new Date(e.startedAt).toISOString(),
      profileDir: e.profileDir,
      mode: this.mode,
      ...(e.display ? { display: e.display } : {}),
      leases: e.leases,
    }));
  }

  #ensure(account: string): Promise<Entry> {
    let p = this.#ensuring.get(account);
    if (!p) {
      p = this.#probeOrLaunch(account).finally(() => this.#ensuring.delete(account));
      this.#ensuring.set(account, p);
    }
    return p;
  }

  async #probeOrLaunch(account: string): Promise<Entry> {
    const cur = this.#entries.get(account);
    if (cur) {
      if (await this.#healthy(cur)) return cur;
      await this.#terminate(cur, { graceful: false, unexpected: true });
    }
    // 上一个浏览器进程还没退干净时先等它，否则新进程会撞上配置目录的锁
    await this.#draining.get(account);
    return this.#launch(account);
  }

  /**
   * 探活：连接还在、进程没退出，且 CDP 在时限内有响应。
   * 外部 kill 之后 'disconnected' 事件可能还没到，所以不能只看 connected。
   */
  async #healthy(e: Entry): Promise<boolean> {
    if (!e.browser.connected || hasExited(e.proc)) return false;
    try {
      return (await race(this.#probeTimeoutMs, ping(e.browser))) === 'ok';
    } catch {
      return false;
    }
  }

  async #launch(account: string): Promise<Entry> {
    const profileDir = join(this.root, account);
    resolveChromePath(this.#chromePath); // 没配浏览器就在起 Xvfb 之前报错
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const display = await this.#displayFor();
    let browser: Browser;
    try {
      browser = await launchBrowser({
        profileDir,
        mode: this.mode,
        chromePath: this.#chromePath,
        args: this.#args,
        ...(display ? { env: { DISPLAY: display } } : {}),
      });
    } catch (e) {
      throw await this.#launchError(account, profileDir, e);
    }
    const proc = browser.process();
    if (!proc?.pid || !browser.connected) {
      await browser.close().catch(() => {});
      throw new ObactError('internal', `浏览器启动后立即退出（账号 ${account}）`, { account });
    }
    const entry: Entry = {
      account,
      profileDir,
      browser,
      proc,
      pid: proc.pid,
      wsEndpoint: browser.wsEndpoint(),
      startedAt: Date.now(),
      ...(display ? { display } : {}),
      leases: 0,
      closing: false,
      exited: exitPromise(proc),
    };
    this.#entries.set(account, entry);
    const gone = () => this.#onGone(entry);
    browser.once('disconnected', gone);
    proc.once('exit', gone);
    await this.#warnVersion(entry);
    return entry;
  }

  /** 浏览器版本不在已验证区间时发出一次 'warning'；检测本身失败不影响使用。 */
  async #warnVersion(entry: Entry): Promise<void> {
    const v = await checkBrowserVersion(entry.browser).catch(() => null);
    if (v?.warning) {
      this.emit('warning', { account: entry.account, pid: entry.pid, message: v.warning });
    }
  }

  async #launchError(account: string, profileDir: string, cause: unknown): Promise<ObactError> {
    if (cause instanceof ObactError) return cause;
    const locked = await lstat(join(profileDir, 'SingletonLock')).then(
      () => true,
      () => false,
    );
    const hint = locked ? '；配置目录可能被另一个仍在运行的浏览器占用（存在 SingletonLock）' : '';
    return new ObactError(
      'internal',
      `启动浏览器失败（账号 ${account}）：${(cause as Error).message}${hint}`,
      { account, profileDir },
    );
  }

  /** 浏览器退出或断开：移出池并通知。池不再管得着的浏览器进程不留着，免得一直占着配置目录。 */
  #onGone(entry: Entry): void {
    if (this.#entries.get(entry.account) === entry) this.#entries.delete(entry.account);
    if (entry.closing) return;
    entry.closing = true;
    this.#drain(entry);
    if (!hasExited(entry.proc)) entry.proc.kill('SIGKILL');
    this.emit('exit', { account: entry.account, pid: entry.pid, unexpected: true });
  }

  /** 记下一个正在退出的浏览器进程；同账号的下一次启动要等它退干净。 */
  #drain(entry: Entry): void {
    const done = entry.exited.then(() => {
      if (this.#draining.get(entry.account) === done) this.#draining.delete(entry.account);
    });
    this.#draining.set(entry.account, done);
  }

  /** 关掉一个浏览器并等进程真正退出，下次启动才不会撞上配置目录锁。 */
  async #terminate(entry: Entry, how: { graceful: boolean; unexpected: boolean }): Promise<void> {
    const wasClosing = entry.closing;
    entry.closing = true;
    if (this.#entries.get(entry.account) === entry) this.#entries.delete(entry.account);
    if (how.graceful && !hasExited(entry.proc)) {
      await race(this.#closeTimeoutMs, entry.browser.close()).catch(() => {});
    }
    if (!hasExited(entry.proc)) entry.proc.kill('SIGKILL');
    await entry.exited;
    entry.browser.disconnect().catch(() => {});
    if (!wasClosing) {
      this.emit('exit', { account: entry.account, pid: entry.pid, unexpected: how.unexpected });
    }
  }

  /** 需要 Xvfb 时（有头、Linux、没有显示器）返回显示号，必要时先启动。 */
  async #displayFor(): Promise<string | undefined> {
    if (this.mode !== 'headed' || process.platform !== 'linux') return undefined;
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return undefined;
    this.#xvfb ??= startXvfb().then(
      (x) => {
        this.#xvfbInfo = x;
        process.on('exit', this.#killXvfbOnExit);
        // Xvfb 意外退出：清掉缓存，之后的启动会再起一个；挂在它上面的浏览器会随之断开并移出池
        void x.exited.then(() => {
          if (this.#xvfbInfo === x) this.#dropXvfb();
        });
        return x;
      },
      (e) => {
        this.#xvfb = undefined;
        throw e;
      },
    );
    return (await this.#xvfb).display;
  }

  #dropXvfb(): void {
    this.#xvfb = undefined;
    this.#xvfbInfo = undefined;
    process.off('exit', this.#killXvfbOnExit);
  }

  async #stopXvfb(): Promise<void> {
    const x = await this.#xvfb?.catch(() => undefined);
    this.#dropXvfb();
    if (!x || hasExited(x.proc)) return;
    x.proc.kill('SIGTERM');
    if ((await race(5_000, x.exited)) === 'timeout') x.proc.kill('SIGKILL');
    await x.exited;
  }
}
