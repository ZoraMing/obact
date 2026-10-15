import { randomBytes } from 'node:crypto';
import type { Browser } from 'puppeteer-core';
import { PageRegistry } from './pages.ts';
import { RefRegistry } from './refs.ts';

/** 编号写进元素的属性名（参考 BrowserGym 的 bid）。 */
export const REF_ATTR = 'data-obact-ref';

/**
 * 一个任务进程与浏览器之间的会话：标签页登记 + 编号表。
 * 编号只在会话内有效；新会话（如任务进程重启后）会把旧会话留下的编号视为失效并重新编号。
 */
export class Session {
  readonly browser: Browser;
  readonly pages: PageRegistry;
  readonly refs = new RefRegistry();
  /** 会话随机串，用于页面内不可枚举标记的键名。 */
  readonly key = randomBytes(6).toString('hex');
  readonly attr = REF_ATTR;

  constructor(browser: Browser) {
    this.browser = browser;
    this.pages = new PageRegistry(browser);
  }

  /** 页面内标记节点身份用的键名。 */
  get refKey(): string {
    return `__obactRef_${this.key}`;
  }

  /** 接入浏览器；adopt 为 true 时登记已有标签页（重连接管时使用）。 */
  static async attach(browser: Browser, opts: { adopt?: boolean } = {}): Promise<Session> {
    const s = new Session(browser);
    if (opts.adopt !== false) await s.pages.adoptExisting();
    return s;
  }

  /** 结束会话；只在自己启动浏览器时才关闭浏览器，否则只断开（浏览器由服务管理）。 */
  async close(opts: { closeBrowser?: boolean } = {}): Promise<void> {
    this.pages.dispose();
    if (opts.closeBrowser) await this.browser.close();
    else await this.browser.disconnect();
  }
}
