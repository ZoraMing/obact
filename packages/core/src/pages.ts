import type { Browser, Page, Target } from 'puppeteer-core';
import { ObactError } from './errors.ts';

const PAGE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * 标签页登记（FR-04）：每个标签页有工具内 ID（pageId）；新打开的标签页（含 window.open 弹出）自动登记。
 * 跨域 iframe 不单独登记为标签页，由 Puppeteer 的 frame 树统一管理。
 */
export class PageRegistry {
  readonly #browser: Browser;
  readonly #byId = new Map<string, Page>();
  readonly #ids = new WeakMap<Page, string>();
  /** 登记顺序号：动作开始时记下，结束时取之后新增的页面，作为 effects.new_pages。 */
  #seq = 0;
  readonly #order = new Map<string, number>();
  #auto = 0;
  readonly #onTarget = (t: Target) => void this.#adoptTarget(t);
  readonly #onRegister: ((page: Page) => void) | undefined;

  /** onRegister 在页面首次登记时调用（register、adoptExisting、新标签页的 targetcreated 都经过它）。 */
  constructor(browser: Browser, onRegister?: (page: Page) => void) {
    this.#browser = browser;
    this.#onRegister = onRegister;
    browser.on('targetcreated', this.#onTarget);
  }

  dispose(): void {
    this.#browser.off('targetcreated', this.#onTarget);
  }

  async #adoptTarget(t: Target): Promise<void> {
    if (t.type() !== 'page') return;
    const page = await t.page().catch(() => null);
    if (page && !this.#ids.has(page)) this.register(page);
  }

  /** 登记一个页面；id 省略时自动分配 p1、p2…。已登记的页面返回原 ID。 */
  register(page: Page, id?: string): string {
    const existing = this.#ids.get(page);
    if (existing) return id && id !== existing ? this.rename(existing, id) : existing;
    const pageId = id ?? this.#nextAutoId();
    this.#checkId(pageId);
    this.#byId.set(pageId, page);
    this.#ids.set(page, pageId);
    this.#order.set(pageId, ++this.#seq);
    this.#onRegister?.(page);
    // 页面可能改过名（rename）：关闭时按页面当前的编号移除，不能用登记时的旧编号
    page.once('close', () => {
      const cur = this.#ids.get(page);
      if (cur !== undefined && this.#byId.get(cur) === page) {
        this.#byId.delete(cur);
        this.#order.delete(cur);
      }
    });
    return pageId;
  }

  rename(oldId: string, newId: string): string {
    if (oldId === newId) return newId;
    const page = this.get(oldId);
    this.#checkId(newId);
    this.#byId.delete(oldId);
    this.#byId.set(newId, page);
    this.#ids.set(page, newId);
    this.#order.set(newId, this.#order.get(oldId) ?? ++this.#seq);
    this.#order.delete(oldId);
    return newId;
  }

  #checkId(id: string): void {
    if (!PAGE_ID.test(id)) throw new ObactError('invalid_params', `pageId 不合法：${id}`);
    if (this.#byId.has(id)) throw new ObactError('invalid_params', `pageId 已被使用：${id}`);
  }

  #nextAutoId(): string {
    let id: string;
    do id = `p${++this.#auto}`;
    while (this.#byId.has(id));
    return id;
  }

  get(pageId: string): Page {
    const page = this.#byId.get(pageId);
    if (!page || page.isClosed()) {
      throw new ObactError('page_not_found', `找不到标签页：${pageId}`, { pageId });
    }
    return page;
  }

  has(pageId: string): boolean {
    return this.#byId.has(pageId);
  }

  idOf(page: Page): string | undefined {
    return this.#ids.get(page);
  }

  list(): { pageId: string; url: string }[] {
    return [...this.#byId].map(([pageId, page]) => ({ pageId, url: page.url() }));
  }

  /** 新建标签页并登记。 */
  async newPage(opts: { pageId?: string; url?: string } = {}): Promise<string> {
    const page = await this.#browser.newPage();
    const pageId = this.register(page, opts.pageId);
    if (opts.url) await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    return pageId;
  }

  /** 接管浏览器里已有的标签页（任务子进程重连时，FR-03）。 */
  async adoptExisting(): Promise<string[]> {
    const ids: string[] = [];
    for (const page of await this.#browser.pages()) ids.push(this.register(page));
    return ids;
  }

  mark(): number {
    return this.#seq;
  }

  /** mark() 之后新登记的页面。 */
  createdSince(mark: number): string[] {
    return [...this.#order].filter(([, seq]) => seq > mark).map(([id]) => id);
  }
}
