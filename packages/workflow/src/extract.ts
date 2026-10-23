/**
 * 抽取（FR-09、FR-10，PRD 5.6）：从渲染后的页面抽取表格 / 列表 / 键值，或读取接口缓存里的 JSON 响应。
 *
 * - 页面抽取 extractFromPage：定位 root 后在页面内读取（innerText，值做空白折叠与 trim）；
 *   pagination.next 用 act 点击翻页，等“数据变化或 URL 变化”后继续，直到下一页不可用或 max_pages；
 *   scroll 滚动 container，每轮收集新出现的行（按主键或整行内容去重），连续 idle_rounds 轮没有新数据或达 max_rounds 结束。
 *   每次读取都等页面稳定（连续两次读到相同内容、且滚动/翻页之后发起的 XHR/fetch 都已结束），不用固定延时。
 * - 接口抽取 extractFromResponse：从 NetworkCache 取“afterSeq 之后到达、URL 匹配”的最近一条，按字段路径取数据。
 *
 * 返回的 count 是去重前的总数；跨页、跨次的主键去重由调用方（采集输出）完成。
 * 滚动收集内部会按行去重，因为同一行会在相邻几轮里重复出现。
 */
import {
  act,
  asObactError,
  getByPath,
  type NetworkCache,
  ObactError,
  resolveLocator,
  type Session,
} from '@obact/core';
import type { DomSource, Locator, ResponseSource } from '@obact/schemas';
import type { ExtractResult } from './types.ts';

type Page = ReturnType<Session['pages']['get']>;
type Handle = Awaited<ReturnType<typeof resolveLocator>>['handle'];
/** 页面抽取读到的一行：字段名 → 文本（选择器没有命中为 null）。 */
export type PageRow = Record<string, string | null>;

export type ExtractPageOptions = {
  /** 主键字段：滚动收集时按它去重（缺省按整行内容）。 */
  key?: string;
  /** 等待上限（毫秒）：定位到 root、翻页后内容变化、页面稳定都用它，默认 5000。 */
  waitMs?: number;
  /** 滚动收集：从当前位置开始（缺省先把容器滚回顶部）。 */
  fromCurrent?: boolean;
  /** 中止：每一轮检查一次。 */
  signal?: AbortSignal;
};

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_MAX_PAGES = 1000;
const DEFAULT_MAX_ROUNDS = 5000;
const DEFAULT_IDLE_ROUNDS = 3;
/** 稳定检查的间隔与单次上限。 */
const POLL_MS = 20;
const SETTLE_CAP_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------------
// 页面内函数：自包含（puppeteer 把函数源码送进页面执行，不能引用模块里的其他东西）
// ------------------------------------------------------------------------------------------------

type ReadSpec = {
  kind: 'table' | 'list' | 'kv';
  item?: string;
  fields?: Record<string, string>;
};

type ReadOut =
  | { ok: true; rows: Record<string, string | null>[]; ready: boolean }
  | { ok: false; selector: string; message: string };

/**
 * 读取 root 下的数据行。
 * - table：HTML 表格或 ARIA 表格（role=table/grid）；表头（thead 或 columnheader）为字段名，空表头记为 colN，
 *   重名加 _2、_3；给了 fields 则按“字段名 → 相对行的选择器”取值（值写成表头文字则取该列）；空状态行与全空行跳过。
 * - list：item 选择器（缺省取 root 的子元素）每个命中一行；fields 同上，缺省取整项文本放在 text。
 * - kv：dt/dd 或两列行（th/td、role=row），得到一行，键为字段名；给了 fields 则按选择器取值。
 * 字段 "sel@attr" 取属性（sel 为空取项本身）；href、src 取浏览器解析后的绝对地址。
 */
function obRead(root: Element, spec: ReadSpec): ReadOut {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const textOf = (el: Element) => collapse((el as HTMLElement).innerText ?? el.textContent ?? '');
  let bad: { selector: string; message: string } | null = null;

  // "sel@attr"：@ 必须在括号和引号之外，attr 必须是属性名
  const splitField = (f: string): { sel: string; attr: string | null } => {
    let depth = 0;
    let quote = '';
    let at = -1;
    for (let i = 0; i < f.length; i++) {
      const c = f.charAt(i);
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === '@' && depth === 0) at = i;
    }
    if (at < 0) return { sel: f.trim(), attr: null };
    const attr = f.slice(at + 1).trim();
    if (!/^[A-Za-z_][\w:.-]*$/.test(attr)) return { sel: f.trim(), attr: null };
    return { sel: f.slice(0, at).trim(), attr };
  };
  const query = (scope: Element, sel: string): Element | null => {
    if (sel === '' || sel === ':scope' || sel === '.') return scope;
    try {
      return scope.querySelector(/^[>+~]/.test(sel) ? `:scope ${sel}` : sel);
    } catch (e) {
      bad = { selector: sel, message: e instanceof Error ? e.message : String(e) };
      return null;
    }
  };
  const attrOf = (el: Element, attr: string): string | null => {
    if (!el.hasAttribute(attr) && attr !== 'value') return null;
    const prop = (el as unknown as Record<string, unknown>)[attr];
    if ((attr === 'href' || attr === 'src' || attr === 'value') && typeof prop === 'string') {
      return prop.trim();
    }
    return (el.getAttribute(attr) ?? '').trim();
  };
  const readField = (scope: Element, f: string): string | null => {
    const { sel, attr } = splitField(f);
    const el = query(scope, sel);
    if (!el) return null;
    return attr === null ? textOf(el) : attrOf(el, attr);
  };
  const mapFields = (scope: Element, fields: Record<string, string>) => {
    const row: Record<string, string | null> = {};
    for (const [name, f] of Object.entries(fields)) row[name] = readField(scope, f);
    return row;
  };
  const empty = (row: Record<string, string | null>) =>
    Object.values(row).every((v) => v === null || v === '');
  const unique = (names: string[]) => {
    const seen = new Set<string>();
    return names.map((n, i) => {
      const base = n || `col${i + 1}`;
      let name = base;
      for (let k = 2; seen.has(name); k++) name = `${base}_${k}`;
      seen.add(name);
      return name;
    });
  };
  const cellsOf = (row: Element): Element[] =>
    row.tagName === 'TR'
      ? [...row.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      : [
          ...row.querySelectorAll(
            '[role=cell], [role=gridcell], [role=rowheader], [role=columnheader]',
          ),
        ].filter((c) => c.closest('[role=row]') === row);
  const span = (c: Element) => Math.max(1, (c as HTMLTableCellElement).colSpan || 1);

  const TABLE = 'table, [role=table], [role=grid], [role=treegrid]';
  const readTable = () => {
    const table = root.matches(TABLE) ? root : (root.querySelector(TABLE) ?? root);
    const html = table.tagName === 'TABLE';
    const own = (e: Element) => e.closest(TABLE) === table;
    const all = [...table.querySelectorAll(html ? 'tr' : '[role=row]')].filter(own);
    const hasThead = html && all.some((r) => r.parentElement?.tagName === 'THEAD');
    const isHeader = (r: Element, i: number) => {
      if (!html) return cellsOf(r).some((c) => c.getAttribute('role') === 'columnheader');
      if (r.parentElement?.tagName === 'THEAD') return true;
      const cells = cellsOf(r);
      return !hasThead && i === 0 && cells.length > 0 && cells.every((c) => c.tagName === 'TH');
    };
    const headerRows = all.filter(isHeader);
    const headerRow = headerRows[headerRows.length - 1];
    const names: string[] = [];
    if (headerRow) {
      for (const c of cellsOf(headerRow)) for (let k = 0; k < span(c); k++) names.push(textOf(c));
    }
    const heads = unique(names);
    const body = all.filter((r, i) => !isHeader(r, i) && r.parentElement?.tagName !== 'TFOOT');
    const rows: Record<string, string | null>[] = [];
    for (const r of body) {
      const cells = cellsOf(r);
      if (cells.length === 0) continue;
      // “暂无数据”之类横跨整行的空状态行
      if (cells.length === 1 && span(cells[0] as Element) > 1 && heads.length !== 1) continue;
      const row: Record<string, string | null> = {};
      const byCol: Element[] = [];
      for (const c of cells) for (let k = 0, n = span(c); k < n; k++) byCol.push(c);
      if (spec.fields) {
        // 字段值写成表头文字（可带 @attr）时按列取，否则当作相对行的选择器
        for (const [name, f] of Object.entries(spec.fields)) {
          const { sel, attr } = splitField(f);
          const idx = sel === '' ? -1 : heads.indexOf(sel);
          const cell = idx >= 0 ? byCol[idx] : undefined;
          if (idx < 0) row[name] = readField(r, f);
          else if (!cell) row[name] = null;
          else row[name] = attr === null ? textOf(cell) : attrOf(cell, attr);
        }
      } else {
        let col = 0;
        for (const c of cells) {
          row[heads[col] ?? `col${col + 1}`] = textOf(c);
          col += span(c);
        }
      }
      if (!empty(row)) rows.push(row);
    }
    return rows;
  };

  const readList = () => {
    let items: Element[];
    if (spec.item) {
      try {
        items = [
          ...root.querySelectorAll(/^[>+~]/.test(spec.item) ? `:scope ${spec.item}` : spec.item),
        ];
      } catch (e) {
        bad = { selector: spec.item, message: e instanceof Error ? e.message : String(e) };
        return [];
      }
    } else items = [...root.children];
    const rows: Record<string, string | null>[] = [];
    for (const it of items) {
      const row = spec.fields ? mapFields(it, spec.fields) : { text: textOf(it) };
      if (!empty(row)) rows.push(row);
    }
    return rows;
  };

  const readKv = () => {
    if (spec.fields) return [mapFields(root, spec.fields)];
    const obj: Record<string, string | null> = {};
    const put = (key: string, value: string) => {
      const k = collapse(key).replace(/\s*[:：]$/, '');
      if (!k) return;
      let name = k;
      for (let i = 2; name in obj; i++) name = `${k}_${i}`;
      obj[name] = value;
    };
    const dts = [...root.querySelectorAll('dt')];
    if (dts.length) {
      for (const dt of dts) {
        const values: string[] = [];
        for (let n = dt.nextElementSibling; n && n.tagName !== 'DT'; n = n.nextElementSibling) {
          if (n.tagName === 'DD') values.push(textOf(n));
        }
        put(textOf(dt), values.join(' '));
      }
    } else {
      for (const r of root.querySelectorAll('tr, [role=row]')) {
        const cells = cellsOf(r);
        if (cells.length >= 2)
          put(textOf(cells[0] as Element), cells.slice(1).map(textOf).join(' '));
      }
    }
    return Object.keys(obj).length ? [obj] : [];
  };

  const rows = spec.kind === 'table' ? readTable() : spec.kind === 'list' ? readList() : readKv();
  if (bad) return { ok: false, ...(bad as { selector: string; message: string }) };
  return { ok: true, rows, ready: document.readyState !== 'loading' };
}

/**
 * 滚动：mode 为 top 回到顶部，step 向下滚容器可见高度的 80%（保证相邻两轮的可见范围有重叠，不漏行）。
 * 没给容器时依次找：root 自己、root 里面最大的可滚动元素、祖先里的可滚动元素、整个文档。
 */
function obScroll(
  root: Element,
  container: Element | null,
  mode: 'top' | 'step',
): { moved: boolean } {
  let sc: Element | null = container;
  if (!sc) {
    const scrollable = (e: Element) => {
      if (/^(TEXTAREA|SELECT|INPUT)$/.test(e.tagName)) return false;
      return (
        /auto|scroll|overlay/.test(getComputedStyle(e).overflowY) &&
        e.scrollHeight > e.clientHeight + 1
      );
    };
    if (scrollable(root)) sc = root;
    else {
      let best = 0;
      for (const e of root.querySelectorAll('*')) {
        if (scrollable(e) && e.clientHeight > best) {
          best = e.clientHeight;
          sc = e;
        }
      }
    }
    for (let p = root.parentElement; !sc && p; p = p.parentElement) if (scrollable(p)) sc = p;
    if (!sc) sc = document.scrollingElement ?? document.documentElement;
  }
  const el = sc as HTMLElement;
  const before = el.scrollTop;
  el.scrollTop = mode === 'top' ? 0 : before + Math.max(1, Math.floor(el.clientHeight * 0.8));
  return { moved: el.scrollTop !== before };
}

/** “下一页”是否不可用：自己或父元素 disabled、aria-disabled，或类名带 disabled（page-item disabled、ant-xxx-disabled）。 */
function obDisabled(el: Element): boolean {
  const flagged = (e: Element) =>
    e.matches(':disabled') ||
    e.getAttribute('aria-disabled') === 'true' ||
    (typeof e.className === 'string' && /(^|[\s_-])disabled($|[\s_-])/.test(e.className));
  return flagged(el) || (el.parentElement ? flagged(el.parentElement) : false);
}

// ------------------------------------------------------------------------------------------------
// 页面抽取
// ------------------------------------------------------------------------------------------------

/** 跟踪页面上 XHR/fetch 请求的进行情况：滚动、翻页之后要等它们结束再读。 */
class Inflight {
  readonly #open = new Set<object>();
  readonly #page: Page;
  readonly #on = (r: { resourceType(): string }) => {
    const t = r.resourceType();
    if (t === 'xhr' || t === 'fetch') this.#open.add(r);
  };
  readonly #done = (r: object) => void this.#open.delete(r);

  constructor(page: Page) {
    this.#page = page;
    page.on('request', this.#on);
    page.on('requestfinished', this.#done);
    page.on('requestfailed', this.#done);
  }

  get count(): number {
    return this.#open.size;
  }

  dispose(): void {
    this.#page.off('request', this.#on);
    this.#page.off('requestfinished', this.#done);
    this.#page.off('requestfailed', this.#done);
  }
}

/** 读取过程中可以重试的错误：元素还没出现、页面正在换文档。 */
const retryable = (e: unknown): boolean => {
  if (!(e instanceof ObactError)) return true;
  return e.code === 'not_found' || e.code === 'not_unique' || e.code === 'stale_ref';
};

class PageExtractor {
  readonly #session: Session;
  readonly #pageId: string;
  readonly #page: Page;
  readonly #source: DomSource;
  readonly #spec: ReadSpec;
  readonly #opts: ExtractPageOptions;
  readonly #waitMs: number;
  readonly #inflight: Inflight;
  readonly notes: string[] = [];

  constructor(session: Session, pageId: string, source: DomSource, opts: ExtractPageOptions) {
    this.#session = session;
    this.#pageId = pageId;
    this.#page = session.pages.get(pageId);
    this.#source = source;
    this.#opts = opts;
    this.#waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(source.fields ?? {}))
      if (typeof v === 'string') fields[k] = v;
    this.#spec = {
      kind: source.kind,
      ...(source.item ? { item: source.item } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    };
    this.#inflight = new Inflight(this.#page);
  }

  dispose(): void {
    this.#inflight.dispose();
  }

  #note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  #alive(): void {
    this.#opts.signal?.throwIfAborted();
  }

  /** 读一次 root 下的行（不等稳定）。 */
  async #read(): Promise<{ rows: PageRow[]; ready: boolean }> {
    const { handle } = await resolveLocator(this.#session, this.#pageId, this.#source.root);
    try {
      const out = await handle.evaluate(obRead, this.#spec);
      if (!out.ok) {
        throw new ObactError(
          'invalid_params',
          `抽取的选择器无效：${out.selector}（${out.message}）`,
          {
            selector: out.selector,
          },
        );
      }
      return out;
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  /**
   * 读到稳定的内容：连续两次读到相同的行，页面文档已解析完，且滚动/翻页之后发起的 XHR/fetch 都已结束。
   * 上限 cap 毫秒；到点还没稳定就按最后一次读到的返回（记在说明里）。root 一直找不到则抛出定位错误。
   */
  async #readStable(cap: number): Promise<PageRow[]> {
    const deadline = Date.now() + cap;
    let prev: string | null = null;
    let last: PageRow[] | null = null;
    let lastErr: unknown;
    for (;;) {
      this.#alive();
      try {
        const r = await this.#read();
        last = r.rows;
        lastErr = undefined;
        const sig = JSON.stringify(r.rows);
        if (r.ready && sig === prev && this.#inflight.count === 0) return r.rows;
        prev = sig;
      } catch (e) {
        if (!retryable(e)) throw e;
        lastErr = e;
        prev = null;
      }
      if (Date.now() >= deadline) {
        if (lastErr !== undefined || last === null) throw asObactError(lastErr);
        this.#note(`页面在 ${cap} 毫秒内没有稳定，按当前内容读取`);
        return last;
      }
      await sleep(POLL_MS);
    }
  }

  /** 翻页前后比较用的特征：行数 + 首行 + 末行；读不到返回 null。 */
  async #signature(): Promise<string | null> {
    try {
      const { rows } = await this.#read();
      return JSON.stringify([rows.length, rows[0], rows[rows.length - 1]]);
    } catch {
      return null;
    }
  }

  /** 两帧：滚动事件与据此发起的渲染、请求都已发生。后台标签页不出帧，所以限时。 */
  async #frames(): Promise<void> {
    await Promise.race([
      this.#page.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      ),
      sleep(150),
    ]).catch(() => {});
  }

  async #scroll(mode: 'top' | 'step'): Promise<boolean> {
    const deadline = Date.now() + this.#waitMs;
    for (;;) {
      this.#alive();
      const handles: Handle[] = [];
      try {
        const root = await resolveLocator(this.#session, this.#pageId, this.#source.root);
        handles.push(root.handle);
        let container: Handle | null = null;
        if (this.#source.scroll?.container) {
          container = (
            await resolveLocator(this.#session, this.#pageId, this.#source.scroll.container)
          ).handle;
          handles.push(container);
        }
        return (await root.handle.evaluate(obScroll, container, mode)).moved;
      } catch (e) {
        if (!retryable(e) || Date.now() >= deadline) throw asObactError(e);
      } finally {
        for (const h of handles) await h.dispose().catch(() => {});
      }
      await sleep(POLL_MS);
    }
  }

  #rowKey(row: PageRow): string {
    const k = this.#opts.key ? row[this.#opts.key] : undefined;
    return k !== undefined && k !== null && k !== '' ? `k:${k}` : `c:${JSON.stringify(row)}`;
  }

  /** 滚动收集：每轮读取当前渲染出来的行，只留新出现的；连续 idle_rounds 轮没有新数据或达 max_rounds 结束。 */
  async #collectByScroll(): Promise<PageRow[]> {
    const sc = this.#source.scroll ?? {};
    const maxRounds = sc.max_rounds ?? DEFAULT_MAX_ROUNDS;
    const idleRounds = sc.idle_rounds ?? DEFAULT_IDLE_ROUNDS;
    const vis = await this.#page.evaluate(() => document.visibilityState).catch(() => 'visible');
    if (vis !== 'visible') await this.#page.bringToFront().catch(() => {});
    if (!this.#opts.fromCurrent && (await this.#scroll('top'))) await this.#frames();

    const seen = new Set<string>();
    const out: PageRow[] = [];
    let idle = 0;
    let round = 0;
    for (;;) {
      round++;
      // 第一轮可能要等 root 出现，之后每轮只等稳定
      const rows = await this.#readStable(round === 1 ? this.#waitMs : SETTLE_CAP_MS);
      let fresh = 0;
      for (const row of rows) {
        const k = this.#rowKey(row);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(row);
        fresh++;
      }
      idle = fresh ? 0 : idle + 1;
      if (idle >= idleRounds) {
        this.#note(`滚动 ${round} 轮，连续 ${idle} 轮没有新数据，结束`);
        break;
      }
      if (round >= maxRounds) {
        this.#note(`滚动 ${round} 轮，达到 max_rounds=${maxRounds}，结束`);
        break;
      }
      if (await this.#scroll('step')) await this.#frames();
    }
    return out;
  }

  /** 点“下一页”并等内容变化：返回 false 表示没有下一页。 */
  async #turnPage(): Promise<boolean> {
    const next = this.#source.pagination?.next as Locator;
    let handle: Handle;
    try {
      handle = (await resolveLocator(this.#session, this.#pageId, next)).handle;
    } catch (e) {
      if (e instanceof ObactError && e.code === 'not_found') {
        this.#note('没有“下一页”，结束');
        return false;
      }
      throw e;
    }
    const disabled = await handle
      .evaluate(obDisabled)
      .finally(() => handle.dispose().catch(() => {}));
    if (disabled) {
      this.#note('“下一页”已禁用，结束');
      return false;
    }
    const before = await this.#signature();
    const url = this.#page.url();
    const r = await act(this.#session, { op: 'click', pageId: this.#pageId, target: next });
    if (r.status === 'error') {
      throw new ObactError(
        r.error?.code ?? 'internal',
        `点击“下一页”失败：${r.error?.message}`,
        r.error?.details,
      );
    }
    const deadline = Date.now() + this.#waitMs;
    for (;;) {
      this.#alive();
      if (this.#page.url() !== url) return true;
      const now = await this.#signature();
      if (now !== null && now !== before) return true;
      if (Date.now() >= deadline) {
        this.#note(`点击“下一页”后 ${this.#waitMs} 毫秒内数据没有变化，按末页处理`);
        return false;
      }
      await sleep(POLL_MS);
    }
  }

  async run(): Promise<ExtractResult> {
    const maxPages = this.#source.pagination
      ? (this.#source.pagination.max_pages ?? DEFAULT_MAX_PAGES)
      : 1;
    const rows: PageRow[] = [];
    let pages = 0;
    for (;;) {
      this.#alive();
      pages++;
      const got = this.#source.scroll
        ? await this.#collectByScroll()
        : await this.#readStable(pages === 1 ? this.#waitMs : SETTLE_CAP_MS);
      rows.push(...got);
      if (!this.#source.pagination) break;
      if (pages >= maxPages) {
        this.#note(`达到 max_pages=${maxPages}，结束`);
        break;
      }
      if (!(await this.#turnPage())) break;
    }
    if (this.#source.pagination) this.notes.unshift(`翻页抽取 ${pages} 页`);
    return { rows, count: rows.length, notes: this.notes };
  }
}

/**
 * 页面抽取（FR-09）。root 找不到抛 not_found / not_unique；选择器写错抛 invalid_params；
 * 翻页点击失败抛 act 的错误码。
 */
export async function extractFromPage(
  session: Session,
  pageId: string,
  source: DomSource,
  opts: ExtractPageOptions = {},
): Promise<ExtractResult> {
  if (!source.root) throw new ObactError('invalid_params', '页面抽取需要 root 定位器');
  const ex = new PageExtractor(session, pageId, source, opts);
  try {
    return await ex.run();
  } finally {
    ex.dispose();
  }
}

// ------------------------------------------------------------------------------------------------
// 接口抽取
// ------------------------------------------------------------------------------------------------

/** 按字段路径取数据：`data.list`、`a.b[0].c`、`a.0.b`；空路径取整个 body，路径不存在返回 undefined。 */
export function pickPath(body: unknown, path: string): unknown {
  return getByPath(body, path);
}

/** 路径取到的值 → 行：数组逐项（对象原样，其他值放在 value），对象为一行，null 为空。 */
function toRows(value: unknown): Record<string, unknown>[] {
  if (value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v },
  );
}

/**
 * 接口抽取（FR-10，PRD 5.6）：读取 afterSeq 之后到达、URL（与方法）匹配的最近一条 JSON 响应，按 path 取数据。
 * 还没到达就等 waitMs（缺省 5000），超时抛 timeout；路径不存在抛 not_found。返回的行是深拷贝，可随意改动。
 */
export async function extractFromResponse(
  cache: NetworkCache,
  pageId: string,
  source: ResponseSource,
  afterSeq: number,
  waitMs: number = DEFAULT_WAIT_MS,
): Promise<ExtractResult> {
  const started = Date.now();
  const entry = await cache.wait(pageId, {
    url: source.url,
    ...(source.method ? { method: source.method } : {}),
    afterSeq,
    timeoutMs: waitMs,
  });
  const value = pickPath(entry.body, source.path);
  if (value === undefined) {
    throw new ObactError('not_found', `响应中没有字段路径 ${source.path}：${entry.url}`, {
      url: entry.url,
      path: source.path,
    });
  }
  const rows = structuredClone(toRows(value));
  const waited = Date.now() - started;
  return {
    rows,
    count: rows.length,
    notes: [
      `接口 ${entry.method} ${entry.url}（序号 ${entry.seq}）${waited > 0 ? `，等待 ${waited} 毫秒` : ''}`,
    ],
  };
}
