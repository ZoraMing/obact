import type { Locator, ResolveLocatorResult } from '@obact/schemas';
import type { ElementHandle, Frame } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import { DOM_LIB, obName, obRole } from '../page/dom.ts';
import { resolveLocator, resolveRef } from '../resolve.ts';
import type { Session } from '../session.ts';
import { LOCATOR_LIB, obElementAtPoint, obFrameSelector, obGenLocator } from './page.ts';

const LIB = [...DOM_LIB, ...LOCATOR_LIB];
const GEN = bundle(obGenLocator, LIB);
const FRAME_SELECTOR = bundle(obFrameSelector, LIB);
const AT_POINT = bundle(obElementAtPoint, LIB);
const META = bundle((e: Element) => ({ role: obRole(e), name: obName(e) }), LIB);

/** 从元素所在 frame 往上，为每级 iframe 生成稳定选择器；有一级做不到则返回 null。 */
async function frameChain(frame: Frame): Promise<string[] | null> {
  const chain: string[] = [];
  let cur: Frame | null = frame;
  while (cur?.parentFrame()) {
    const owner = await cur.frameElement();
    if (!owner) return null;
    const sel = await owner.evaluate(FRAME_SELECTOR);
    await owner.dispose();
    if (!sel) return null;
    chain.unshift(sel);
    cur = cur.parentFrame();
  }
  return chain;
}

/**
 * 按元素句柄生成持久定位器（FR-07，录制器也用它）：生成后用 resolveLocator 实测，
 * 必须解析回同一个元素才算 unique。
 */
export async function generateLocatorForHandle(
  s: Session,
  pageId: string,
  frame: Frame,
  handle: ElementHandle<Element>,
): Promise<ResolveLocatorResult> {
  const gen = await handle.evaluate(GEN);
  const locator: Locator = { ...gen.locator } as Locator;
  let unique = gen.unique;
  const chain = await frameChain(frame);
  if (chain === null) unique = false;
  else if (chain.length) locator.frame = chain;
  if (unique) {
    const back = await resolveLocator(s, pageId, locator).catch(() => null);
    const same = back ? await handle.evaluate((a, b) => a === b, back.handle) : false;
    await back?.handle.dispose();
    if (!same) unique = false;
  }
  return { locator, unique };
}

/** 把编号转成持久定位器并实测唯一性（方法 resolve_locator）。 */
export async function generateLocator(
  s: Session,
  pageId: string,
  ref: number,
): Promise<ResolveLocatorResult> {
  const r = await resolveRef(s, pageId, ref);
  try {
    return await generateLocatorForHandle(s, pageId, r.frame, r.handle);
  } finally {
    await r.handle.dispose();
  }
}

/**
 * 顶层视口坐标处元素的定位器（FR-32：坐标步骤固化时尽量换算成定位器）。
 * 穿透 iframe 与 Shadow DOM，取最近的可交互祖先；取不到元素返回 null。
 */
export async function locatorAtPoint(
  s: Session,
  pageId: string,
  x: number,
  y: number,
): Promise<(ResolveLocatorResult & { role: string; name: string }) | null> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ObactError('invalid_params', '坐标必须是有限数值');
  }
  let frame = s.pages.get(pageId).mainFrame();
  let px = x;
  let py = y;
  for (let depth = 0; depth < 10; depth++) {
    const h = await frame.evaluateHandle(AT_POINT, px, py);
    const info = await h.evaluate((r) => ({ ix: r.ix, iy: r.iy, hasFrame: Boolean(r.iframe) }));
    if (info.hasFrame) {
      const owner = (await h.getProperty('iframe')).asElement() as ElementHandle<Element> | null;
      await h.dispose();
      const child = await owner?.contentFrame();
      await owner?.dispose();
      if (!child) return null;
      frame = child;
      px = info.ix;
      py = info.iy;
      continue;
    }
    const el = (await h.getProperty('el')).asElement() as ElementHandle<Element> | null;
    await h.dispose();
    if (!el) return null;
    try {
      const meta = await el.evaluate(META);
      const res = await generateLocatorForHandle(s, pageId, frame, el);
      return { ...res, ...meta };
    } finally {
      await el.dispose();
    }
  }
  return null;
}
