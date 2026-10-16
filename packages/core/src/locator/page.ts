/**
 * 定位器生成的页面内助手（约定同 page/bundle.ts）。依赖 page/dom.ts 的 DOM_LIB。
 */
import {
  obDeepAll,
  obIsInteractive,
  obIsStableText,
  obIsStableToken,
  obName,
  obNorm,
  obPickUnique,
  obRole,
  obWithin,
} from '../page/dom.ts';

/** CSS 属性值转义（选择器里用双引号包裹）。 */
export function obCssStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 链接地址是否稳定：不含长数字串（订单号、时间戳）、不是脚本链接，长度适中。 */
export function obIsStableHref(href: string | null): boolean {
  if (!href || href.length > 120) return false;
  if (/^(javascript:|data:|#$)/i.test(href)) return false;
  return !/\d{3,}/.test(href);
}

/** 属性/CSS 候选，按优先级排列：测试 id、稳定 id、name、aria-label、href、placeholder、title、类名、类型。 */
export function obCssCandidates(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(a);
    if (v && obIsStableToken(v)) out.push(`[${a}=${obCssStr(v)}]`);
  }
  const id = el.id;
  if (id && obIsStableToken(id)) out.push(`${tag}[id=${obCssStr(id)}]`);
  const name = el.getAttribute('name');
  if (name && obIsStableToken(name) && ['input', 'select', 'textarea', 'button'].includes(tag)) {
    out.push(`${tag}[name=${obCssStr(name)}]`);
  }
  const aria = obNorm(el.getAttribute('aria-label'));
  if (aria && obIsStableText(aria)) out.push(`${tag}[aria-label=${obCssStr(aria)}]`);
  const href = el.getAttribute('href');
  if (tag === 'a' && obIsStableHref(href)) out.push(`a[href=${obCssStr(href as string)}]`);
  for (const a of ['placeholder', 'title', 'alt']) {
    const v = obNorm(el.getAttribute(a));
    if (v && obIsStableText(v)) out.push(`${tag}[${a}=${obCssStr(v)}]`);
  }
  const classes = [...el.classList].filter(
    (c) => obIsStableToken(c) && /^[A-Za-z_][\w-]*$/.test(c),
  );
  if (classes.length) out.push(`${tag}.${classes.slice(0, 2).join('.')}`);
  const type = el.getAttribute('type');
  if (tag === 'input' && type && /^[a-z]+$/.test(type)) out.push(`input[type=${obCssStr(type)}]`);
  return out;
}

/** 在 scope 内按 CSS 能否唯一解析回 el（与 obResolve 的规则一致：多个时取唯一可见者）。 */
export function obCssPicks(scope: Document | Element, css: string, el: Element): boolean {
  let list: Element[];
  try {
    list = obDeepAll(scope, css);
  } catch {
    return false;
  }
  return obPickUnique(list) === el;
}

/** 在 scope 内按 角色+名称（精确匹配）能否唯一解析回 el。 */
export function obRolePicks(
  scope: Document | Element,
  role: string,
  name: string,
  el: Element,
): boolean {
  const list = obDeepAll(scope, '*').filter((e) => obRole(e) === role && obName(e) === name);
  return obPickUnique(list) === el;
}

/**
 * 为元素生成定位器（FR-07）：属性/CSS 与 角色+名称 两类合在一个对象里；
 * 不唯一时加 within（业务主键容器）再试；某一类做不到唯一就省略。不含 frame 链（Node 侧补）。
 */
export function obGenLocator(el: Element): {
  locator: { css?: string; role?: string; name?: string; within?: string };
  unique: boolean;
} {
  const role = obRole(el);
  const name = obName(el);
  const roleUsable = role !== 'generic' && role !== 'none' && (name === '' || obIsStableText(name));
  const candidates = obCssCandidates(el);

  const pick = (scope: Document | Element) => {
    const css = candidates.find((c) => obCssPicks(scope, c, el));
    const roleOk = roleUsable && obRolePicks(scope, role, name, el);
    return { css, roleOk };
  };

  let within: string | null = null;
  let r = pick(document);
  if (!r.css || !r.roleOk) {
    within = obWithin(el);
    if (within) {
      const container = obPickUnique(obDeepAll(document, within));
      if (container) {
        const r2 = pick(container);
        // 加 within 后至少一类更好才采用
        if ((r2.css && !r.css) || (r2.roleOk && !r.roleOk)) r = r2;
        else within = null;
      } else within = null;
    }
  }
  const locator: { css?: string; role?: string; name?: string; within?: string } = {};
  if (r.css) locator.css = r.css;
  if (r.roleOk) {
    locator.role = role;
    if (name) locator.name = name;
  }
  if (within) locator.within = within;
  const unique = Boolean(r.css || r.roleOk);
  if (!unique) {
    // 尽力而为：给出第一个 CSS 候选或角色，调用方会得到 unique=false
    if (candidates[0]) locator.css = candidates[0];
    else if (roleUsable) {
      locator.role = role;
      if (name) locator.name = name;
    } else locator.css = el.tagName.toLowerCase();
  }
  return { locator, unique };
}

/** iframe 元素在父文档中的稳定、唯一选择器；做不到返回 null。 */
export function obFrameSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const cands: string[] = [];
  if (el.id && obIsStableToken(el.id)) cands.push(`${tag}[id=${obCssStr(el.id)}]`);
  for (const a of ['name', 'title', 'data-testid']) {
    const v = el.getAttribute(a);
    if (v && (a === 'title' ? obIsStableText(v) : obIsStableToken(v)))
      cands.push(`${tag}[${a}=${obCssStr(v)}]`);
  }
  const src = el.getAttribute('src');
  if (src) {
    const path = src.split(/[?#]/)[0] ?? '';
    if (path && obIsStableHref(path))
      cands.push(`${tag}[src*=${obCssStr(path.replace(/^https?:\/\/[^/]+/, ''))}]`);
  }
  for (const c of cands) {
    const list = obDeepAll(document, c).filter(
      (e) => e.tagName === 'IFRAME' || e.tagName === 'FRAME',
    );
    if (obPickUnique(list) === el) return c;
  }
  return null;
}

/**
 * 顶层视口坐标处的元素（穿透 Shadow DOM）；如果是 iframe，返回 iframe 与换算到其内部的坐标。
 * 结果取最近的可交互祖先（含推断的可操作元素），没有则取元素本身。
 */
export function obElementAtPoint(
  x: number,
  y: number,
): { el: Element | null; iframe: Element | null; ix: number; iy: number } {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { el: null, iframe: null, ix: 0, iy: 0 };
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const ix = x - r.left - parseFloat(st.borderLeftWidth) - parseFloat(st.paddingLeft);
    const iy = y - r.top - parseFloat(st.borderTopWidth) - parseFloat(st.paddingTop);
    return { el: null, iframe: el, ix, iy };
  }
  let cur: Element | null = el;
  while (cur) {
    if (obIsInteractive(cur) || cur.hasAttribute('data-obact-kind'))
      return { el: cur, iframe: null, ix: 0, iy: 0 };
    cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host || null);
  }
  return { el, iframe: null, ix: 0, iy: 0 };
}

export const LOCATOR_LIB = [
  obCssStr,
  obIsStableHref,
  obCssCandidates,
  obCssPicks,
  obRolePicks,
  obGenLocator,
  obFrameSelector,
  obElementAtPoint,
];
