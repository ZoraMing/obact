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
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  // ARIA 冲突规则：可聚焦或可交互的元素忽略 presentation/none（如 jQuery UI 给 <a href> 设 role=presentation）
  const focusable =
    ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) ||
    ['button', 'input', 'select', 'textarea', 'summary'].includes(tag) ||
    (el.getAttribute('tabindex') ?? '-1') !== '-1';
  if (explicit && !((explicit === 'presentation' || explicit === 'none') && focusable))
    return explicit;
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

/** label 的文字：不含其中表单控件（下拉框选项、文本框内容等）的文字。 */
export function obLabelText(label: Element): string {
  let text = '';
  const walk = (n: Node) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) text += c.textContent ?? '';
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = (c as Element).tagName;
        if (['SELECT', 'TEXTAREA', 'INPUT', 'DATALIST', 'BUTTON', 'SCRIPT', 'STYLE'].includes(tag))
          continue;
        walk(c);
      }
    }
  };
  walk(label);
  return obNorm(text);
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
      const text = obNorm([...labels].map((l) => obLabelText(l)).join(' '));
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
  const role = obRole(el);
  // 可点击的行、列表项、单元格等（点击监听、onclick、pointer 推断）也按内容取名，后台系统里很常见
  if (fromContent.includes(role) || obIsClickableGeneric(el)) {
    const text = obNorm((el as HTMLElement).innerText || el.textContent);
    if (text) return text;
    // 只含图标或图片的链接、按钮：取后代的 alt / aria-label / title
    const alt = [...el.querySelectorAll('img[alt], [aria-label], [title]')]
      .map((c) => c.getAttribute('alt') || c.getAttribute('aria-label') || c.getAttribute('title'))
      .filter(Boolean)
      .join(' ');
    if (obNorm(alt)) return obNorm(alt);
  }
  return obNorm(el.getAttribute('title'));
}

/**
 * 没有可访问名称时的提示（只作参考，不用于定位）：图标文件名（img src、CSS content / background-image）、
 * svg <use> 引用的图标 id、稳定且有意义的类名。如 delete.png → "delete"、class="star" → "star"。
 */
export function obHint(el: Element): string {
  const GENERIC =
    /^(icon|icons|btn|button|fa|fas|far|fab|material-icons|iconfont|svg|img|image|active|clicked|selected|disabled|left|right|small|large|sm|lg|md)$/i;
  const fileWord = (url: string) => {
    const m = /([A-Za-z][\w-]*?)(?:[-_.]?\d+)?\.(png|svg|gif|jpe?g|webp)/i.exec(url);
    return m ? (m[1] as string) : '';
  };
  const words: string[] = [];
  const push = (w: string) => {
    const t = w
      .replace(/^(icon|ico|fa|el-icon|ant-icon|mdi)[-_]/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (t && !GENERIC.test(t) && !words.includes(t)) words.push(t);
  };
  const nodes = [el, ...el.querySelectorAll('*')].slice(0, 6);
  for (const n of nodes) {
    if (n.tagName === 'IMG') push(fileWord(n.getAttribute('src') ?? ''));
    const use =
      n.tagName.toLowerCase() === 'use'
        ? n.getAttribute('href') || n.getAttribute('xlink:href')
        : null;
    if (use) push(use.replace(/^.*#/, ''));
    const st = getComputedStyle(n);
    for (const v of [st.content, st.backgroundImage]) if (v?.includes('url(')) push(fileWord(v));
  }
  for (const n of nodes) for (const c of n.classList) if (obIsStableToken(c)) push(c);
  return words.slice(0, 3).join(' ').slice(0, 40);
}

/** 可交互元素的判定（与 BrowserGym 的可交互角色对齐，另含原生控件、tabindex、contenteditable、onclick）。 */
export function obIsInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return (el.getAttribute('type') ?? '').toLowerCase() !== 'hidden';
  // datalist 里的 option 不渲染、不可单独操作，已作为输入框的 options 返回
  if (tag === 'option') return el.parentElement?.tagName !== 'DATALIST';
  if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true;
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
  if (el.getAttribute('draggable') === 'true') return true;
  // Node 侧用 DOMSnapshot 的 isClickable 找到绑定了点击类监听的元素后打上的不可枚举标记（见 mark.ts）
  if ((el as unknown as { __obactClickable?: boolean }).__obactClickable) return true;
  return el.hasAttribute('onclick');
}

/**
 * 推断的可操作元素（需要计算样式，比 obIsInteractive 贵）：
 * - 自绘控件：cursor 为 pointer 的最外层元素，且不在已有可交互元素之内（常见于事件委托到根节点的框架，如 React）；
 * - 滚动容器：内容超出且 overflow 为 auto/scroll 的区域（虚拟滚动表格等），可执行 scroll。
 * 返回推断类型，不是则返回 null。
 */
export function obInferredKind(el: Element): 'pointer' | 'scroll' | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'label' || tag === 'svg' || tag === 'path') {
    return null;
  }
  const he = el as HTMLElement;
  if (
    (he.scrollHeight > he.clientHeight + 4 || he.scrollWidth > he.clientWidth + 4) &&
    he.clientHeight >= 40 &&
    he.clientWidth >= 40
  ) {
    const st = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(st.overflowY + st.overflowX)) return 'scroll';
  }
  const st = getComputedStyle(el);
  if (st.cursor !== 'pointer') return null;
  const parent = el.parentElement;
  if (parent && getComputedStyle(parent).cursor === 'pointer') return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  let a: Element | null = parent;
  while (a) {
    if (obIsInteractive(a)) return null;
    a = a.parentElement;
  }
  return 'pointer';
}

/** 靠脚本或样式才可操作的元素（onclick、tabindex、点击监听、pointer 推断、可拖拽），名称取自内容。 */
export function obIsClickableGeneric(el: Element): boolean {
  const tabindex = el.getAttribute('tabindex');
  return (
    el.hasAttribute('onclick') ||
    (tabindex !== null && tabindex !== '-1') ||
    Boolean((el as unknown as { __obactClickable?: boolean }).__obactClickable) ||
    el.getAttribute('data-obact-kind') === 'pointer' ||
    el.getAttribute('draggable') === 'true'
  );
}

/**
 * 可用操作（与 action.json 的 op 同名）：按角色、控件类型、只读、可拖拽、可滚动判定。
 * hover 只给明确有悬停效果的元素（aria-haspopup、title 提示、菜单项）。
 */
export function obActions(el: Element): string[] {
  const out: string[] = [];
  const add = (...ops: string[]) => {
    for (const op of ops) if (!out.includes(op)) out.push(op);
  };
  const tag = el.tagName.toLowerCase();
  const role = obRole(el);
  const kind = el.getAttribute('data-obact-kind');
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  const readonly = el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true';
  if (tag === 'input' && type === 'file') add('upload_file');
  else if (tag === 'input' && type === 'range') add('fill', 'drag', 'press_key');
  else if (tag === 'input' && type === 'color') add('click', 'fill');
  else if (tag === 'select') add('fill');
  else if (
    ['textbox', 'searchbox', 'spinbutton'].includes(role) ||
    (role === 'combobox' && tag === 'input')
  ) {
    if (readonly) add('click');
    else add('click', 'fill', 'type_text', 'press_key');
  } else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
    add('click');
    if (tag === 'input') add('fill');
  } else if (role === 'slider') add('drag', 'press_key', 'click');
  else if (role === 'combobox' || role === 'listbox') add('click', 'press_key');
  else if (kind === 'scroll') add('scroll');
  else add('click');
  if (el.getAttribute('draggable') === 'true') add('drag');
  if (el.hasAttribute('aria-haspopup') || el.hasAttribute('title') || role === 'menuitem')
    add('hover');
  if (kind !== 'scroll') {
    const he = el as HTMLElement;
    if (he.scrollHeight > he.clientHeight + 4 && he.clientHeight >= 40) {
      const st = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(st.overflowY)) add('scroll');
    }
  }
  return out;
}

/** 下拉框、列表框、带 datalist 的输入框的选项（最多 limit 个），以及未列出的数量。 */
export function obOptions(
  el: Element,
  limit: number,
): {
  options: { label: string; value: string; selected?: boolean; disabled?: boolean }[];
  omitted: number;
} | null {
  let list: HTMLOptionElement[] = [];
  if (el.tagName === 'SELECT') list = [...(el as HTMLSelectElement).options];
  else if (el.tagName === 'INPUT' && (el as HTMLInputElement).list) {
    list = [...((el as HTMLInputElement).list as HTMLDataListElement).options];
  } else return null;
  const options = list.slice(0, limit).map((o) => {
    const item: { label: string; value: string; selected?: boolean; disabled?: boolean } = {
      label: obNorm(o.label || o.text),
      value: o.value,
    };
    if (o.selected && el.tagName === 'SELECT') item.selected = true;
    if (o.disabled) item.disabled = true;
    return item;
  });
  return { options, omitted: Math.max(0, list.length - limit) };
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
    if (!obIsInteractive(el)) {
      const kind = obInferredKind(el);
      if (!kind) continue;
      if (el.getAttribute('data-obact-kind') !== kind) el.setAttribute('data-obact-kind', kind);
    }
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
 * 解析定位器（FR-07）：先 within 容器，再分别按 CSS 和 角色+名称 解析。
 * CSS 唯一时用 CSS；CSS 找不到或不唯一时用 角色+名称；两类都唯一却指向不同元素时报 conflict。
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
  reason: 'not_found' | 'not_unique' | 'conflict' | null;
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
  let byCss: Element | null = null;
  if (loc.css) {
    const list = obDeepAll(scope, loc.css);
    counts.css = list.length;
    byCss = obPickUnique(list);
    if (!byCss && list.length > 1) ambiguous = true;
  }
  let byRole: Element | null = null;
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
    byRole = obPickUnique(list);
    if (!byRole && list.length > 1) ambiguous = true;
  }
  // 两类都唯一却指向不同元素：页面多半改版了，宁可失败转人工也不能误点（BW-6、FR-20）
  if (byCss && byRole && byCss !== byRole) {
    return { el: null, via: null, reason: 'conflict', counts };
  }
  if (byCss) return { el: byCss, via: 'css', reason: null, counts };
  if (byRole) return { el: byRole, via: 'role', reason: null, counts };
  return { el: null, via: null, reason: ambiguous ? 'not_unique' : 'not_found', counts };
}

/**
 * id、类名、属性值是否稳定，可用于定位（FR-07）：排除长数字串、CSS-in-JS 与 CSS Modules 生成的哈希类名、
 * React useId 之类带冒号的值、混有数字的随机串。
 */
export function obIsStableToken(t: string | null | undefined): boolean {
  if (!t || t.length > 48) return false;
  if (/\d{3,}/.test(t)) return false;
  if (/:/.test(t)) return false;
  if (/^(css|sc|jsx|emotion|styled|svelte)-/i.test(t)) return false;
  if (/__[A-Za-z0-9-]{4,}$/.test(t)) return false;
  if (/[_-][A-Za-z0-9]{5,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t.slice(-5))) return false;
  if (/^[A-Za-z0-9]{8,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) return false;
  return true;
}

/** 文本是否适合放进定位器：含数字或日期的文本会变（FR-07）。 */
export function obIsStableText(t: string): boolean {
  return t.length > 0 && t.length <= 80 && !/\d/.test(t);
}

/**
 * 元素所在的行或容器（业务主键）选择器，如 tr[data-id='88231']，用于同名元素消歧（FR-07）。
 * 从近到远找带业务主键属性、且在本文档内唯一的祖先；找不到返回 null。
 */
export function obWithin(el: Element): string | null {
  const KEYS = ['data-id', 'data-key', 'data-row-key', 'data-rowid', 'data-testid'];
  let cur: Element | null = el.parentElement;
  while (cur && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    for (const k of KEYS) {
      const v = cur.getAttribute(k);
      if (v && /^[\w.-]{1,64}$/.test(v)) {
        const sel = `${tag}[${k}='${v}']`;
        if (obDeepAll(document, sel).length === 1) return sel;
      }
    }
    const id = cur.id;
    if (
      id &&
      obIsStableToken(id) &&
      /^[A-Za-z][\w-]*$/.test(id) &&
      ['tr', 'li', 'article', 'section', 'form', 'fieldset', 'dialog'].includes(tag)
    ) {
      const sel = `${tag}#${id}`;
      if (obDeepAll(document, sel).length === 1) return sel;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** 全部助手，供 bundle 使用。新增助手时加到这里。 */
export const DOM_LIB = [
  obNorm,
  obShadow,
  obDeepAll,
  obActiveElement,
  obRole,
  obLabelText,
  obName,
  obHint,
  obIsInteractive,
  obInferredKind,
  obIsClickableGeneric,
  obActions,
  obOptions,
  obVisibleRatio,
  obStates,
  obMark,
  obFindRef,
  obPickUnique,
  obResolve,
  obIsStableToken,
  obIsStableText,
  obWithin,
];
