/**
 * observe 的页面内助手（在浏览器里执行，约定见 page/bundle.ts）：每个 frame 一次调用，批量算出
 * 可操作功能（元素的角色、名称、可用操作、几何与可点击性）和纯网页信息（见 text.ts）。
 *
 * 坐标都是本 frame 的视口坐标；Node 侧再加上 iframe 内容区偏移换算到顶层视口。
 * 不走可访问性树（M0 预研：1 万个元素全量取树约 3 秒），全部用 DOM 与布局信息在页面内算。
 */
import {
  obActions,
  obDeepAll,
  obHint,
  obIsSensitive,
  obIsStableToken,
  obLabelsOf,
  obName,
  obNorm,
  obOptions,
  obRole,
  obShadow,
  obStates,
} from '../page/dom.ts';
import { obsKeepLine, obsText } from './text.ts';

/** [x, y, width, height]；宽或高为 0 表示空区域。 */
export type Rect = [number, number, number, number];

export type RawOption = { label: string; value: string; selected?: boolean; disabled?: boolean };

/** 页面内算出的一个元素（几何为本 frame 坐标）。 */
export type RawElement = {
  ref: number;
  role: string;
  name: string;
  actions: string[];
  value?: string;
  inputType?: string;
  href?: string;
  options?: RawOption[];
  omitted?: number;
  states?: Record<string, boolean | string>;
  rect: Rect;
  ratio: number;
  clickable: boolean;
  /** 命中测试用的点（可见部分的中心）；iframe 内元素还要在各级父文档里复核。 */
  pt?: [number, number];
  within?: string;
  /** obMark 推断的类型：pointer（自绘控件）/ scroll（滚动容器）。 */
  kind?: string;
  placeholder?: string;
  /** 可滚动元素的 [当前 scrollTop, 最大 scrollTop]。 */
  scroll?: [number, number];
  /** 几何取自可见的 label（视觉上隐藏的原生复选框、单选框、文件框）。 */
  proxy?: boolean;
  /** 没有可访问名称的图标类元素的提示词（obHint）。 */
  hint?: string;
  /** 命中测试落在它上面，但它（或祖先）opacity:0，act 判“不可见”操作不了：clickable 因此为 false。 */
  transparent?: boolean;
};

/**
 * 纯网页信息的一行：t 文本（可操作元素以 \uE000编号\uE001 占位），v 是否在视口内，f 子 frame 占位，
 * tb 表格的表头与数据行（只剩编号占位时也保留：列头与行结构不能丢）。
 */
export type TextLine = { t: string; v: number; f?: number; tb?: 1 };

export type CollectOptions = {
  attr: string;
  key: string;
  /** markPage 给出的本 frame 当前有效编号。 */
  refs: number[];
  /** 本 frame 在顶层视口中的可见区域（本 frame 坐标）。 */
  clip: Rect;
  optionLimit: number;
  nameMax: number;
  valueMax: number;
  hrefMax: number;
  tableRows: number;
  listItems: number;
  longText: number;
};

export type FrameCollect = {
  elements: RawElement[];
  /** slots[k]：文档中第 k 个 iframe 之前的元素个数，用于把子 frame 的元素插回原位。 */
  slots: number[];
  lines: TextLine[];
  /** 本 frame 内全部敏感字段（obIsSensitive）的编号，不论是否列入 elements；axtree 视图据此遮蔽它们的值。 */
  sensitive: number[];
  /** 可见 canvas 在视口内的面积（CSS 像素²）。 */
  canvasArea: number;
  viewport: { width: number; height: number; scale: number };
};

export type OwnerInfo = {
  rendered: boolean;
  /** iframe 内容区（子 frame 视口）在父 frame 中的位置（父 frame 坐标，含 iframe 自身受到的 CSS 缩放）。 */
  box: Rect;
  /** 子 frame 的 1 个 CSS 像素在父 frame 中占多少（iframe 或其祖先有 CSS scale 时不是 1）。 */
  scale: [number, number];
  /** iframe 受到的祖先 overflow 裁剪（父 frame 坐标），null 为不裁剪。 */
  clip: Rect | null;
  selector: string;
  index: number;
};

/** 两个区域的交集；b 为 null 表示不裁剪。 */
export function obsIntersect(a: Rect, b: Rect | null): Rect {
  if (!b) return a;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x, y, Math.max(0, right - x), Math.max(0, bottom - y)];
}

/** 渲染树上的子元素：Shadow Root 的子元素（宿主）、slot 投影进来的元素、普通子元素。 */
export function obsFlatChildren(el: Element): Element[] {
  const sr = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
  if (sr) return [...sr.children];
  if (el.tagName === 'SLOT') return (el as HTMLSlotElement).assignedElements({ flatten: true });
  return [...el.children];
}

/**
 * 折叠重复项：组件库（Web Component）里，宿主或内部元素因为带点击监听被列成没有角色的 generic，
 * 而同一个控件已经有带角色的元素（内部原生按钮、宿主上的 tab 等）。generic 在渲染树上与带角色元素是
 * 祖孙关系、位置大小几乎重合、且没有名称（或与它同名）时，只保留带角色的那个。
 */
export function obsFoldDuplicates(listed: Map<Element, RawElement>): Set<RawElement> {
  const drop = new Set<RawElement>();
  const area = (r: Rect) => r[2] * r[3];
  /** g 被 c 盖住的比例、c 被 g 盖住的比例。 */
  const cover = (g: Rect, c: Rect): [number, number] => {
    const ov = area(obsIntersect(g, c));
    return [area(g) > 0 ? ov / area(g) : 0, area(c) > 0 ? ov / area(c) : 0];
  };
  const sameName = (g: RawElement, c: RawElement) => !g.name || g.name === c.name;
  // 向上（g 在带角色元素 c 的内部）：几乎重合，或 g 整个落在 c 的范围内（如 sl-radio 里的标签文字）。
  // 例外：无名但有提示词的图标，且与 c 在同一棵树里（卡片里的收藏星标、标签页的关闭叉：页面作者放进去的内容）
  // 是独立的操作，不折叠；组件自己 Shadow DOM 里的无名外观才是同一控件的重复
  const dupInside = (g: RawElement, c: RawElement | undefined, ge: Element, ce: Element) => {
    if (!c || c.role === 'generic' || !sameName(g, c)) return false;
    const [a, b] = cover(g.rect, c.rect);
    const own = Boolean(g.hint) && ge.getRootNode() === ce.getRootNode();
    return (a >= 0.6 && b >= 0.6) || (a >= 0.9 && !own);
  };
  // 向下（g 是包着真控件 c 的宿主或外壳）：几乎重合；或 g 没有名称，c 占了它的大半（如 sl-select 外面的表单项容器）
  const dupWrap = (g: RawElement, c: RawElement | undefined) => {
    if (!c || c.role === 'generic' || !sameName(g, c)) return false;
    const [a, b] = cover(g.rect, c.rect);
    return (a >= 0.6 && b >= 0.6) || (!g.name && b >= 0.9 && a >= 0.4);
  };
  for (const [el, info] of listed) {
    if (info.role !== 'generic') continue;
    // 向上：generic 在带角色元素的内部（如 sl-tab 里的 div.tab）
    let up: Element | null = obsParent(el);
    let hit = false;
    for (let i = 0; i < 6 && up && !hit; i++, up = obsParent(up))
      hit = dupInside(info, listed.get(up), el, up);
    // 向下：generic 是包着真控件的宿主或外壳（如 sl-button 宿主包着内部的 button）
    if (!hit) {
      let level = obsFlatChildren(el);
      for (let depth = 0, seen = 0; depth < 4 && level.length && !hit && seen < 60; depth++) {
        const next: Element[] = [];
        for (const k of level) {
          if (++seen > 60) break;
          if (dupWrap(info, listed.get(k))) {
            hit = true;
            break;
          }
          next.push(...obsFlatChildren(k));
        }
        level = next;
      }
    }
    if (hit) drop.add(info);
  }
  return drop;
}

/** 渲染树上的父元素：插槽分配 > 父元素 > Shadow Root 的宿主。 */
export function obsParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

/** 渲染出来了（display / visibility 不隐藏，且有尺寸）。 */
export function obsShown(el: Element): boolean {
  if (!el.checkVisibility({ visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * node 的子元素受到的祖先 overflow 裁剪区域（本 frame 坐标），null 表示不裁剪。
 * 沿渲染树向上取 overflow 非 visible 的元素的内边距盒求交；position:fixed 的祖先截断向上的链。
 * 结果按节点缓存，大表里同一行、同一容器只算一次。
 */
export function obsClipFor(node: Element | null, cache: Map<Element, Rect | null>): Rect | null {
  if (!node || node === document.documentElement || node === document.body) return null;
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  const st = getComputedStyle(node);
  const up = st.position === 'fixed' ? null : obsClipFor(obsParent(node), cache);
  let own: Rect | null = null;
  if (
    st.display !== 'contents' &&
    st.display !== 'inline' &&
    (st.overflowX !== 'visible' || st.overflowY !== 'visible')
  ) {
    const r = node.getBoundingClientRect();
    own = [r.left + node.clientLeft, r.top + node.clientTop, node.clientWidth, node.clientHeight];
  }
  const out = own ? obsIntersect(own, up) : up;
  cache.set(node, out);
  return out;
}

/** 命中测试（穿透开放与封闭的 Shadow DOM）：返回该点最上层的元素。 */
export function obsHit(x: number, y: number): Element | null {
  let e = document.elementFromPoint(x, y);
  for (let i = 0; e && i < 32; i++) {
    const sr = obShadow(e);
    if (!sr) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  return e;
}

/** b 是否是 a 本身或其后代（沿渲染树：插槽、Shadow 宿主）。 */
export function obsContains(a: Element, b: Element): boolean {
  let n: Node | null = b;
  while (n) {
    if (n === a) return true;
    const slot: Element | null = (n as Element).assignedSlot ?? null;
    n = slot ?? n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  }
  return false;
}

/** host 是否是 el 所在 Shadow 树的宿主（逐级向上）。 */
export function obsIsHostOf(host: Element, el: Element): boolean {
  let n: Element = el;
  for (let i = 0; i < 32; i++) {
    const root = n.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    if (root.host === host) return true;
    n = root.host;
  }
  return false;
}

/**
 * 视觉上隐藏的原生控件（自绘复选框的常见写法）：透明、不可见、尺寸小于 4 像素、移到页面外、被 clip 裁掉。
 */
export function obsVisuallyHidden(el: Element, r: DOMRect): boolean {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
  if (r.width < 4 || r.height < 4) return true;
  if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return true;
  const st = getComputedStyle(el);
  return st.clipPath !== 'none' || (st.clip !== 'auto' && st.clip !== '');
}

/**
 * 组件库为表单提交放的“值镜像”输入框：aria-hidden 且不可 Tab 聚焦（tabindex=-1）的文本类输入。
 * 它不是用户能操作的功能，值也是内部取值（如 sl-select 里选项的 value），不列出、不泄露。
 */
export function obsIsMirrorField(el: Element): boolean {
  if (el.getAttribute('aria-hidden') !== 'true' || el.getAttribute('tabindex') !== '-1')
    return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return ['text', 'search', 'email', 'tel', 'url', 'number', 'password'].includes(
    (el as HTMLInputElement).type,
  );
}

/** 当前值：输入框、下拉框、可编辑区、自绘滑块等；密码与敏感字段（见 obIsSensitive）显示为 ***；不适用时返回 undefined。 */
export function obsValue(el: Element, role: string, max: number): string | undefined {
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max)}…` : s);
  // 敏感字段有内容时显示 ***，没内容仍显示空，调用方能看出还没填
  const show = (s: string) => (obIsSensitive(el) ? (s ? '***' : '') : cut(s));
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const t = input.type;
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(t)) {
      return undefined;
    }
    if (t === 'file') return cut([...(input.files ?? [])].map((f) => f.name).join(', '));
    return show(input.value);
  }
  if (tag === 'TEXTAREA') return show((el as HTMLTextAreaElement).value);
  if (tag === 'SELECT') {
    const sel = [...(el as HTMLSelectElement).selectedOptions];
    return cut(sel.map((o) => obNorm(o.label || o.text)).join(', '));
  }
  if (['slider', 'spinbutton', 'progressbar', 'scrollbar', 'meter'].includes(role)) {
    const v = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow');
    return v === null ? undefined : cut(obNorm(v));
  }
  if ((el as HTMLElement).isContentEditable && el.hasAttribute('contenteditable')) {
    return show(obNorm((el as HTMLElement).innerText));
  }
  if (['textbox', 'searchbox', 'combobox'].includes(role)) {
    return show(obNorm(el.getAttribute('aria-valuetext') ?? (el as HTMLElement).innerText));
  }
  return undefined;
}

/**
 * 所在容器（业务主键）的统计索引：obWithin 的唯一性检查要遍历整个文档，大表里逐个调用是 O(n²)。
 * 这里一次统计 “标签|属性|值” 与 “标签#id” 的出现次数，供 obsWithin 查表。
 */
export function obsWithinCount(el: Element, idx: Map<string, number>): void {
  const KEYS = ['data-id', 'data-key', 'data-row-key', 'data-rowid', 'data-testid'];
  const tag = el.tagName.toLowerCase();
  for (const k of KEYS) {
    const v = el.getAttribute(k);
    if (v) idx.set(`${tag}|${k}|${v}`, (idx.get(`${tag}|${k}|${v}`) ?? 0) + 1);
  }
  if (el.id) idx.set(`${tag}#${el.id}`, (idx.get(`${tag}#${el.id}`) ?? 0) + 1);
}

/**
 * 与 obWithin 规则一致（测试里逐个比对），但唯一性查索引、结果按祖先缓存：
 * 从近到远找带业务主键属性、且在本文档内唯一的祖先。
 */
export function obsWithin(
  el: Element,
  memo: Map<Element, string | null>,
  idx: Map<string, number>,
): string | null {
  const KEYS = ['data-id', 'data-key', 'data-row-key', 'data-rowid', 'data-testid'];
  const TAGS = ['tr', 'li', 'article'];
  const chain: Element[] = [];
  let found: string | null = null;
  let cur = el.parentElement;
  while (cur && cur !== document.documentElement) {
    const m = memo.get(cur);
    if (m !== undefined) {
      found = m;
      break;
    }
    chain.push(cur);
    const tag = cur.tagName.toLowerCase();
    for (const k of KEYS) {
      const v = cur.getAttribute(k);
      if (v && /^[\w.-]{1,64}$/.test(v) && idx.get(`${tag}|${k}|${v}`) === 1) {
        found = `${tag}[${k}='${v}']`;
        break;
      }
    }
    const id = cur.id;
    if (
      !found &&
      id &&
      obIsStableToken(id) &&
      /^[A-Za-z][\w-]*$/.test(id) &&
      TAGS.includes(tag) &&
      idx.get(`${tag}#${id}`) === 1
    ) {
      found = `${tag}#${id}`;
    }
    if (found) break;
    cur = cur.parentElement;
  }
  for (const c of chain) memo.set(c, found);
  return found;
}

/** 计算一个元素的信息；不该列出时返回 null（select 里的选项、未渲染的元素、重复的自绘外观）。 */
export function obsElement(
  el: Element,
  ref: number,
  o: CollectOptions,
  want: Set<number>,
  clipCache: Map<Element, Rect | null>,
  withinMemo: Map<Element, string | null>,
  withinIdx: Map<string, number>,
): RawElement | null {
  const tag = el.tagName;
  // 原生下拉框的选项随下拉框的 options 列出，不单独列
  if (tag === 'OPTION' && el.closest('select, datalist')) return null;
  const kind = el.getAttribute('data-obact-kind');
  if (kind === 'pointer') {
    // label 里推断出的自绘外观（开关滑块等）与 label 关联的原生控件是同一个功能，只列控件
    const control = (el.closest('label') as HTMLLabelElement | null)?.control;
    if (control && control !== el && want.has(Number(control.getAttribute(o.attr)))) return null;
  }
  const role = obRole(el);
  const input = tag === 'INPUT' ? (el as HTMLInputElement) : null;
  const type = input ? input.type : '';
  const formControl = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag);
  const r0 = el.getBoundingClientRect();
  const shown = r0.width > 0 && r0.height > 0 && el.checkVisibility({ visibilityProperty: true });
  // 视觉上隐藏、但有可见 label 的原生复选框/单选框/文件框：几何与可点击性取自 label（act 会点 label）
  let geo: Element = el;
  let proxy = false;
  if (
    input &&
    (type === 'checkbox' || type === 'radio' || type === 'file') &&
    (!shown || obsVisuallyHidden(el, r0))
  ) {
    const label = obLabelsOf(input).find((l) => obsShown(l));
    if (label) {
      geo = label;
      proxy = true;
    }
  }
  // 未渲染的元素不列出；文件框例外：upload_file 不要求可见
  if (!proxy && !shown && type !== 'file') return null;
  const states = obStates(el);
  const r = geo === el ? r0 : geo.getBoundingClientRect();
  const rect: Rect = [r.left, r.top, r.width, r.height];
  let ratio = 0;
  let clickable = false;
  let pt: [number, number] | null = null;
  let blocked = false;
  const transparent = !proxy && shown && !el.checkVisibility({ opacityProperty: true });
  if (proxy || shown) {
    const fixed = getComputedStyle(geo).position === 'fixed';
    const outer = fixed ? null : obsClipFor(obsParent(geo), clipCache);
    const vis = obsIntersect(obsIntersect(rect, o.clip), outer);
    if (vis[2] > 0 && vis[3] > 0) {
      ratio = Math.max(0.001, Math.round(((vis[2] * vis[3]) / (r.width * r.height)) * 1000) / 1000);
      let x = vis[0] + vis[2] / 2;
      let y = vis[1] + vis[3] / 2;
      // 命中元素是目标所在 Shadow 树的宿主也算（slot 投影进来的文字属于宿主，如 Shoelace 按钮上的标签），与 act 的落点判定一致
      const lands = (t: Element, hit: Element) => obsContains(t, hit) || obsIsHostOf(hit, t);
      const hitsTarget = (px: number, py: number) => {
        const hit = obsHit(px, py);
        return hit !== null && (lands(geo, hit) || lands(el, hit));
      };
      let onTarget = hitsTarget(x, y);
      // 折行的内联元素（段落里换行的长链接）：包围盒中心可能落在两行之间，再逐个行盒取可见部分的中心试
      const lineBoxes = onTarget ? [] : [...geo.getClientRects()];
      if (lineBoxes.length > 1) {
        for (const q of lineBoxes.slice(0, 8)) {
          const v = obsIntersect(obsIntersect([q.left, q.top, q.width, q.height], o.clip), outer);
          if (v[2] <= 0 || v[3] <= 0) continue;
          const lx = v[0] + v[2] / 2;
          const ly = v[1] + v[3] / 2;
          if (!hitsTarget(lx, ly)) continue;
          x = lx;
          y = ly;
          onTarget = true;
          break;
        }
      }
      // 透明元素（opacity:0）：只有它本身是命中目标（透明覆盖在自绘外观上的原生控件）时才列出
      if (transparent && !onTarget && !formControl) return null;
      if (onTarget && !states.disabled) {
        // act 对 opacity:0 的元素一律判“不可见”（没有可见 label 可代点时）：标不可点击并注明原因，不让 observe 与 act 说法相反；
        // 文件框例外，upload_file 不要求可见
        if (transparent && type !== 'file') blocked = true;
        else {
          clickable = true;
          pt = [x, y];
        }
      }
    } else if (transparent && !formControl) return null;
  }
  const name = obName(el);
  const out: RawElement = {
    ref,
    role,
    name: name.length > o.nameMax ? `${name.slice(0, o.nameMax)}…` : name,
    actions: obActions(el),
    rect,
    ratio,
    clickable,
  };
  if (pt) out.pt = pt;
  if (proxy) out.proxy = true;
  if (blocked) out.transparent = true;
  if (!name) {
    const hint = obHint(el);
    if (hint) out.hint = hint;
  }
  const value = obsValue(el, role, o.valueMax);
  if (value !== undefined) out.value = value;
  if (input) out.inputType = type;
  if ((tag === 'A' || tag === 'AREA') && el.hasAttribute('href')) {
    const href = (el as HTMLAnchorElement).href;
    if (href && !/^javascript:/i.test(href)) {
      // data:/blob: 链接（客户端导出的下载）可能有几兆，只留开头；其他链接也设上限，结果体积不能由页面决定
      const cap = /^(data|blob):/i.test(href) ? 100 : o.hrefMax;
      out.href = href.length > cap ? `${href.slice(0, cap)}…` : href;
    }
  }
  const opts = obOptions(el, o.optionLimit, o.valueMax);
  if (opts) {
    out.options = opts.options;
    if (opts.omitted > 0) out.omitted = opts.omitted;
  }
  if (Object.keys(states).length) out.states = states;
  const within = obsWithin(el, withinMemo, withinIdx);
  if (within) out.within = within;
  if (kind) out.kind = kind;
  const placeholder = obNorm(el.getAttribute('placeholder'));
  if (placeholder && placeholder !== out.name) out.placeholder = placeholder;
  if (out.actions.includes('scroll')) {
    const he = el as HTMLElement;
    out.scroll = [Math.round(he.scrollTop), Math.max(0, he.scrollHeight - he.clientHeight)];
  }
  return out;
}

/** 一个 frame 的全部观察数据（入口函数）。 */
export function obsCollect(o: CollectOptions): FrameCollect {
  const want = new Set(o.refs);
  const clipCache = new Map<Element, Rect | null>();
  const withinMemo = new Map<Element, string | null>();
  const withinIdx = new Map<string, number>();
  // 一次遍历：候选元素、iframe、canvas，同时统计所在容器索引
  const seq: Element[] = [];
  const canvases: Element[] = [];
  for (const el of obDeepAll(document, '*')) {
    obsWithinCount(el, withinIdx);
    const tag = el.tagName;
    if (tag === 'IFRAME' || tag === 'FRAME') seq.push(el);
    else if (tag === 'CANVAS') canvases.push(el);
    if (el.hasAttribute(o.attr) && tag !== 'IFRAME' && tag !== 'FRAME') seq.push(el);
  }
  const elements: RawElement[] = [];
  const slots: number[] = [];
  const iframes = new Map<Element, number>();
  const listed = new Map<Element, RawElement>();
  const skip = new Set<Element>();
  const sensitive: number[] = [];
  for (const el of seq) {
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      iframes.set(el, slots.length);
      slots.push(elements.length);
      continue;
    }
    const ref = Number(el.getAttribute(o.attr));
    // 只认本会话写入的编号（克隆节点带来的旧属性在 markPage 中已被覆盖）
    if (!want.has(ref) || (el as unknown as Record<string, unknown>)[o.key] !== ref) continue;
    // 敏感字段先于“是否列出”登记：被预算截掉、零尺寸的也要在 axtree 里遮蔽
    if (obIsSensitive(el)) sensitive.push(ref);
    if (obsIsMirrorField(el)) continue;
    const info = obsElement(el, ref, o, want, clipCache, withinMemo, withinIdx);
    if (!info) continue;
    elements.push(info);
    listed.set(el, info);
    // 控件的标签文字就是它的名称，纯网页信息里不再重复；名称超过 longText 时 snapshot_text 里是截断的，
    // 完整文字（长协议、扣费说明）留在纯网页信息里
    if (info.name.length > o.longText) continue;
    for (const l of obLabelsOf(el)) skip.add(l);
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const root = el.getRootNode() as Document | ShadowRoot;
      for (const id of ids.split(/\s+/)) {
        const t = root.getElementById?.(id) ?? document.getElementById(id);
        if (t) skip.add(t);
      }
    }
  }
  // 折叠组件库里与带角色元素重复的 generic；iframe 位置要跟着重新计数
  const dropped = obsFoldDuplicates(listed);
  if (dropped.size) {
    const before: number[] = [];
    let kept = 0;
    for (let i = 0; i <= elements.length; i++) {
      before[i] = kept;
      const e = elements[i];
      if (e && !dropped.has(e)) kept++;
    }
    for (let k = 0; k < slots.length; k++) slots[k] = before[slots[k] as number] ?? kept;
    for (const [el, info] of listed) if (dropped.has(info)) listed.delete(el);
    const left = elements.filter((e) => !dropped.has(e));
    elements.length = 0;
    elements.push(...left);
  }
  let canvasArea = 0;
  for (const c of canvases) {
    if (!c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = c.getBoundingClientRect();
    const v = obsIntersect(
      obsIntersect([r.left, r.top, r.width, r.height], o.clip),
      obsClipFor(obsParent(c), clipCache),
    );
    canvasArea += v[2] * v[3];
  }
  const lines = obsText({
    listed,
    skip,
    iframes,
    clip: o.clip,
    tableRows: o.tableRows,
    listItems: o.listItems,
    longText: o.longText,
  });
  return {
    elements,
    slots,
    lines,
    sensitive,
    canvasArea,
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
  };
}

/** iframe 在父文档中的稳定、唯一选择器：稳定 id、name、title、aria-label、data-testid、src，兜底用结构路径。 */
export function obsFrameSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const all = obDeepAll(document, 'iframe, frame');
  const unique = (sel: string) => all.filter((f) => f.matches(sel)).length === 1;
  const id = el.id;
  if (id && obIsStableToken(id) && /^[A-Za-z][\w-]*$/.test(id) && unique(`${tag}#${id}`)) {
    return `${tag}#${id}`;
  }
  const quote = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;
  for (const a of ['name', 'title', 'aria-label', 'data-testid', 'src']) {
    const v = el.getAttribute(a);
    if (!v || v.length > 200) continue;
    if ((a === 'name' || a === 'data-testid') && !obIsStableToken(v)) continue;
    if (a === 'src' && /\d{3,}/.test(v)) continue;
    const sel = `${tag}[${a}=${quote(v)}]`;
    if (unique(sel)) return sel;
  }
  const steps: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const node: Element = cur;
    const t = node.tagName.toLowerCase();
    if (node !== el && node.id && obIsStableToken(node.id) && /^[A-Za-z][\w-]*$/.test(node.id)) {
      steps.unshift(`#${node.id}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [];
    steps.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t);
    cur = parent;
  }
  return steps.join(' > ');
}

/** 在父 frame 中取 iframe 的内容区位置、裁剪、选择器和序号。 */
export function obsOwnerInfo(owner: Element): OwnerInfo {
  const r = owner.getBoundingClientRect();
  const st = getComputedStyle(owner);
  const pl = Number.parseFloat(st.paddingLeft) || 0;
  const pt = Number.parseFloat(st.paddingTop) || 0;
  const pr = Number.parseFloat(st.paddingRight) || 0;
  const pb = Number.parseFloat(st.paddingBottom) || 0;
  // iframe 或祖先有 CSS 缩放时：边框盒的显示尺寸 / 布局尺寸（offsetWidth）就是缩放系数；接近 1 的是取整误差，按 1
  const ratio = (shown: number, layout: number) => {
    const k = layout > 0 && shown > 0 ? shown / layout : 1;
    return Math.abs(k - 1) > 0.01 ? k : 1;
  };
  const sx = ratio(r.width, (owner as HTMLElement).offsetWidth);
  const sy = ratio(r.height, (owner as HTMLElement).offsetHeight);
  return {
    rendered: obsShown(owner),
    box: [
      r.left + (owner.clientLeft + pl) * sx,
      r.top + (owner.clientTop + pt) * sy,
      Math.max(0, owner.clientWidth - pl - pr) * sx,
      Math.max(0, owner.clientHeight - pt - pb) * sy,
    ],
    scale: [sx, sy],
    clip: st.position === 'fixed' ? null : obsClipFor(obsParent(owner), new Map()),
    selector: obsFrameSelector(owner),
    index: obDeepAll(document, 'iframe, frame').indexOf(owner),
  };
}

/** 在父 frame 中复核：这些点（父 frame 坐标）是否落在 owner（iframe）上，没有被父文档的遮罩挡住。 */
export function obsHitOwner(owner: Element, points: [number, number][]): boolean[] {
  return points.map(([x, y]) => {
    const hit = obsHit(x, y);
    return hit !== null && obsContains(owner, hit);
  });
}

/**
 * 编号框覆盖层（view=som）：position:fixed、pointer-events:none，放在封闭 Shadow DOM 里不受页面样式影响。
 * 全部用 DOM API 和 CSSOM 构造（与 banner.ts 一致）：不用 innerHTML（页面启用 Trusted Types 时会抛错）、
 * 不用 <style> 和 style 属性的标记（页面 CSP 的 style-src 会拦掉，编号全堆在左上角）。
 */
export function obsSomShow(boxes: { ref: number; x: number; y: number; w: number; h: number }[]) {
  const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324'];
  const host = document.createElement('obact-som');
  host.setAttribute('data-obact-som', '');
  host.style.cssText =
    'all:initial!important;position:fixed!important;left:0!important;top:0!important;' +
    'width:0!important;height:0!important;overflow:visible!important;pointer-events:none!important;' +
    'z-index:2147483647!important;display:block!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet(); // 构造样式表不受页面 CSP 限制
  sheet.replaceSync(
    'div{position:fixed;box-sizing:border-box;pointer-events:none}' +
      'span{position:fixed;font:bold 11px/13px monospace;color:#fff;padding:0 2px;pointer-events:none;white-space:nowrap}',
  );
  root.adoptedStyleSheets = [sheet];
  for (const b of boxes) {
    const c = COLORS[b.ref % COLORS.length];
    const ly = b.y >= 13 ? b.y - 13 : b.y;
    const frame = document.createElement('div');
    frame.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:2px solid ${c}`;
    const tag = document.createElement('span');
    tag.style.cssText = `left:${b.x}px;top:${ly}px;background:${c}`;
    tag.textContent = String(b.ref);
    root.append(frame, tag);
  }
  document.documentElement.appendChild(host);
  return boxes.length;
}

/** 移除编号框覆盖层。 */
export function obsSomHide(): number {
  const list = document.querySelectorAll('[data-obact-som]');
  for (const e of list) e.remove();
  return list.length;
}

/** 签名用：定位器在本 frame 命中的渲染出来的元素数（css 优先，css 没有命中再按 角色+名称）。 */
export function obsCountLocator(loc: {
  css?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  within?: string;
}): number {
  const rendered = (e: Element) => e.checkVisibility();
  const scopes: (Document | Element)[] = loc.within
    ? obDeepAll(document, loc.within).filter(rendered)
    : [document];
  let css = 0;
  let role = 0;
  for (const scope of scopes) {
    if (loc.css) css += obDeepAll(scope, loc.css).filter(rendered).length;
    if (loc.role && !css) {
      const want = obNorm(loc.name);
      const exact = loc.exact !== false;
      role += obDeepAll(scope, '*').filter((e) => {
        if (obRole(e) !== loc.role || !rendered(e)) return false;
        if (loc.name === undefined) return true;
        const name = obName(e);
        return exact ? name === want : name.toLowerCase().includes(want.toLowerCase());
      }).length;
    }
  }
  return css || role;
}

/** observe 的全部页面内助手，与底座的 DOM_LIB 一起交给 bundle。新增助手时加到这里。 */
export const OBS_LIB = [
  obsIntersect,
  obsParent,
  obsFlatChildren,
  obsFoldDuplicates,
  obsShown,
  obsClipFor,
  obsHit,
  obsContains,
  obsIsHostOf,
  obsVisuallyHidden,
  obsIsMirrorField,
  obsValue,
  obsWithinCount,
  obsWithin,
  obsElement,
  obsCollect,
  obsFrameSelector,
  obsOwnerInfo,
  obsHitOwner,
  obsSomShow,
  obsSomHide,
  obsCountLocator,
  obsKeepLine,
  obsText,
];
