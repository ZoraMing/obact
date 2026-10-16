import type { Locator, Target } from '@obact/schemas';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { ObactError } from './errors.ts';
import { exposeForMarking } from './mark.ts';
import { bundle } from './page/bundle.ts';
import { DOM_LIB, obDeepAll, obFindRef, obPickUnique, obResolve } from './page/dom.ts';
import type { Session } from './session.ts';

export type Resolved = {
  handle: ElementHandle<Element>;
  frame: Frame;
  via: 'ref' | 'css' | 'role';
};

const FIND_REF = bundle(obFindRef, DOM_LIB);
const RESOLVE = bundle(obResolve, DOM_LIB);
const FIND_FRAME_OWNER = bundle(function findOwner(selector: string) {
  const list = obDeepAll(document, selector).filter(
    (e) => e.tagName === 'IFRAME' || e.tagName === 'FRAME',
  );
  return { el: obPickUnique(list), count: list.length };
}, DOM_LIB);

/** 按目标找元素：编号（会话内）或定位器（持久）。 */
export async function resolveTarget(s: Session, pageId: string, target: Target): Promise<Resolved> {
  if (target.ref !== undefined) return resolveRef(s, pageId, target.ref);
  const { ref: _ref, ...loc } = target;
  return resolveLocator(s, pageId, loc as Locator);
}

/** 按编号找元素；节点已失效时报 stale_ref，绝不退而去找别的元素（FR-06）。 */
export async function resolveRef(s: Session, pageId: string, ref: number): Promise<Resolved> {
  const entry = s.refs.get(ref);
  if (!entry) {
    throw new ObactError('stale_ref', `编号 ${ref} 不是本会话分配的，请重新 observe`, { ref });
  }
  if (entry.pageId !== pageId) {
    throw new ObactError('invalid_params', `编号 ${ref} 属于标签页 ${entry.pageId}`, {
      ref,
      pageId,
    });
  }
  s.pages.get(pageId);
  if (entry.frame.detached) {
    throw new ObactError('stale_ref', `编号 ${ref} 所在的 frame 已移除，请重新 observe`, { ref });
  }
  const h = await entry.frame.evaluateHandle(FIND_REF, ref, s.attr, s.refKey).catch(() => null);
  const el = h?.asElement() as ElementHandle<Element> | null | undefined;
  if (!el) {
    await h?.dispose();
    throw new ObactError('stale_ref', `编号 ${ref} 对应的节点已失效，请重新 observe`, { ref });
  }
  return { handle: el, frame: entry.frame, via: 'ref' };
}

/** 按 iframe 选择器链从顶层进入目标 frame。 */
export async function frameFor(page: Page, chain: string[] = []): Promise<Frame> {
  let frame = page.mainFrame();
  for (const selector of chain) {
    const h = await frame.evaluateHandle(FIND_FRAME_OWNER, selector);
    const owner = (await h.getProperty('el')).asElement() as ElementHandle<Element> | null;
    const count = await h.evaluate((o) => o.count);
    await h.dispose();
    if (!owner) {
      throw new ObactError(count ? 'not_unique' : 'not_found', `找不到唯一的 iframe：${selector}`, {
        frame: selector,
        count,
      });
    }
    const child = await owner.contentFrame();
    await owner.dispose();
    if (!child)
      throw new ObactError('not_found', `iframe 尚未加载：${selector}`, { frame: selector });
    frame = child;
  }
  return frame;
}

/** 各标签页上次挂出封闭影子根的时间：找不到元素的轮询里不要每次都做一次 DOMSnapshot。 */
const exposedAt = new WeakMap<Page, number>();
const EXPOSE_GAP_MS = 500;

/** 按定位器找元素（FR-07）：不唯一报 not_unique，找不到报 not_found。 */
export async function resolveLocator(s: Session, pageId: string, loc: Locator): Promise<Resolved> {
  const page = s.pages.get(pageId);
  const frame = await frameFor(page, loc.frame);
  const { frame: _f, ...inFrame } = loc;
  const run = async () => {
    const h = await frame.evaluateHandle(RESOLVE, inFrame);
    const info = await h.evaluate((r) => ({ via: r.via, reason: r.reason, counts: r.counts }));
    const el = (await h.getProperty('el')).asElement() as ElementHandle<Element> | null;
    await h.dispose();
    return { el, info };
  };
  let { el, info } = await run();
  // 封闭的 Shadow Root 页面脚本看不到，只有挂出来才能被遍历（编号前会做一次）。回放定位器时页面不一定观察过，
  // 找不到就先挂出来再试一次
  if (!el && info.reason === 'not_found') {
    const last = exposedAt.get(page) ?? 0;
    if (Date.now() - last >= EXPOSE_GAP_MS) {
      exposedAt.set(page, Date.now());
      const n = await exposeForMarking(page, { clickListeners: false }).catch(() => null);
      if (n?.closedRoots) ({ el, info } = await run());
    }
  }
  if (!el || !info.via) {
    if (info.reason === 'conflict') {
      throw new ObactError('not_unique', '定位器的 CSS 与 角色+名称 指向不同元素，页面可能已改版', {
        locator: loc,
        counts: info.counts,
        conflict: true,
      });
    }
    const code = info.reason === 'not_unique' ? 'not_unique' : 'not_found';
    throw new ObactError(code, `定位器${code === 'not_unique' ? '不唯一' : '找不到元素'}`, {
      locator: loc,
      counts: info.counts,
    });
  }
  return { handle: el, frame, via: info.via };
}
