import type { Target } from '@obact/schemas';
import type { ElementHandle, Frame } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import { resolveTarget } from '../resolve.ts';
import { type Ctx, type Effects, fail } from './ctx.ts';
import {
  ACT_DEPS,
  obActFrameHit,
  obActFrames,
  obActProbe,
  obActRecheck,
  obActScrollIntoView,
} from './page.ts';
import { sleep } from './util.ts';

const PROBE = bundle(obActProbe, ACT_DEPS);
/** 先等两帧再采样：稳定性判断的第二次采样要反映动画推进后的位置。 */
const PROBE_AFTER_FRAMES = bundle(
  async (el: Element, subject: Element | null, withHit: boolean) => {
    await obActFrames(2);
    return obActProbe(el, subject, withHit);
  },
  ACT_DEPS,
);
const RECHECK = bundle(obActRecheck, ACT_DEPS);
const SCROLL_INTO_VIEW = bundle(obActScrollIntoView, ACT_DEPS);
const FRAME_HIT = bundle(obActFrameHit, ACT_DEPS);

/** 定位结果：元素句柄、所在 frame、命中方式。 */
export type Located = {
  handle: ElementHandle<Element>;
  frame: Frame;
  via: 'ref' | 'css' | 'role';
  target: Target;
};

/** 可操作性检查后得到的派发点：顶层视口坐标与目标 frame 内坐标。 */
export type Point = { x: number; y: number; fx: number; fy: number };

/**
 * 按目标找元素。编号失效立即报 stale_ref（FR-06）；定位器找不到时在期限内轮询（元素可能稍后才渲染），
 * 不唯一立即报错。
 */
export async function locate(ctx: Ctx, target: Target, effects?: Effects): Promise<Located> {
  for (;;) {
    ctx.alive();
    try {
      const r = await resolveTarget(ctx.s, ctx.pageId, target);
      if (effects) await effects.track(r.frame);
      return { ...r, target };
    } catch (e) {
      const code = (e as ObactError).code;
      if (target.ref !== undefined || code !== 'not_found' || Date.now() >= ctx.deadline) throw e;
    }
    await sleep(100);
  }
}

/** 换一个元素作为点击对象（如 label 代点隐藏的复选框）；subject 仍是原目标，用于启用判断与落点核对。 */
export type Subject = { el: ElementHandle<Element>; subject: ElementHandle<Element> | null };

/**
 * 可操作性检查（FR-13）：可见（必要时先滚动到视口）、启用、位置稳定（间隔 50 毫秒两次采样，位移 < 1 像素）、
 * 未被遮挡（在目标 frame 内命中测试，并逐级确认各层 iframe 元素没被遮挡）。
 *
 * - 不可见/禁用直到期限：not_actionable；元素失效：编号目标报 stale_ref，定位器目标重新定位。
 * - 命中不符：先调 onObscured，再重试；连续 3 次不符报 obscured。
 * - move 为 true 时把鼠标移到该点，再在派发前一刻复核一次命中（悬停可能触发重绘或弹层）。
 */
export async function actionable(
  ctx: Ctx,
  loc: Located,
  opts: {
    hitTest?: boolean;
    stable?: boolean;
    move?: boolean;
    who?: Subject;
    /** 连续不符的计数（与派发后的落点防护共用，合计 3 次报错）；省略时本次检查自己计数。 */
    streak?: { n: number };
  } = {},
): Promise<{ point: Point; loc: Located }> {
  const hitTest = opts.hitTest !== false;
  const stable = opts.stable !== false;
  const streak = opts.streak ?? { n: 0 };
  let scrolls = 0;
  let lastState = '';
  const page = ctx.page;
  if (!page) fail('internal', '缺少标签页');
  for (;;) {
    ctx.alive();
    const el = opts.who?.el ?? loc.handle;
    const subject = opts.who?.subject ?? null;
    const p1 = await el.evaluate(PROBE, subject, false).catch(() => null);
    if (!p1?.connected) {
      if (loc.via === 'ref') {
        fail('stale_ref', `编号 ${loc.target.ref} 对应的节点已失效，请重新 observe`, {
          ref: loc.target.ref,
        });
      }
      if (opts.who) fail('not_actionable', '目标元素在操作过程中被移除');
      await loc.handle.dispose().catch(() => {});
      loc = await locate(ctx, loc.target);
      continue;
    }
    if (!p1.visible || !p1.enabled) {
      lastState = !p1.visible ? '不可见' : '已禁用';
      if (Date.now() >= ctx.deadline) {
        fail('not_actionable', `元素${lastState}（等待 ${ctx.timeout} 毫秒）`, {
          reason: !p1.visible ? 'hidden' : 'disabled',
        });
      }
      await sleep(50);
      continue;
    }
    if (!p1.inView) {
      if (scrolls++ >= 3 && Date.now() >= ctx.deadline) {
        fail('not_actionable', '元素无法滚动到视口内', { reason: 'outside_viewport' });
      }
      await el.evaluate(SCROLL_INTO_VIEW, 'center').catch(() => {});
      if (scrolls > 3) await sleep(50);
      continue;
    }
    let p2 = p1;
    if (stable) {
      await sleep(50);
      ctx.alive();
      const again = await el.evaluate(PROBE_AFTER_FRAMES, subject, hitTest).catch(() => null);
      if (!again?.connected) continue;
      p2 = again;
      const moved = p1.rect.some((v, i) => Math.abs(v - (p2.rect[i] as number)) >= 1);
      if (moved || p2.animating || !p2.visible || !p2.inView) {
        if (Date.now() >= ctx.deadline) {
          fail('not_actionable', `元素位置不稳定（等待 ${ctx.timeout} 毫秒）`, {
            reason: 'unstable',
          });
        }
        continue;
      }
    } else if (hitTest) {
      const again = await el.evaluate(PROBE, subject, true).catch(() => null);
      if (!again?.connected || !again.inView) continue;
      p2 = again;
    }
    const hit = p2.hit;
    let point: Point;
    if (hitTest) {
      if (!hit) continue;
      const top = hit.ok ? await liftToTop(loc.frame, hit.x, hit.y) : null;
      if (top && !top.inView) {
        // iframe 本身不在上层视口内：滚动父文档
        if (Date.now() >= ctx.deadline) {
          fail('not_actionable', '元素所在的 iframe 无法滚动到视口内', {
            reason: 'outside_viewport',
          });
        }
        await top.owner?.evaluate(SCROLL_INTO_VIEW, 'nearest').catch(() => {});
        await top.owner?.dispose().catch(() => {});
        continue;
      }
      await top?.owner?.dispose().catch(() => {});
      if (!hit.ok || !top?.ok) {
        streak.n++;
        const desc = hit.ok ? (top?.desc ?? '') : hit.desc;
        const at: [number, number] = top ? [top.x, top.y] : [hit.x, hit.y];
        await obscured(ctx, loc, at, desc, streak.n);
        continue;
      }
      point = { x: top.x, y: top.y, fx: hit.x, fy: hit.y };
    } else {
      const [x, y, w, h] = p2.rect;
      const top = await liftToTop(loc.frame, x + w / 2, y + h / 2, false);
      point = { x: top?.x ?? x + w / 2, y: top?.y ?? y + h / 2, fx: x + w / 2, fy: y + h / 2 };
    }
    if (opts.move) {
      await page.mouse.move(point.x, point.y);
      ctx.alive();
      if (hitTest) {
        const re = await el.evaluate(RECHECK, subject, point.fx, point.fy).catch(() => null);
        if (!re?.ok) {
          streak.n++;
          await obscured(ctx, loc, [point.x, point.y], re?.desc ?? '（节点已变化）', streak.n);
          continue;
        }
      }
    }
    return { point, loc };
  }
}

/** 命中不符：调 onObscured（让调用方处理弹窗等遮挡物）；不抛错。 */
export async function notifyObscured(
  ctx: Ctx,
  loc: Located,
  point: [number, number],
  desc: string,
  attempt: number,
): Promise<void> {
  if (!ctx.opts.onObscured) return;
  const round = (n: number) => Math.round(n * 10) / 10;
  await ctx.opts.onObscured({
    pageId: ctx.pageId,
    op: ctx.action.op,
    target: loc.target,
    point: [round(point[0]), round(point[1])],
    hit: desc,
    attempt,
  });
}

/** 命中不符：调 onObscured；连续 3 次不符报 obscured。 */
async function obscured(
  ctx: Ctx,
  loc: Located,
  point: [number, number],
  desc: string,
  attempt: number,
): Promise<void> {
  await notifyObscured(ctx, loc, point, desc, attempt);
  if (attempt >= 3) {
    const round = (n: number) => Math.round(n * 10) / 10;
    fail('obscured', `目标被遮挡：点击点上是 ${desc}（连续 ${attempt} 次）`, {
      hit: desc,
      point: [round(point[0]), round(point[1])],
    });
  }
}

/**
 * 把目标 frame 内的坐标逐级换算到顶层视口，并确认每一层的 iframe 元素在该点没被遮挡。
 * check 为 false 时只换算坐标。owner 是最后一个没通过的 iframe 元素（用于滚动）。
 */
async function liftToTop(
  frame: Frame,
  x: number,
  y: number,
  check = true,
): Promise<{
  ok: boolean;
  inView: boolean;
  x: number;
  y: number;
  desc: string;
  owner?: ElementHandle<Element>;
} | null> {
  let f = frame;
  let cx = x;
  let cy = y;
  for (let parent = f.parentFrame(); parent; parent = f.parentFrame()) {
    const owner = (await f.frameElement().catch(() => null)) as ElementHandle<Element> | null;
    if (!owner) return null;
    const r = await owner.evaluate(FRAME_HIT, cx, cy).catch(() => null);
    if (!r) {
      await owner.dispose().catch(() => {});
      return null;
    }
    cx = r.x;
    cy = r.y;
    if (check && (!r.inView || !r.ok)) {
      return { ok: false, inView: r.inView, x: cx, y: cy, desc: r.desc, owner };
    }
    await owner.dispose().catch(() => {});
    f = parent;
  }
  return { ok: true, inView: true, x: cx, y: cy, desc: '' };
}

/** 坐标必须在顶层视口内（FR-32）。 */
export async function checkInViewport(ctx: Ctx, x: number, y: number): Promise<void> {
  const page = ctx.page;
  if (!page) return;
  const vp = await page.mainFrame().evaluate(() => [innerWidth, innerHeight] as [number, number]);
  if (!(x >= 0 && y >= 0 && x < vp[0] && y < vp[1])) {
    throw new ObactError(
      'invalid_params',
      `坐标 (${x}, ${y}) 不在视口内（视口 ${vp[0]}×${vp[1]}，单位为 CSS 像素）`,
      { x, y, viewport: vp },
    );
  }
}
