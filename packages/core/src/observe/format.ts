/**
 * observe 的 Node 侧排版：可操作功能（snapshot_text 每行一个元素及其可用操作）与纯网页信息（text_md），
 * 以及字符预算截断。纯函数，便于单独测试。
 */
import type { ObservedElement } from '@obact/schemas';
import type { TextLine } from './page.ts';
import { obsKeepLine } from './text.ts';

/** 一个元素：契约字段 + 只用于文本快照的补充信息。 */
export type Item = {
  el: ObservedElement;
  kind?: string;
  placeholder?: string;
  scroll?: [number, number];
  /** 没有名称的图标类元素的提示词。 */
  hint?: string;
};

/**
 * 文本快照里元素名称、值、链接的最大长度；选项最多显示的个数。
 * 名称上限同时是纯网页信息里“文字已作为名称”的上限（observe 的 longText）：名称在快照里被截断时，
 * 完整文字要留在 text_md，否则两个文本视图都看不到后半段。
 */
export const NAME_MAX = 120;
const VALUE_MAX = 60;
const HREF_MAX = 80;
const OPTIONS_SHOWN = 30;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * 文本快照里显示的角色：generic（以及 presentation/none）按推断类型显示为 scrollable 或 clickable，
 * 让纯网页信息和自绘控件一眼区分；元素的 role 字段仍是原始角色。
 */
export function displayRole(item: Item): string {
  const { role } = item.el;
  if (role !== 'generic' && role !== 'presentation' && role !== 'none') return role;
  return item.kind === 'scroll' ? 'scrollable' : 'clickable';
}

function shortHref(href: string, base: string): string {
  try {
    const u = new URL(href);
    const b = new URL(base);
    const s = u.origin === b.origin ? `${u.pathname}${u.search}${u.hash}` : href;
    return cut(s, HREF_MAX);
  } catch {
    return cut(href, HREF_MAX);
  }
}

/**
 * 一行文本快照，如：
 * [13] textbox "订单号" value="" type=text → click,fill,type_text,press_key
 * [14] combobox "状态" value="全部" options=全部|待审核|已审核 → fill
 * [15] button "审核" within=tr[data-id='88231'] → click
 */
export function snapshotLine(item: Item, pageUrl: string): string {
  const e = item.el;
  const parts = [`[${e.ref}]`, displayRole(item), quote(cut(e.name, NAME_MAX))];
  if (item.hint) parts.push(`hint=${quote(item.hint)}`);
  if (item.kind) parts.push(`kind=${item.kind}`);
  if (e.value !== undefined) parts.push(`value=${quote(cut(e.value, VALUE_MAX))}`);
  if (item.placeholder) parts.push(`placeholder=${quote(cut(item.placeholder, 40))}`);
  if (e.input_type) parts.push(`type=${e.input_type}`);
  if (e.options) {
    const shown = e.options.slice(0, OPTIONS_SHOWN).map((o) => o.label.replace(/\|/g, '/'));
    const more = e.options.length - shown.length + (e.options_omitted ?? 0);
    parts.push(`options=${shown.join('|')}${more > 0 ? `|…+${more}` : ''}`);
  }
  if (e.href) parts.push(`href=${shortHref(e.href, pageUrl)}`);
  const st = e.states ?? {};
  if (st.disabled) parts.push('disabled');
  if (st.checked === 'mixed') parts.push('checked=mixed');
  else if (st.checked === true) parts.push('checked');
  else if (st.checked === false) parts.push('unchecked');
  if (st.selected) parts.push('selected');
  if (st.expanded === true) parts.push('expanded');
  else if (st.expanded === false) parts.push('collapsed');
  if (st.focused) parts.push('focused');
  if (st.required) parts.push('required');
  if (st.readonly) parts.push('readonly');
  if (item.scroll) parts.push(`scroll=${item.scroll[0]}/${item.scroll[1]}`);
  if (e.within) parts.push(`within=${e.within}`);
  if (e.frame) parts.push(`frame=${e.frame.join(' >> ')}`);
  // 位置提示：不在视口内（需滚动）、未渲染（如隐藏的文件框）、被遮挡
  const [, , w, h] = e.bbox as number[];
  if (e.visible_ratio === 0) parts.push((w ?? 0) > 0 && (h ?? 0) > 0 ? 'offscreen' : 'hidden');
  else if (!e.clickable && !st.disabled) parts.push('covered');
  // 页面来源的字符串（textarea 的值、文件名、iframe 的 title）里的换行显示成 \n：不能把一行拆开，冒充别的元素行
  const line = `${parts.join(' ')} → ${e.actions.join(',')}`;
  return line.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, '\\n');
}

/** 把占位 \uE000编号\uE001 换成 [编号]；未列出（被预算截掉）的元素换成它的名称。 */
export function renderLine(t: string, kept: Set<number>, names: Map<number, string>): string {
  return t.replace(/\uE000(\d+)\uE001/g, (_m, d: string) => {
    const ref = Number(d);
    return kept.has(ref) ? `[${ref}]` : cut(names.get(ref) ?? '', 40);
  });
}

export type Budgeted = {
  /** 保留的元素（文档顺序）。 */
  items: Item[];
  snapshot: string;
  text: string;
  truncated: boolean;
};

/** 按优先级挑选，总长不超过 cap；返回选中的下标（升序）。cost(i) 是第 i 项占用的字符数。 */
function pickWithin(order: number[], cost: (i: number) => number, cap: number): number[] {
  const chosen: number[] = [];
  let used = 0;
  for (const i of order) {
    const c = cost(i);
    if (used + c > cap) continue;
    used += c;
    chosen.push(i);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * 字符预算（max_chars）：snapshot_text 与 text_md 合计超出时截断。
 * - 两者都放得下就全保留；否则可操作功能至少分到 60%（短的一方全保留，剩余给另一方）。
 * - 元素优先保留视口内可见的（visible_ratio > 0），其余按文档顺序；文本优先保留视口内的行。
 * - elements 与 snapshot_text 始终是同一批元素；text_md 里被截掉的元素占位换成名称。
 */
export function applyBudget(
  items: Item[],
  lines: TextLine[],
  maxChars: number,
  pageUrl: string,
): Budgeted {
  // 纯网页信息里只含可操作元素占位、没有任何信息文字的行（如一排按钮）不放进 text_md：
  // 这些元素已在 snapshot_text 里；占位只在与信息混排时（表格行、列表项）保留，用来对应信息与操作
  lines = lines.filter(obsKeepLine);
  const snapLines = items.map((it) => snapshotLine(it, pageUrl));
  const names = new Map(items.map((it) => [it.el.ref, it.el.name]));
  const allRefs = new Set(items.map((it) => it.el.ref));
  const textAll = lines.map((l) => renderLine(l.t, allRefs, names));
  const sLen = snapLines.reduce((n, l) => n + l.length + 1, 0);
  const tLen = textAll.reduce((n, l) => n + l.length + 1, 0);
  if (sLen + tLen <= maxChars) {
    return { items, snapshot: snapLines.join('\n'), text: textAll.join('\n'), truncated: false };
  }

  // 截断说明行的预留长度
  const NOTE = 40;
  const budget = maxChars - 2 * NOTE;
  const sCap = Math.min(sLen, Math.max(Math.floor(budget * 0.6), budget - tLen));
  let keepIdx: number[];
  if (sLen <= sCap) keepIdx = items.map((_x, i) => i);
  else {
    const visible = items.flatMap((it, i) => (it.el.visible_ratio > 0 ? [i] : []));
    const rest = items.flatMap((it, i) => (it.el.visible_ratio > 0 ? [] : [i]));
    keepIdx = pickWithin([...visible, ...rest], (i) => (snapLines[i] as string).length + 1, sCap);
  }
  const kept = keepIdx.map((i) => items[i] as Item);
  const keptRefs = new Set(kept.map((it) => it.el.ref));
  const snapKept = keepIdx.map((i) => snapLines[i] as string);
  const dropped = items.length - kept.length;
  if (dropped > 0) snapKept.push(`…（另有 ${dropped} 个元素未列出：超出字符预算）`);
  const snapshot = snapKept.join('\n');

  const text = lines.map((l) => renderLine(l.t, keptRefs, names));
  const tCap = maxChars - snapshot.length - NOTE;
  const total = text.reduce((n, l) => n + l.length + 1, 0);
  let textOut: string;
  let textCut = false;
  if (total <= maxChars - snapshot.length) textOut = text.join('\n');
  else {
    textCut = true;
    const visible = lines.flatMap((l, i) => (l.v ? [i] : []));
    const rest = lines.flatMap((l, i) => (l.v ? [] : [i]));
    // 每行另留 2 个字符给可能插入的省略行
    const chosen = pickWithin([...visible, ...rest], (i) => (text[i] as string).length + 3, tCap);
    const out: string[] = [];
    let prev = -1;
    for (const i of chosen) {
      if (i !== prev + 1) out.push('…');
      out.push(text[i] as string);
      prev = i;
    }
    if (prev < text.length - 1) out.push('…（纯网页信息已截断：超出字符预算）');
    textOut = out.join('\n');
  }
  return { items: kept, snapshot, text: textOut, truncated: dropped > 0 || textCut };
}
