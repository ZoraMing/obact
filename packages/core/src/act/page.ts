/**
 * act 专用的页面内助手（在浏览器里执行）。约定同 page/bundle.ts：自包含的函数声明，只互相调用，
 * 并可调用 DOM_LIB 里的助手。用 `bundle(main, ACT_DEPS)` 送进页面。
 */
import {
  DOM_LIB,
  obActions,
  obActiveElement,
  obDeepAll,
  obName,
  obNorm,
  obRole,
  obShadow,
} from '../page/dom.ts';

type Rect = [number, number, number, number];
type Hit = { ok: boolean; x: number; y: number; desc: string };

/** 元素简述，用于报错：tag#id.class "文本"。 */
export function obActDescribe(el: Element | null): string {
  if (!el) return '（空白处）';
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls =
    typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  if (cls.length) s += `.${cls.slice(0, 2).join('.')}`;
  const text = obNorm((el as HTMLElement).innerText ?? el.textContent).slice(0, 24);
  if (text) s += ` "${text}"`;
  return s;
}

/** 穿透 Shadow DOM（含已挂出的封闭 Shadow Root）的命中测试：坐标处最深的元素。 */
export function obActDeepHit(x: number, y: number): Element | null {
  let root: Document | ShadowRoot = document;
  let hit: Element | null = null;
  for (let i = 0; i < 32; i++) {
    const next: Element | null = root.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
    const sr = obShadow(next);
    if (!sr) break;
    root = sr;
  }
  return hit;
}

/**
 * 命中元素是否算落在目标上：目标本身或其后代；目标的 label 内（点 label 等于点控件）；
 * 或目标所在 Shadow 树的宿主（封闭 Shadow 内的命中与事件会被重定向到宿主）。
 */
export function obActHits(el: Element, hit: Element | null): boolean {
  if (!hit) return false;
  if (hit === el || el.contains(hit)) return true;
  const labels = (el as HTMLInputElement).labels;
  if (labels) {
    for (const l of labels) if (l === hit || l.contains(hit)) return true;
  }
  let node: Node = el;
  for (let i = 0; i < 32; i++) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    if (root.host === hit) return true;
    node = root.host;
  }
  return false;
}

/** 元素是否禁用：:disabled、aria-disabled、位于 inert 子树内。 */
export function obActDisabled(el: Element): boolean {
  return (
    el.matches(':disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    !!el.closest('[inert]')
  );
}

/** 视觉上可见：未被 display/visibility/opacity 隐藏，且有尺寸。 */
export function obActVisible(el: Element): boolean {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * 视觉上隐藏、但有可见 label 的原生 checkbox/radio（自绘复选框的常见写法）：返回应点击的 label。
 * 隐藏指不可见或尺寸小于 4 像素（如 sr-only 的 1×1 写法）。
 */
export function obActLabelProxy(el: Element): Element | null {
  if (el.tagName !== 'INPUT') return null;
  const type = (el as HTMLInputElement).type;
  if (type !== 'checkbox' && type !== 'radio') return null;
  const r = el.getBoundingClientRect();
  if (obActVisible(el) && r.width >= 4 && r.height >= 4) return null;
  for (const l of (el as HTMLInputElement).labels ?? []) {
    const lr = l.getBoundingClientRect();
    if (obActVisible(l) && lr.width >= 4 && lr.height >= 4) return l;
  }
  return null;
}

/** 本 frame 视口（不含滚动条）。 */
export function obActViewport(): { w: number; h: number } {
  const de = document.documentElement;
  return { w: de?.clientWidth || innerWidth, h: de?.clientHeight || innerHeight };
}

/**
 * 候选点击点：取元素在视口内面积最大的一段 client rect（换行的行内元素有多段），
 * 先取其可见部分的中心，再取四个象限的中心作为备选（部分被吸顶栏等盖住时仍能命中）。
 */
export function obActPoints(el: Element): { points: [number, number][]; inView: boolean } {
  const vp = obActViewport();
  let best: { l: number; t: number; r: number; b: number; area: number } | null = null;
  let any: DOMRect | null = null;
  for (const rect of el.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!any || rect.width * rect.height > any.width * any.height) any = rect;
    const l = Math.max(rect.left, 0);
    const t = Math.max(rect.top, 0);
    const r = Math.min(rect.right, vp.w);
    const b = Math.min(rect.bottom, vp.h);
    const area = Math.max(0, r - l) * Math.max(0, b - t);
    if (area > 0 && (!best || area > best.area)) best = { l, t, r, b, area };
  }
  if (!best) {
    const r = any ?? el.getBoundingClientRect();
    return { points: [[r.left + r.width / 2, r.top + r.height / 2]], inView: false };
  }
  const w = best.r - best.l;
  const h = best.b - best.t;
  // 可见部分太小（不到 2×2）时也视为不在视口内，交给滚动处理
  const inView = w >= 2 && h >= 2;
  const at = (fx: number, fy: number): [number, number] => [best.l + w * fx, best.t + h * fy];
  return {
    points: [at(0.5, 0.5), at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)],
    inView,
  };
}

/**
 * 可操作性探测（FR-13）：subject 决定是否启用（label 代点时 subject 是控件本身），el 决定位置与命中。
 * withHit 为 true 时同时做命中测试：依次尝试候选点，返回第一个落在目标上的点。
 */
export function obActProbe(
  el: Element,
  subject: Element | null,
  withHit: boolean,
): {
  connected: boolean;
  visible: boolean;
  enabled: boolean;
  inView: boolean;
  rect: Rect;
  hit: Hit | null;
} {
  const subj = subject ?? el;
  const connected = el.isConnected && subj.isConnected;
  const r = el.getBoundingClientRect();
  const rect: Rect = [r.left, r.top, r.width, r.height];
  const out = {
    connected,
    visible: connected && obActVisible(el),
    enabled: connected && !obActDisabled(subj),
    inView: false,
    rect,
    hit: null as Hit | null,
  };
  if (!out.visible) return out;
  const { points, inView } = obActPoints(el);
  out.inView = inView;
  if (!withHit || !inView) return out;
  let first: Hit | null = null;
  for (const [x, y] of points) {
    const hit = obActDeepHit(x, y);
    const ok = obActHits(subj, hit) || obActHits(el, hit);
    if (ok) {
      out.hit = { ok, x, y, desc: '' };
      return out;
    }
    first ??= { ok, x, y, desc: obActDescribe(hit) };
  }
  out.hit = first;
  return out;
}

/** 坐标处的命中元素是否仍是目标（派发前一刻的复核）。 */
export function obActRecheck(el: Element, subject: Element | null, x: number, y: number): Hit {
  const hit = obActDeepHit(x, y);
  const ok = obActHits(subject ?? el, hit) || obActHits(el, hit);
  return { ok, x, y, desc: ok ? '' : obActDescribe(hit) };
}

/** 滚动到视口中央（瞬时，不受 CSS scroll-behavior 影响）。 */
export function obActScrollIntoView(el: Element, block: string): void {
  el.scrollIntoView({
    block: block as ScrollLogicalPosition,
    inline: 'center',
    behavior: 'instant' as ScrollBehavior,
  });
}

/**
 * iframe 元素（在父文档中执行）：把子 frame 内的坐标换算到本文档，并确认该点命中这个 iframe（没被上层遮挡）。
 * 偏移 = iframe 边框盒位置 + 边框 + 内边距（不处理 iframe 自身的 CSS 变换）。
 */
export function obActFrameHit(
  frameEl: Element,
  x: number,
  y: number,
): { ok: boolean; inView: boolean; x: number; y: number; desc: string } {
  const r = frameEl.getBoundingClientRect();
  const st = getComputedStyle(frameEl);
  const px = x + r.left + (parseFloat(st.borderLeftWidth) || 0) + (parseFloat(st.paddingLeft) || 0);
  const py = y + r.top + (parseFloat(st.borderTopWidth) || 0) + (parseFloat(st.paddingTop) || 0);
  const vp = obActViewport();
  const inView = px >= 0 && py >= 0 && px < vp.w && py < vp.h;
  if (!inView) return { ok: false, inView, x: px, y: py, desc: '' };
  const hit = obActDeepHit(px, py);
  const ok = hit === frameEl || obActHits(frameEl, hit);
  return { ok, inView, x: px, y: py, desc: ok ? '' : obActDescribe(hit) };
}

/**
 * 动作的元素信息：可用操作（与 observe 一致，取自 obActions）、填写方式、点击方式。
 * - fill：text（文本类输入框、textarea）、editable（contenteditable）、value（日期/颜色/滑块等，用页面脚本设值）、
 *   check（复选/单选）、select（下拉框）；
 * - click：option-select（下拉框的选项，改为选择）、option-datalist（datalist 建议项，改为填入输入框）、
 *   label（隐藏的原生复选/单选，改点可见的 label）、normal。
 */
export function obActInfo(el: Element): {
  tag: string;
  role: string;
  name: string;
  actions: string[];
  kind: string | null;
  fill: string | null;
  click: string;
  multiple: boolean;
  checked: boolean | null;
  type: string;
  isFileInput: boolean;
  labelFile: boolean;
} {
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el as HTMLInputElement).type : '';
  const role = obRole(el);
  let fill: string | null = null;
  if (tag === 'select') fill = 'select';
  else if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') fill = 'check';
    else if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) {
      fill = 'value';
    } else if (type !== 'file' && type !== 'hidden') fill = 'text';
  } else if (tag === 'textarea') fill = 'text';
  else if ((el as HTMLElement).isContentEditable) fill = 'editable';
  let click = 'normal';
  if (tag === 'option') {
    click = el.closest('select')
      ? 'option-select'
      : el.closest('datalist')
        ? 'option-datalist'
        : 'normal';
  } else if (obActLabelProxy(el)) click = 'label';
  const control = tag === 'label' ? (el as HTMLLabelElement).control : null;
  return {
    tag,
    role,
    name: obName(el).slice(0, 60),
    actions: obActions(el),
    kind: el.getAttribute('data-obact-kind'),
    fill,
    click,
    multiple: !!(el as HTMLInputElement | HTMLSelectElement).multiple,
    checked:
      fill === 'check'
        ? (el as HTMLInputElement).checked
        : el.hasAttribute('aria-checked')
          ? el.getAttribute('aria-checked') === 'true'
          : null,
    type,
    isFileInput: tag === 'input' && type === 'file',
    labelFile:
      !!control && control.tagName === 'INPUT' && (control as HTMLInputElement).type === 'file',
  };
}

/** 聚焦并全选文本类控件的内容；返回聚焦是否成功、原内容是否非空。 */
export function obActFocusSelectAll(el: Element): { focused: boolean; hadContent: boolean } {
  const he = el as HTMLElement;
  if (obActiveElement() !== el) he.focus({ preventScroll: true });
  const focused = obActiveElement() === el;
  if (!focused) return { focused, hadContent: false };
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    input.select();
    return { focused, hadContent: input.value.length > 0 };
  }
  const sel = (el.getRootNode() as Document).getSelection?.() ?? document.getSelection();
  sel?.selectAllChildren(el);
  return { focused, hadContent: (he.innerText ?? '').replace(/\n$/, '').length > 0 };
}

/** 是否是当前焦点。 */
export function obActIsFocused(el: Element): boolean {
  return obActiveElement() === el;
}

/**
 * 用原生 value 设置器写值并派发 input/change（日期、颜色、滑块等无法逐字输入的控件；
 * 走原型上的设置器，React 等框架的受控组件也能感知）。
 */
export function obActSetNativeValue(el: Element, value: string): string {
  const proto =
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return (el as HTMLInputElement).value;
}

/** 当前值：输入框/下拉框的 value，复选/单选为 "true"/"false"，可编辑区域与其他元素取文本。 */
export function obActValue(el: Element): string {
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') return String(input.checked);
    return input.value;
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return (el as HTMLTextAreaElement).value;
  if (el.hasAttribute('aria-checked')) return String(el.getAttribute('aria-checked') === 'true');
  return obNorm((el as HTMLElement).innerText ?? el.textContent);
}

/**
 * 下拉框按选项文本或值找目标选项（依次：文本精确、值精确、文本忽略大小写），并给出键盘选择的步数：
 * 在可用选项中从当前项移到目标项要按几次方向键（当前无选中时先按 Home）。
 */
export function obActSelectPlan(
  select: Element,
  want: string,
  index: number | null,
): {
  index: number;
  current: number;
  disabled: boolean;
  steps: number;
  home: boolean;
  labels: string[];
} {
  const s = select as HTMLSelectElement;
  const opts = [...s.options];
  const label = (o: HTMLOptionElement) => obNorm(o.label || o.text);
  let i = index ?? -1;
  if (index === null) {
    const w = obNorm(want);
    i = opts.findIndex((o) => label(o) === w);
    if (i < 0) i = opts.findIndex((o) => o.value === want);
    if (i < 0) i = opts.findIndex((o) => label(o).toLowerCase() === w.toLowerCase());
  }
  const enabled = opts
    .map((o, k) => ({ o, k }))
    .filter(({ o }) => !o.disabled && !(o.parentElement as HTMLOptGroupElement)?.disabled)
    .map(({ k }) => k);
  const current = s.selectedIndex;
  const to = enabled.indexOf(i);
  const from = enabled.indexOf(current);
  const home = from < 0;
  return {
    index: i,
    current,
    disabled: i >= 0 && to < 0,
    steps: home ? to : to - from,
    home,
    labels: opts.slice(0, 30).map(label),
  };
}

/** 下拉框选中第 index 项（键盘方式未生效时的退路）：只选这一项，派发 input/change。 */
export function obActSelectApply(select: Element, index: number): string {
  const s = select as HTMLSelectElement;
  if (s.multiple) for (const o of s.options) o.selected = false;
  s.selectedIndex = index;
  s.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
}

/** 选项所属的下拉框，及选项下标。 */
export function obActOptionOwner(opt: Element): { select: Element | null; index: number } {
  const select = opt.closest('select');
  return { select, index: select ? [...select.options].indexOf(opt as HTMLOptionElement) : -1 };
}

/** datalist 选项对应的输入框（list 属性指向该 datalist），及要填入的值。 */
export function obActDatalistInput(opt: Element): { input: Element | null; value: string } {
  const list = opt.closest('datalist');
  const value = (opt as HTMLOptionElement).value;
  if (!list?.id) return { input: null, value };
  const root = list.getRootNode() as Document | ShadowRoot;
  const input = root.querySelector(`input[list="${CSS.escape(list.id)}"]`);
  return { input, value };
}

/**
 * 动作期间的页面变化记录（装在 window 的不可枚举属性上，键名含会话随机串）：
 * - muts：DOM 变动数（忽略本工具写的 data-obact-* 属性）；inputs：input/change 事件数（表单值变化）。
 * - lastSig：最近一次“有效变动”的时间。同一节点第 3 次及以后的变动视为周期性刷新（时钟、轮询列表），
 *   不再推迟稳定判定，这样常驻刷新的页面不会拖慢短时稳定等待（FR-14）。
 * 跨文档导航后新文档里没有这个记录，据此判定发生了导航。
 */
export function obActTrack(key: string): boolean {
  type Tracker = {
    muts: number;
    inputs: number;
    lastSig: number;
    url: string;
    stop: () => void;
  };
  const w = window as unknown as Record<string, Tracker | undefined>;
  w[key]?.stop();
  const counts = new WeakMap<Node, number>();
  const t: Tracker = {
    muts: 0,
    inputs: 0,
    lastSig: performance.now(),
    url: location.href,
    stop: () => {},
  };
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.attributeName?.startsWith('data-obact-')) continue;
      t.muts++;
      const c = (counts.get(m.target) ?? 0) + 1;
      counts.set(m.target, c);
      if (c <= 2) t.lastSig = performance.now();
    }
  });
  obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const onInput = () => {
    t.inputs++;
  };
  addEventListener('input', onInput, true);
  addEventListener('change', onInput, true);
  t.stop = () => {
    obs.disconnect();
    removeEventListener('input', onInput, true);
    removeEventListener('change', onInput, true);
  };
  Object.defineProperty(window, key, { value: t, configurable: true, writable: true });
  return true;
}

/** 读取变化记录；missing 表示本文档没有记录（已导航到新文档）。reset 为 true 时把稳定计时起点设为现在。 */
export function obActTrackRead(
  key: string,
  opts: { reset?: boolean; stop?: boolean },
): { missing: boolean; muts: number; inputs: number; age: number; url: string } {
  const t = (
    window as unknown as Record<
      string,
      { muts: number; inputs: number; lastSig: number; stop: () => void } | undefined
    >
  )[key];
  if (!t) return { missing: true, muts: 0, inputs: 0, age: 0, url: location.href };
  const now = performance.now();
  if (opts.reset) t.lastSig = now;
  const out = {
    missing: false,
    muts: t.muts,
    inputs: t.inputs,
    age: now - t.lastSig,
    url: location.href,
  };
  if (opts.stop) {
    t.stop();
    delete (window as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/** 落点核对：记录下一次 pointerdown 的真实目标（composedPath 的第一个元素）。 */
export function obActLandStart(key: string): void {
  const rec = { target: null as Element | null, fired: false };
  const h = (e: Event) => {
    if (rec.fired) return;
    rec.fired = true;
    const first = e.composedPath()[0];
    rec.target = first instanceof Element ? first : (e.target as Element | null);
  };
  addEventListener('pointerdown', h, true);
  Object.defineProperty(window, key, {
    value: { rec, stop: () => removeEventListener('pointerdown', h, true) },
    configurable: true,
  });
}

/** 读取落点记录并撤掉监听：fired 为 false 表示本 frame 没收到按下事件。 */
export function obActLandRead(
  key: string,
  el: Element,
  subject: Element | null,
): { fired: boolean; ok: boolean; desc: string } {
  const w = window as unknown as Record<
    string,
    { rec: { target: Element | null; fired: boolean }; stop: () => void } | undefined
  >;
  const land = w[key];
  if (!land) return { fired: false, ok: true, desc: '' };
  land.stop();
  delete (window as unknown as Record<string, unknown>)[key];
  const t = land.rec.target;
  if (!land.rec.fired) return { fired: false, ok: false, desc: '' };
  const ok = obActHits(subject ?? el, t) || obActHits(el, t);
  return { fired: true, ok, desc: ok ? '' : obActDescribe(t) };
}

/** 本 frame 的可见文本：body.innerText 加上 Shadow DOM 内的文本（innerText 不进入 Shadow 树）。 */
export function obActText(limit: number): string {
  const body = document.body;
  if (!body) return '';
  const parts = [body.innerText];
  let size = parts[0]?.length ?? 0;
  for (const host of obDeepAll(document, '*')) {
    if (size > limit) break;
    const sr = obShadow(host);
    if (!sr || !(host as HTMLElement).checkVisibility?.({ visibilityProperty: true })) continue;
    for (const child of sr.children) {
      if (child.tagName === 'STYLE' || child.tagName === 'SCRIPT') continue;
      const t = (child as HTMLElement).innerText ?? '';
      if (t) {
        parts.push(t);
        size += t.length;
      }
    }
  }
  return parts.join('\n').slice(0, limit);
}

/** 本 frame 是否实际可见：沿 frameElement 向上（同源才能访问），任何一层 iframe 不可见即不可见。 */
export function obActFrameShown(): boolean {
  let w: Window | null = window;
  for (let i = 0; i < 16 && w; i++) {
    let fe: Element | null = null;
    try {
      fe = w.frameElement;
    } catch {
      return true;
    }
    if (!fe) return true;
    if (!obActVisible(fe)) return false;
    w = fe.ownerDocument.defaultView;
  }
  return true;
}

/**
 * 按定位器（不含 frame）计数可见的匹配元素：≥1 即存在，不要求唯一。
 * within 匹配多个容器时在所有容器内计数；CSS 没有可见匹配时再按 角色+名称。
 */
export function obActCount(loc: {
  css?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  within?: string;
}): { visible: number; total: number } {
  let scopes: (Document | Element)[] = [document];
  if (loc.within) scopes = obDeepAll(document, loc.within);
  const uniq = (list: Element[]) => [...new Set(list)];
  let total = 0;
  let visible = 0;
  if (loc.css) {
    const list = uniq(scopes.flatMap((s) => obDeepAll(s, loc.css as string)));
    total = list.length;
    visible = list.filter((e) => obActVisible(e)).length;
  }
  if (visible === 0 && loc.role) {
    const want = obNorm(loc.name);
    const exact = loc.exact !== false;
    const list = uniq(
      scopes.flatMap((s) =>
        obDeepAll(s, '*').filter((e) => {
          if (obRole(e) !== loc.role) return false;
          if (loc.name === undefined) return true;
          const n = obName(e);
          return exact ? n === want : n.toLowerCase().includes(want.toLowerCase());
        }),
      ),
    );
    total = Math.max(total, list.length);
    visible = list.filter((e) => obActVisible(e)).length;
  }
  return { visible, total };
}

/** 滚动位置快照：坐标处元素的各级可滚动祖先与页面的滚动位置，用于判断滚轮是否已生效。 */
export function obActScrollState(x: number, y: number): number[] {
  const out = [scrollX, scrollY];
  let el: Element | null = obActDeepHit(x, y);
  for (let i = 0; i < 64 && el; i++) {
    if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
      out.push(el.scrollLeft, el.scrollTop);
    }
    const parent: Element | null = el.parentElement;
    el = parent ?? ((el.getRootNode() as ShadowRoot).host || null);
  }
  return out;
}

/** 元素默认滚动量：可见高度的 80%。 */
export function obActScrollAmount(el: Element | null): number {
  const h = el
    ? (el as HTMLElement).clientHeight || el.getBoundingClientRect().height
    : innerHeight;
  return Math.max(40, Math.round(h * 0.8));
}

/** act 的页面内依赖：DOM_LIB 加上本文件的助手。 */
export const ACT_DEPS = [
  ...DOM_LIB,
  obActDescribe,
  obActDeepHit,
  obActHits,
  obActDisabled,
  obActVisible,
  obActLabelProxy,
  obActViewport,
  obActPoints,
  obActProbe,
  obActRecheck,
  obActScrollIntoView,
  obActFrameHit,
  obActInfo,
  obActFocusSelectAll,
  obActIsFocused,
  obActSetNativeValue,
  obActValue,
  obActSelectPlan,
  obActSelectApply,
  obActOptionOwner,
  obActDatalistInput,
  obActTrack,
  obActTrackRead,
  obActLandStart,
  obActLandRead,
  obActText,
  obActFrameShown,
  obActCount,
  obActScrollState,
  obActScrollAmount,
];
