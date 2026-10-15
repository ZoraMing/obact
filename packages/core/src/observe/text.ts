/**
 * 纯网页信息（text_md）的页面内提取（在浏览器里执行，约定见 page/bundle.ts）：把不可操作的内容
 * （标题、正文、表格、列表、图片说明、键值对、对话框）转成 Markdown 行。
 *
 * 可操作元素只留 \uE000编号\uE001 占位（Node 侧换成 [编号]），不重复它们的文字；控件的标签文字同理。
 * 表格、列表只保留前若干行和视口内的行，并注明总数；每行标记是否在视口内，供字符预算截断时优先保留。
 */
import { obNorm, obShadow } from '../page/dom.ts';
import type { RawElement, Rect, TextLine } from './page.ts';

export type TextContext = {
  /** 本 frame 列出的可操作元素。 */
  listed: Map<Element, RawElement>;
  /** 文字已作为某个可操作元素名称的节点（label、aria-labelledby 指向的元素）。 */
  skip: Set<Element>;
  /** iframe → 序号；在其位置留子 frame 占位行。 */
  iframes: Map<Element, number>;
  clip: Rect;
  tableRows: number;
  listItems: number;
  /** 可操作元素的文字超过这个长度（卡片类）时，内容仍作为信息输出。 */
  longText: number;
};

export function obsText(c: TextContext): TextLine[] {
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'TITLE',
    'META',
    'LINK',
    'BASE',
    'OPTION',
    'OPTGROUP',
    'DATALIST',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'OBJECT',
    'EMBED',
    'MAP',
    'PARAM',
    'SOURCE',
    'TRACK',
  ]);
  const BLOCK = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BODY',
    'CAPTION',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'LEGEND',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'SUMMARY',
    'TABLE',
    'TR',
    'UL',
  ]);
  const BLOCK_DISPLAY = new Set([
    'block',
    'flex',
    'grid',
    'list-item',
    'table',
    'flow-root',
    'table-row',
    'table-row-group',
    'table-header-group',
    'table-footer-group',
    'table-caption',
  ]);
  const lines: TextLine[] = [];
  let buf = '';
  let bufVis = false;
  let blockVis = false;
  // 列表项的缩进与标记：first 用于下一行，rest 用于之后各行
  let first = '';
  let rest = '';

  const ph = (ref: number) => ` \uE000${ref}\uE001 `;
  const shown = (el: Element) => el.checkVisibility({ visibilityProperty: true });
  const visOf = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const x = Math.max(r.left, c.clip[0]);
    const y = Math.max(r.top, c.clip[1]);
    return (
      Math.min(r.right, c.clip[0] + c.clip[2]) > x && Math.min(r.bottom, c.clip[1] + c.clip[3]) > y
    );
  };
  const emit = (t: string, v: boolean) => {
    lines.push({ t: first + t, v: v ? 1 : 0 });
    first = rest;
  };
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t) emit(t.length > 3000 ? `${t.slice(0, 3000)}…` : t, bufVis);
    buf = '';
    bufVis = false;
  };
  const add = (s: string) => {
    if (!s) return;
    buf += s;
    if (blockVis) bufVis = true;
  };
  const display = (el: Element, tag: string) =>
    BLOCK.has(tag) ? 'block' : getComputedStyle(el).display;

  /** 可操作元素内部怎么处理：-1 不进入；1 只输出内部的其他可操作元素占位；0 内容作为信息输出。 */
  const descend = (el: Element, item: RawElement, mode: number): number => {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return -1;
    if ((el as HTMLElement).isContentEditable && el.hasAttribute('contenteditable')) return -1;
    if (mode === 1) return 1;
    // 滚动容器里的内容是信息
    if (item.kind === 'scroll') return 0;
    const text = obNorm((el as HTMLElement).innerText ?? el.textContent);
    const name = item.name.replace(/…$/, '');
    const covered =
      name.length > 0 &&
      text.length <= name.length + 2 &&
      (name.includes(text) || text.includes(name));
    return !covered || text.length > c.longText ? 0 : 1;
  };

  /** 把节点内容压成一行（标题、表格单元格、键值对）：保留可操作元素占位，不分行。 */
  const inline = (root: Element, mode: number): string => {
    const parts: string[] = [];
    const kids = (el: Element, m: number) => {
      for (const k of (obShadow(el) ?? el).childNodes) rec(k, m);
    };
    const rec = (n: Node, mode: number): void => {
      if (n.nodeType === 3) {
        if (mode === 0) parts.push((n as Text).data);
        return;
      }
      if (n.nodeType !== 1) return;
      const el = n as Element;
      const tag = el.tagName.toUpperCase();
      if (tag === 'SVG') {
        const label = obNorm(el.getAttribute('aria-label'));
        if (label && mode === 0) parts.push(` ![${label}] `);
        return;
      }
      if (SKIP.has(tag) || tag === 'IFRAME' || tag === 'FRAME') return;
      if (tag === 'SLOT') {
        const nodes = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        for (const k of nodes.length ? nodes : [...el.childNodes]) rec(k, mode);
        return;
      }
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (!shown(el)) {
        if (getComputedStyle(el).display === 'contents') kids(el, mode);
        return;
      }
      const item = c.listed.get(el);
      let m = mode;
      if (item) {
        parts.push(ph(item.ref));
        m = descend(el, item, mode);
        if (m < 0) return;
      } else if (c.skip.has(el)) m = 1;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (m === 0 && (tag === 'IMG' || el.getAttribute('role') === 'img')) {
        const alt = obNorm(el.getAttribute('alt') ?? el.getAttribute('aria-label'));
        if (alt) parts.push(` ![${alt}] `);
        return;
      }
      if (tag === 'BR') {
        parts.push(' ');
        return;
      }
      const block = BLOCK.has(tag);
      if (block) parts.push(' ');
      kids(el, m);
      if (block) parts.push(' ');
    };
    kids(root, mode);
    return parts.join('').replace(/\s+/g, ' ').trim();
  };

  const heading = (el: Element, tag: string) => {
    flush();
    const level = /^H[1-6]$/.test(tag)
      ? Number(tag[1])
      : Math.min(6, Math.max(1, Number(el.getAttribute('aria-level')) || 2));
    const t = inline(el, 0);
    if (t) emit(`${'#'.repeat(level)} ${t}`, visOf(el));
  };

  /** 前 n 行 + 视口内的行（再多 n 行），按原顺序。 */
  const pick = (list: Element[], n: number): number[] => {
    const keep: number[] = [];
    for (let i = 0; i < list.length && i < n; i++) keep.push(i);
    let extra = 0;
    for (let i = n; i < list.length && extra < n; i++) {
      if (visOf(list[i] as Element)) {
        keep.push(i);
        extra++;
      } else if (extra) break;
    }
    return keep;
  };

  const table = (el: Element) => {
    flush();
    const html = el.tagName === 'TABLE';
    const owner = (r: Element) => r.closest('table, [role=table], [role=grid], [role=treegrid]');
    const rows = (
      html
        ? [...(el as HTMLTableElement).rows]
        : [...el.querySelectorAll('[role=row]')].filter((r) => owner(r) === el)
    ).filter(shown);
    if (!rows.length) {
      generic(el, 0, 'block');
      return;
    }
    const cellsOf = (r: Element): Element[] =>
      (r.tagName === 'TR'
        ? [...(r as HTMLTableRowElement).cells]
        : [
            ...r.querySelectorAll(
              '[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]',
            ),
          ].filter((x) => x.closest('[role=row]') === r)
      ).filter(shown);
    const fmt = (r: Element): string => {
      const cells = cellsOf(r).map((x) => {
        const item = c.listed.get(x);
        const t = item
          ? `${ph(item.ref)}${inline(x, descend(x, item, 0) === 0 ? 0 : 1)}`
          : inline(x, c.skip.has(x) ? 1 : 0);
        return t.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
      });
      const item = c.listed.get(r);
      if (item) cells[0] = `${ph(item.ref).trim()} ${cells[0] ?? ''}`.trim();
      return `| ${cells.join(' | ')} |`;
    };
    // 表头：thead 里的行，或全是 th / columnheader 的首行；没有表头时输出空表头（Markdown 表格需要表头）
    const first0 = rows[0] as Element;
    const firstCells = cellsOf(first0);
    const isHead =
      first0.parentElement?.tagName === 'THEAD' ||
      (firstCells.length > 0 &&
        firstCells.every((x) => x.tagName === 'TH' || x.getAttribute('role') === 'columnheader'));
    const data = isHead ? rows.slice(1) : rows;
    const cols = Math.max(1, ...rows.slice(0, 5).map((r) => cellsOf(r).length));
    if (isHead) emit(fmt(first0), visOf(first0));
    else emit(`|${'   |'.repeat(cols)}`, visOf(first0));
    emit(`|${' --- |'.repeat(cols)}`, false);
    const keep = pick(data, c.tableRows);
    let prev = -1;
    for (const i of keep) {
      if (i !== prev + 1) emit('| … |', false);
      const r = data[i] as Element;
      emit(fmt(r), visOf(r));
      prev = i;
    }
    const total = Number(el.getAttribute('aria-rowcount')) || 0;
    if (keep.length < data.length || total > rows.length) {
      if (prev < data.length - 1) emit('| … |', false);
      emit(
        total > rows.length
          ? `（表格共 ${total} 行，当前渲染 ${rows.length} 行，列出 ${keep.length} 行）`
          : `（表格共 ${data.length} 行，列出 ${keep.length} 行）`,
        false,
      );
    }
  };

  const list = (el: Element, ordered: boolean) => {
    const items = [...(obShadow(el) ?? el).children].filter(
      (x) => (x.tagName === 'LI' || x.getAttribute('role') === 'listitem') && shown(x),
    );
    if (!items.length) {
      generic(el, 0, 'block');
      return;
    }
    flush();
    const base = rest;
    const saveFirst = first;
    const keep = pick(items, c.listItems);
    let prev = -1;
    for (const i of keep) {
      if (i !== prev + 1) {
        first = base;
        emit('- …', false);
      }
      first = `${base}${ordered ? `${i + 1}.` : '-'} `;
      rest = `${base}  `;
      walk(items[i] as Element, 0);
      flush();
      prev = i;
    }
    first = base;
    rest = base;
    if (keep.length < items.length) {
      if (prev < items.length - 1) emit('- …', false);
      emit(`（列表共 ${items.length} 项，列出 ${keep.length} 项）`, false);
    }
    first = saveFirst;
  };

  const dl = (el: Element) => {
    flush();
    let line = '';
    let v = false;
    const out = () => {
      if (line) emit(line, v);
      line = '';
      v = false;
    };
    for (const x of el.querySelectorAll(
      ':scope > dt, :scope > dd, :scope > div > dt, :scope > div > dd',
    )) {
      if (!shown(x)) continue;
      const t = inline(x, c.skip.has(x) ? 1 : 0);
      if (x.tagName === 'DT') {
        out();
        line = `- ${t}：`;
        v = visOf(x);
      } else if (!line) {
        line = `- ${t}`;
        v = visOf(x);
      } else line += line.endsWith('：') ? t : `；${t}`;
    }
    out();
  };

  const pre = (el: Element) => {
    flush();
    const text = (el as HTMLElement).innerText.replace(/\s+$/, '');
    if (!text) return;
    const v = visOf(el);
    const ls = text.split('\n');
    emit('```', v);
    for (const l of ls.slice(0, 50)) emit(l, v);
    if (ls.length > 50) emit(`…（共 ${ls.length} 行）`, v);
    emit('```', v);
  };

  const children = (el: Element, mode: number) => {
    for (const n of (obShadow(el) ?? el).childNodes) walk(n, mode);
  };

  /** 普通元素：块级元素前后换行，并以它的位置判定所含文字是否在视口内。 */
  const generic = (el: Element, mode: number, d: string) => {
    if (BLOCK_DISPLAY.has(d)) {
      flush();
      const save = blockVis;
      blockVis = visOf(el);
      children(el, mode);
      flush();
      blockVis = save;
    } else if (d.startsWith('inline-')) {
      add(' ');
      children(el, mode);
      add(' ');
    } else children(el, mode);
  };

  const walk = (node: Node, mode: number): void => {
    if (node.nodeType === 3) {
      if (mode === 0) add((node as Text).data);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === 'SVG') {
      const label = obNorm(el.getAttribute('aria-label'));
      if (label && mode === 0) add(` ![${label}] `);
      return;
    }
    if (SKIP.has(tag)) return;
    if (tag === 'SLOT') {
      const nodes = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      for (const n of nodes.length ? nodes : [...el.childNodes]) walk(n, mode);
      return;
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      const k = c.iframes.get(el);
      if (k !== undefined) {
        flush();
        lines.push({ t: '', v: 0, f: k });
      }
      return;
    }
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (!shown(el)) {
      if (getComputedStyle(el).display === 'contents') children(el, mode);
      return;
    }
    const d = display(el, tag);
    const item = c.listed.get(el);
    if (item) {
      // 可操作元素：只留编号占位；卡片、滚动区域这类内容本身是信息的，再输出内容
      const block = BLOCK_DISPLAY.has(d);
      const save = blockVis;
      if (block) {
        flush();
        blockVis = visOf(el);
      }
      add(ph(item.ref));
      const m = descend(el, item, mode);
      if (m >= 0) children(el, m);
      if (block) {
        flush();
        blockVis = save;
      }
      return;
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    let m = mode;
    if (c.skip.has(el)) m = 1;
    const role = el.getAttribute('role');
    if (m === 0) {
      if (tag === 'TABLE' || role === 'table' || role === 'grid' || role === 'treegrid') {
        table(el);
        return;
      }
      if (tag === 'UL' || tag === 'OL' || tag === 'MENU' || role === 'list') {
        list(el, tag === 'OL');
        return;
      }
      if (/^H[1-6]$/.test(tag) || role === 'heading') {
        heading(el, tag);
        return;
      }
      if (tag === 'DL') {
        dl(el);
        return;
      }
      if (tag === 'PRE') {
        pre(el);
        return;
      }
      if (tag === 'IMG' || role === 'img') {
        const alt = obNorm(el.getAttribute('alt') ?? el.getAttribute('aria-label'));
        if (alt) add(` ![${alt}] `);
        return;
      }
      if (tag === 'HR') {
        flush();
        emit('---', false);
        return;
      }
      if (role === 'dialog' || role === 'alertdialog' || tag === 'DIALOG') {
        flush();
        const save = blockVis;
        blockVis = visOf(el);
        const label = obNorm(el.getAttribute('aria-label'));
        emit(`**对话框${label ? `：${label}` : ''}**`, blockVis);
        children(el, 0);
        flush();
        blockVis = save;
        return;
      }
    }
    if (tag === 'BR') {
      flush();
      return;
    }
    generic(el, m, d);
  };

  walk(document.body ?? document.documentElement, 0);
  flush();
  return lines;
}
