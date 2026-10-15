/**
 * 页面内助手函数库（在浏览器里执行）。约定见 bundle.ts：全部是自包含的函数声明，只互相调用。
 * 用 `bundle(main, DOM_LIB)` 把它们和入口函数一起送进页面。
 *
 * 封闭 Shadow DOM：页面脚本拿不到 closed shadowRoot；Node 侧用 CDP 找到后，把它挂在宿主元素的
 * 不可枚举属性 `__obactClosedRoot` 上（见 mark.ts），这里的遍历统一处理开放和封闭两种。
 */

/** 折叠空白并去掉首尾空白。 */
export function obNorm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** 元素的 Shadow Root：开放的直接取，封闭的取 Node 侧挂上的引用。 */
export function obShadow(el: Element): ShadowRoot | null {
  return (
    el.shadowRoot ?? (el as unknown as { __obactClosedRoot?: ShadowRoot }).__obactClosedRoot ?? null
  );
}

/** root 下（含所有 Shadow DOM）匹配 selector 的元素，按文档顺序，Shadow 内元素紧跟在宿主之后。 */
export function obDeepAll(root: Document | ShadowRoot | Element, selector: string): Element[] {
  const out: Element[] = [];
  const visit = (r: Document | ShadowRoot | Element) => {
    for (const el of r.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      const sr = obShadow(el);
      if (sr) visit(sr);
    }
  };
  visit(root);
  return out;
}

/** 当前焦点元素（穿透 Shadow DOM）。 */
export function obActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a) {
    const sr = obShadow(a);
    if (!sr?.activeElement) break;
    a = sr.activeElement;
  }
  return a;
}

/** 角色：显式 role 的第一个值，否则按标签推断（与 Chrome 可访问性树的常用角色对齐）。 */
export function obRole(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
    case 'summary':
      return 'button';
    case 'select': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'textarea':
      return 'textbox';
    case 'option':
      return 'option';
    case 'img':
      return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'nav':
      return 'navigation';
    case 'form':
      return 'form';
    case 'dialog':
      return 'dialog';
    case 'progress':
      return 'progressbar';
    case 'iframe':
      return 'iframe';
    case 'fieldset':
    case 'details':
      return 'group';
    case 'main':
      return 'main';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'hidden') return 'none';
      if (['button', 'submit', 'reset', 'image', 'file', 'color'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
  }
  if ((el as HTMLElement).isContentEditable && el.hasAttribute('contenteditable')) return 'textbox';
  return 'generic';
}

/** 可访问名称（accname 的常用子集）：aria-labelledby、aria-label、label、alt、按内容、title、placeholder。 */
export function obName(el: Element): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => (root.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? '')
      .join(' ');
    if (obNorm(text)) return obNorm(text);
  }
  const aria = obNorm(el.getAttribute('aria-label'));
  if (aria) return aria;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) {
      return (
        obNorm(input.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')
      );
    }
    if (type === 'image') return obNorm(input.alt) || obNorm(input.title);
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const text = obNorm([...labels].map((l) => l.textContent ?? '').join(' '));
      if (text) return text;
    }
    return obNorm(el.getAttribute('title')) || obNorm(el.getAttribute('placeholder'));
  }
  if (tag === 'img') return obNorm(el.getAttribute('alt')) || obNorm(el.getAttribute('title'));
  const fromContent = [
    'button',
    'link',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'checkbox',
    'radio',
    'switch',
    'heading',
    'cell',
    'columnheader',
    'rowheader',
    'treeitem',
    'tooltip',
  ];
  if (fromContent.includes(obRole(el))) {
    const text = obNorm((el as HTMLElement).innerText || el.textContent);
    if (text) return text;
  }
  return obNorm(el.getAttribute('title'));
}

/** 可交互元素的判定（与 BrowserGym 的可交互角色对齐，另含原生控件、tabindex、contenteditable、onclick）。 */
export function obIsInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return (el.getAttribute('type') ?? '').toLowerCase() !== 'hidden';
  if (['button', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
  if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
  const role = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (
    role &&
    [
      'button',
      'link',
      'checkbox',
      'radio',
      'textbox',
      'searchbox',
      'combobox',
      'listbox',
      'option',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'switch',
      'slider',
      'spinbutton',
      'treeitem',
      'gridcell',
    ].includes(role)
  ) {
    return true;
  }
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '-1') return true;
  if ((el as HTMLElement).isContentEditable && el.hasAttribute('contenteditable')) return true;
  return el.hasAttribute('onclick');
}

/** 元素在本 frame 视口内的可见比例（0~1）；不可见（display/visibility/opacity/零尺寸）为 0。 */
export function obVisibleRatio(el: Element): number {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 0;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return 0;
  const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  return Math.round(((w * h) / (r.width * r.height)) * 1000) / 1000;
}

/** 关键状态（契约 observe.json#/$defs/ElementStates），只返回有意义的字段。 */
export function obStates(el: Element): Record<string, boolean | string> {
  const s: Record<string, boolean | string> = {};
  const aria = (n: string) => el.getAttribute(`aria-${n}`);
  if (el.matches(':disabled') || aria('disabled') === 'true') s.disabled = true;
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  if (tag === 'input' && (input.type === 'checkbox' || input.type === 'radio')) {
    s.checked = input.indeterminate ? 'mixed' : input.checked;
  } else if (aria('checked') !== null) {
    s.checked = aria('checked') === 'mixed' ? 'mixed' : aria('checked') === 'true';
  }
  if (tag === 'option') s.selected = (el as HTMLOptionElement).selected;
  else if (aria('selected') !== null) s.selected = aria('selected') === 'true';
  if (aria('expanded') !== null) s.expanded = aria('expanded') === 'true';
  else if (tag === 'details') s.expanded = (el as HTMLDetailsElement).open;
  if (obActiveElement() === el) s.focused = true;
  if (el.matches(':required') || aria('required') === 'true') s.required = true;
  if (el.matches(':read-only') && (tag === 'input' || tag === 'textarea')) s.readonly = true;
  if ((el as HTMLElement).isContentEditable) s.editable = true;
  return s;
}

/** 给本文档内尚未编号（或编号属于其他会话、被克隆带过来）的可交互元素编号。 */
export function obMark(
  attr: string,
  key: string,
  start: number,
): { next: number; added: number[]; refs: number[] } {
  let next = start;
  const added: number[] = [];
  const refs: number[] = [];
  for (const el of obDeepAll(document, '*')) {
    if (!obIsInteractive(el)) continue;
    const current = Number(el.getAttribute(attr));
    const own = (el as unknown as Record<string, unknown>)[key];
    if (current && own === current) {
      refs.push(current);
      continue;
    }
    const ref = next++;
    el.setAttribute(attr, String(ref));
    Object.defineProperty(el, key, { value: ref, configurable: true, writable: true });
    added.push(ref);
    refs.push(ref);
  }
  return { next, added, refs };
}

/** 按编号找元素：属性和本会话写入的不可枚举标记都要对上，否则视为失效（克隆节点、已删除）。 */
export function obFindRef(ref: number, attr: string, key: string): Element | null {
  for (const el of obDeepAll(document, `[${attr}="${ref}"]`)) {
    if ((el as unknown as Record<string, unknown>)[key] === ref && el.isConnected) return el;
  }
  return null;
}

/** 多个候选时，只剩一个可见的就取它（响应式页面常见的隐藏副本）。 */
export function obPickUnique(list: Element[]): Element | null {
  if (list.length === 1) return list[0] ?? null;
  const visible = list.filter((e) => obVisibleRatio(e) > 0);
  return visible.length === 1 ? (visible[0] ?? null) : null;
}

/**
 * 解析定位器（FR-07）：先 within 容器，再按 CSS，CSS 不唯一或找不到时按 角色+名称。
 * 返回命中的元素和方式；失败时给出原因与各方式的命中数。
 */
export function obResolve(loc: {
  css?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  within?: string;
}): {
  el: Element | null;
  via: 'css' | 'role' | null;
  reason: 'not_found' | 'not_unique' | null;
  counts: { within?: number; css?: number; role?: number };
} {
  const counts: { within?: number; css?: number; role?: number } = {};
  let scope: Document | Element = document;
  if (loc.within) {
    const containers = obDeepAll(document, loc.within);
    counts.within = containers.length;
    const c = obPickUnique(containers);
    if (!c) {
      return {
        el: null,
        via: null,
        reason: containers.length ? 'not_unique' : 'not_found',
        counts,
      };
    }
    scope = c;
  }
  let ambiguous = false;
  if (loc.css) {
    const list = obDeepAll(scope, loc.css);
    counts.css = list.length;
    const el = obPickUnique(list);
    if (el) return { el, via: 'css', reason: null, counts };
    if (list.length > 1) ambiguous = true;
  }
  if (loc.role) {
    const want = obNorm(loc.name);
    const exact = loc.exact !== false;
    const list = obDeepAll(scope, '*').filter((e) => {
      if (obRole(e) !== loc.role) return false;
      if (loc.name === undefined) return true;
      const name = obName(e);
      return exact ? name === want : name.toLowerCase().includes(want.toLowerCase());
    });
    counts.role = list.length;
    const el = obPickUnique(list);
    if (el) return { el, via: 'role', reason: null, counts };
    if (list.length > 1) ambiguous = true;
  }
  return { el: null, via: null, reason: ambiguous ? 'not_unique' : 'not_found', counts };
}

/** 全部助手，供 bundle 使用。新增助手时加到这里。 */
export const DOM_LIB = [
  obNorm,
  obShadow,
  obDeepAll,
  obActiveElement,
  obRole,
  obName,
  obIsInteractive,
  obVisibleRatio,
  obStates,
  obMark,
  obFindRef,
  obPickUnique,
  obResolve,
];
