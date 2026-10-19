/**
 * 接口响应缓存（FR-10，PRD 5.6）：每个标签页缓存最近的 JSON 响应，抽取步骤按“动作序号”读取。
 *
 * - 用 CDP Network 域监听每个标签页（包括 attach 之后新开的）：只对 JSON 响应（mime 含 json）且 URL 命中规则
 *   （或 captureAll）的，在 loadingFinished 后取 body 并解析；解析失败、超过 maxBytes 的丢弃；
 *   每页只保留最近 maxPerPage 条，超出淘汰最早的。
 * - 每条记录响应到达（responseReceived）时的动作序号 currentActionSeq(session)。act 开始时序号加一，
 *   所以“seq ≥ 上一个动作的序号”就是“上一个动作开始之后到达”，不需要事先挂监听，
 *   点击后几十毫秒就返回的响应也不会错过。
 * - wait 是事件驱动的：缓存里已有就立刻返回，否则等到新响应入缓存或超时，不做定时轮询。
 *
 * 已知限制：跨域 iframe（独立进程）里的请求不在标签页的 Network 域里，不会被缓存；
 * attach 之后新开的标签页要等 CDP 会话建好才开始记录（`await cache.ready()` 可等到全部就绪），
 * 新标签页最初几毫秒内的请求可能漏掉。
 */
import type { CDPSession, Page, Protocol, Target } from 'puppeteer-core';
import { currentActionSeq } from './act/state.ts';
import { ObactError } from './errors.ts';
import type { Session } from './session.ts';

const DEFAULT_MAX_PER_PAGE = 30;
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 同时记着的“未完成请求的方法”上限，防止页面异常时无限增长。 */
const MAX_TRACKED_REQUESTS = 5000;

/** 缓存里的一条接口响应。body 是解析后的 JSON，由缓存和调用方共享，只读。 */
export type NetworkEntry = {
  id: string;
  pageId: string;
  url: string;
  method: string;
  status: number;
  /** 响应到达时的动作序号（act 开始时递增）。 */
  seq: number;
  /** 响应到达的时间（毫秒时间戳）。 */
  time: number;
  body: unknown;
};

export type NetworkAttachOptions = {
  /** 要缓存的接口 URL 规则：正则，或正则的源码字符串（工作流 intercept 的写法）。 */
  rules: (RegExp | string)[];
  /** 缓存所有 JSON 响应（录制与探索时用）。 */
  captureAll?: boolean;
  /** 每个标签页最多保留几条，默认 30。 */
  maxPerPage?: number;
  /** 单条 body 的字节上限，默认 1 MiB；超过的丢弃。 */
  maxBytes?: number;
};

export type NetworkWaitOptions = {
  /** URL 正则（字符串按正则源码处理）。 */
  url: RegExp | string;
  /** 请求方法，不区分大小写；省略则不限。 */
  method?: string;
  /** 只要 seq ≥ afterSeq 的响应；抽取时传上一个动作的序号。 */
  afterSeq: number;
  timeoutMs: number;
};

type Config = {
  rules: RegExp[];
  captureAll: boolean;
  maxPerPage: number;
  maxBytes: number;
};

type Pending = { url: string; method: string; status: number; seq: number; time: number };

type Rec = Pending & { id: string; page: Page; body: unknown };

type Waiter = {
  match(e: Rec): boolean;
  resolve(e: Rec): void;
  reject(err: ObactError): void;
  timer: NodeJS.Timeout | undefined;
};

/** 一个标签页上的监听状态。 */
type Tap = {
  page: Page;
  cdp: CDPSession;
  /** 最旧的在前。 */
  entries: Rec[];
  waiters: Set<Waiter>;
  /** 已判定要缓存、等 loadingFinished 取 body 的响应。 */
  pending: Map<string, Pending>;
  /** requestId → 请求方法（responseReceived 里没有方法）。 */
  methods: Map<string, string>;
};

function toRegExp(r: RegExp | string, what: string): RegExp {
  try {
    return typeof r === 'string'
      ? new RegExp(r)
      : new RegExp(r.source, r.flags.replace(/[gy]/g, ''));
  } catch (e) {
    throw new ObactError('invalid_params', `${what}不是合法的正则：${String(r)}`, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function positiveInt(v: number | undefined, dflt: number, what: string): number {
  if (v === undefined) return dflt;
  if (!Number.isInteger(v) || v < 1) {
    throw new ObactError('invalid_params', `${what}必须是正整数：${v}`);
  }
  return v;
}

const isJsonMime = (mime: string | undefined): boolean => /json/i.test(mime ?? '');

/** 响应的 mime：优先用 CDP 解析好的 mimeType，没有时取 content-type 头。 */
function mimeOf(r: Protocol.Network.Response): string {
  if (r.mimeType) return r.mimeType;
  const key = Object.keys(r.headers ?? {}).find((k) => k.toLowerCase() === 'content-type');
  return key ? String(r.headers[key]) : '';
}

export class NetworkCache {
  readonly #session: Session;
  #cfg: Config | null = null;
  readonly #taps = new Map<Page, Tap>();
  /** 每个页面只建一次监听。 */
  readonly #setups = new Map<Page, Promise<void>>();
  /** 还没完成的建立过程（新标签页的 targetcreated 到监听就绪之间）。 */
  readonly #starting = new Set<Promise<void>>();
  readonly #byId = new Map<string, Rec>();
  #nextId = 0;
  #listening = false;
  #disposed = false;
  readonly #onTarget = (t: Target) => {
    if (t.type() !== 'page' || !this.#cfg) return;
    this.#start(
      t
        .page()
        .then((page) => (page ? this.#track(page) : undefined))
        .catch(() => {}),
    );
  };
  readonly #onDisconnected = () =>
    this.dispose(new ObactError('browser_disconnected', '浏览器已断开'));

  constructor(session: Session) {
    this.#session = session;
  }

  /** 同 getByPath：按 `data.list`、`a[0].b` 取 body 里的字段。 */
  static getByPath(body: unknown, path: string): unknown {
    return getByPath(body, path);
  }

  /**
   * 开始监听：已有的标签页立刻挂上，之后新开的标签页自动挂上。
   * 再次调用会更新规则与上限（已缓存的条目保留）。返回时已有标签页都已就绪。
   */
  async attach(opts: NetworkAttachOptions): Promise<void> {
    if (this.#disposed) throw new ObactError('internal', '接口缓存已释放');
    this.#cfg = {
      rules: opts.rules.map((r) => toRegExp(r, '接口规则')),
      captureAll: opts.captureAll ?? false,
      maxPerPage: positiveInt(opts.maxPerPage, DEFAULT_MAX_PER_PAGE, 'maxPerPage'),
      maxBytes: positiveInt(opts.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
    };
    if (!this.#listening) {
      this.#listening = true;
      this.#session.browser.on('targetcreated', this.#onTarget);
      this.#session.browser.on('disconnected', this.#onDisconnected);
    }
    for (const page of await this.#session.browser.pages()) this.#start(this.#track(page));
    await this.ready();
  }

  /** 等到所有正在建立的监听就绪（新开标签页后、导航之前调用，可保证不漏掉页面加载时的接口）。 */
  async ready(): Promise<void> {
    while (this.#starting.size) await Promise.all([...this.#starting]);
  }

  /** 标签页上缓存的响应，最旧的在前（按入缓存的先后）。 */
  list(pageId: string): NetworkEntry[] {
    const tap = this.#taps.get(this.#session.pages.get(pageId));
    return tap ? tap.entries.map((e) => this.#view(e)) : [];
  }

  /** 按 id 取一条；已被淘汰或不存在返回 undefined。 */
  get(id: string): NetworkEntry | undefined {
    const rec = this.#byId.get(id);
    return rec ? this.#view(rec) : undefined;
  }

  /** 清空一个标签页（不给则全部）的缓存。 */
  clear(pageId?: string): void {
    const taps = pageId
      ? [this.#taps.get(this.#session.pages.get(pageId))].filter((t): t is Tap => !!t)
      : [...this.#taps.values()];
    for (const tap of taps) {
      for (const e of tap.entries) this.#byId.delete(e.id);
      tap.entries.length = 0;
    }
  }

  /**
   * 等一条“seq ≥ afterSeq、URL 与方法匹配”的响应，返回其中最近的一条。缓存里已有就立刻返回；
   * 否则等新响应入缓存（事件驱动），超时抛 ObactError('timeout')。
   */
  async wait(pageId: string, opts: NetworkWaitOptions): Promise<NetworkEntry> {
    const page = this.#session.pages.get(pageId);
    const rx = toRegExp(opts.url, 'URL 规则');
    const method = opts.method?.toUpperCase();
    let found = this.#taps.get(page);
    if (!found) {
      await this.ready();
      found = this.#taps.get(page);
    }
    if (!found) {
      throw new ObactError('invalid_params', '该标签页没有接口缓存（尚未 attach，或页面已关闭）', {
        pageId,
      });
    }
    const tap: Tap = found;
    const match = (e: Rec) =>
      e.seq >= opts.afterSeq && (!method || e.method === method) && rx.test(e.url);
    for (let i = tap.entries.length - 1; i >= 0; i--) {
      const e = tap.entries[i] as Rec;
      if (match(e)) return this.#view(e);
    }
    const timedOut = () =>
      new ObactError('timeout', `等待接口响应超时（${opts.timeoutMs} 毫秒）：${rx}`, {
        pageId,
        url: rx.source,
        ...(method ? { method } : {}),
        afterSeq: opts.afterSeq,
        timeoutMs: opts.timeoutMs,
        cached: tap.entries.length,
      });
    if (!(opts.timeoutMs > 0)) throw timedOut();
    return new Promise<NetworkEntry>((resolve, reject) => {
      const w: Waiter = {
        match,
        resolve: (e) => resolve(this.#view(e)),
        reject,
        timer: undefined,
      };
      w.timer = setTimeout(() => {
        tap.waiters.delete(w);
        reject(timedOut());
      }, opts.timeoutMs);
      tap.waiters.add(w);
    });
  }

  /** 停止监听并释放：等待中的 wait 以 err 失败。 */
  dispose(err: ObactError = new ObactError('internal', '接口缓存已释放')): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.browser.off('targetcreated', this.#onTarget);
    this.#session.browser.off('disconnected', this.#onDisconnected);
    for (const tap of [...this.#taps.values()]) this.#drop(tap, err);
    this.#byId.clear();
  }

  #start(p: Promise<void>): void {
    this.#starting.add(p);
    void p.finally(() => this.#starting.delete(p));
  }

  #view(e: Rec): NetworkEntry {
    return {
      id: e.id,
      pageId: this.#session.pages.idOf(e.page) ?? '',
      url: e.url,
      method: e.method,
      status: e.status,
      seq: e.seq,
      time: e.time,
      body: e.body,
    };
  }

  #track(page: Page): Promise<void> {
    let p = this.#setups.get(page);
    if (!p) {
      // 页面在建立过程中关闭等情况：忽略，不影响其他页面
      p = this.#open(page).catch(() => {});
      this.#setups.set(page, p);
      page.once('close', () => this.#setups.delete(page));
    }
    return p;
  }

  async #open(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const cfg = this.#cfg as Config;
    const cdp = await page.createCDPSession();
    const tap: Tap = {
      page,
      cdp,
      entries: [],
      waiters: new Set(),
      pending: new Map(),
      methods: new Map(),
    };
    cdp.on('Network.requestWillBeSent', (e) => {
      if (tap.methods.size >= MAX_TRACKED_REQUESTS) tap.methods.clear();
      tap.methods.set(e.requestId, e.request.method);
    });
    cdp.on('Network.responseReceived', (e) => this.#onResponse(tap, e));
    cdp.on('Network.loadingFinished', (e) => void this.#onFinished(tap, e));
    cdp.on('Network.loadingFailed', (e) => {
      tap.pending.delete(e.requestId);
      tap.methods.delete(e.requestId);
    });
    page.once('close', () => this.#drop(tap, new ObactError('page_not_found', '标签页已关闭', {})));
    this.#taps.set(page, tap);
    await cdp.send('Network.enable', {
      maxTotalBufferSize: Math.max(16 * 1024 * 1024, cfg.maxBytes * 4),
      maxResourceBufferSize: Math.max(2 * 1024 * 1024, cfg.maxBytes * 2),
    });
  }

  #drop(tap: Tap, err: ObactError): void {
    if (this.#taps.get(tap.page) !== tap) return;
    this.#taps.delete(tap.page);
    for (const e of tap.entries) this.#byId.delete(e.id);
    for (const w of tap.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    tap.waiters.clear();
    void tap.cdp.detach().catch(() => {});
  }

  /** 响应到达：判定要不要缓存，并记下此刻的动作序号。 */
  #onResponse(tap: Tap, e: Protocol.Network.ResponseReceivedEvent): void {
    const cfg = this.#cfg;
    if (!cfg || !isJsonMime(mimeOf(e.response))) return;
    const url = e.response.url;
    if (!cfg.captureAll && !cfg.rules.some((r) => r.test(url))) return;
    tap.pending.set(e.requestId, {
      url,
      method: tap.methods.get(e.requestId) ?? 'GET',
      status: e.response.status,
      seq: currentActionSeq(this.#session),
      time: Date.now(),
    });
  }

  /** 响应完成：取 body、解析、入缓存、唤醒等待者。 */
  async #onFinished(tap: Tap, e: Protocol.Network.LoadingFinishedEvent): Promise<void> {
    tap.methods.delete(e.requestId);
    const p = tap.pending.get(e.requestId);
    const cfg = this.#cfg;
    if (!p || !cfg) return;
    tap.pending.delete(e.requestId);
    // 传输长度已经超限的不必取（解压后只会更大）
    if (e.encodedDataLength > cfg.maxBytes) return;
    let body: unknown;
    try {
      const r = await tap.cdp.send('Network.getResponseBody', { requestId: e.requestId });
      const raw = r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8');
      if (raw.length > cfg.maxBytes) return;
      body = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
    } catch {
      // 取不到（页面已跳转、响应被回收）或不是合法 JSON：丢弃
      return;
    }
    if (this.#taps.get(tap.page) !== tap) return;
    const rec: Rec = { ...p, id: `n${++this.#nextId}`, page: tap.page, body };
    tap.entries.push(rec);
    this.#byId.set(rec.id, rec);
    while (tap.entries.length > cfg.maxPerPage) {
      const old = tap.entries.shift() as Rec;
      this.#byId.delete(old.id);
    }
    for (const w of [...tap.waiters]) {
      if (!w.match(rec)) continue;
      clearTimeout(w.timer);
      tap.waiters.delete(w);
      w.resolve(rec);
    }
  }
}

/** 取出 JSON 里 `a.b[0].c`、`a.0.b`、`['a.b']` 形式的路径；空路径返回整个 body，路径不存在返回 undefined。 */
export function getByPath(body: unknown, path: string): unknown {
  const p = path.trim().replace(/^\$\.?/, '');
  if (p === '') return body;
  const keys: string[] = [];
  for (const m of p.matchAll(/\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]|([^.[\]]+)/g)) {
    keys.push((m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
  }
  let cur: unknown = body;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
