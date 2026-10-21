import type { ObservedElement, ObserveParams, ObserveResult, PageSignature } from '@obact/schemas';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { asObactError, ObactError } from '../errors.ts';
import { markPage } from '../mark.ts';
import { bundle } from '../page/bundle.ts';
import { DOM_LIB } from '../page/dom.ts';
import type { Session } from '../session.ts';
import { applyBudget, type Item, NAME_MAX } from './format.ts';
import {
  type FrameCollect,
  OBS_LIB,
  obsCollect,
  obsHitOwner,
  obsIntersect,
  obsOwnerInfo,
  type RawElement,
  type Rect,
  type TextLine,
} from './page.ts';
import { matchSignature } from './signature.ts';
import { axtreeText, type SomBox, takeScreenshot, takeSom } from './views.ts';

export type ObserveOptions = {
  /** 页面签名（FR-08）；命中的 ID 写入 result.signature。 */
  signatures?: PageSignature[];
  /** 截图类视图（screenshot、som）的保存目录；省略时用系统临时目录下的 obact-shots/。 */
  outDir?: string;
};

/** 字符预算默认值（FR-05）与下限（契约 observe.json）。 */
const DEFAULT_MAX_CHARS = 40000;
const MIN_MAX_CHARS = 1000;

/**
 * Canvas 告警阈值（FR-11）：可见 canvas 覆盖视口面积的比例。常见后台页里单个图表一般不到视口的 30%；
 * 超过 40% 时页面主体多半是 Canvas 绘制（大图表、白板、游戏、Flutter 等），元素列表不能代表页面内容。
 */
export const CANVAS_WARN_RATIO = 0.4;

/** 页面内收集的限制：选项数（契约上限 100）、名称与值长度、表格与列表保留的行数、卡片类文字阈值。 */
const LIMITS = {
  optionLimit: 100,
  nameMax: 150,
  valueMax: 200,
  tableRows: 20,
  listItems: 30,
  // 与 snapshot_text 里名称的显示上限一致：文字超过它时名称在快照里是截断的，内容仍作为信息输出
  longText: NAME_MAX,
};

const VIEWS = new Set(['text', 'screenshot', 'som', 'axtree']);
const LIB = [...DOM_LIB, ...OBS_LIB];
const COLLECT = bundle(obsCollect, LIB);
const OWNER = bundle(obsOwnerInfo, LIB);
const HIT_OWNER = bundle(obsHitOwner, LIB);

/** 一个 frame 在顶层视口中的位置。 */
type Geo = {
  frame: Frame;
  parent: Geo | null;
  /** 父 frame 中的 iframe 元素。 */
  owner: ElementHandle<Element> | null;
  /** 本 frame 视口原点在顶层视口中的坐标。 */
  ox: number;
  oy: number;
  /** 顶层坐标中的可见区域（逐级与 iframe 内容区、祖先裁剪求交）。 */
  clip: Rect;
  rendered: boolean;
  /** iframe 选择器链（契约 Element.frame）。 */
  chain: string[];
  /** 在父文档 iframe 列表中的序号；顶层为 -1。 */
  index: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 每个 frame 算一次偏移：iframe 内容区（边框、内边距之内）在父 frame 中的位置逐级累加。 */
async function frameGeometry(page: Page, frames: Frame[]): Promise<Map<Frame, Geo>> {
  const main = page.mainFrame();
  const [vw, vh] = await main.evaluate(() => [innerWidth, innerHeight]);
  const infos = new Map<
    Frame,
    { owner: ElementHandle<Element>; info: Awaited<ReturnType<typeof obsOwnerInfo>> }
  >();
  await Promise.all(
    frames
      .filter((f) => f !== main)
      .map(async (f) => {
        const owner = (await f.frameElement().catch(() => null)) as ElementHandle<Element> | null;
        if (!owner) return;
        const info = await owner.evaluate(OWNER).catch(() => null);
        if (info) infos.set(f, { owner, info });
        else await owner.dispose();
      }),
  );
  const geos = new Map<Frame, Geo>();
  geos.set(main, {
    frame: main,
    parent: null,
    owner: null,
    ox: 0,
    oy: 0,
    clip: [0, 0, vw as number, vh as number],
    rendered: true,
    chain: [],
    index: -1,
  });
  const resolve = (f: Frame): Geo | null => {
    const known = geos.get(f);
    if (known) return known;
    const pf = f.parentFrame();
    const it = infos.get(f);
    if (!pf || !it) return null;
    const p = resolve(pf);
    if (!p) return null;
    const { box, clip, rendered, selector, index } = it.info;
    const ox = p.ox + box[0];
    const oy = p.oy + box[1];
    let c = obsIntersect(p.clip, [ox, oy, box[2], box[3]]);
    if (clip) c = obsIntersect(c, [clip[0] + p.ox, clip[1] + p.oy, clip[2], clip[3]]);
    const g: Geo = {
      frame: f,
      parent: p,
      owner: it.owner,
      ox,
      oy,
      clip: c,
      rendered: p.rendered && rendered,
      chain: [...p.chain, selector],
      index,
    };
    geos.set(f, g);
    return g;
  };
  for (const f of frames) resolve(f);
  for (const [f, it] of infos) if (!geos.has(f)) await it.owner.dispose();
  return geos;
}

/**
 * iframe 内元素的可点击性还要在各级父文档里复核：命中点落在 iframe 上，没有被父文档的遮罩挡住。
 */
async function recheckFrameHits(geos: Map<Frame, Geo>, outs: Map<Frame, FrameCollect>) {
  await Promise.all(
    [...outs].map(async ([frame, out]) => {
      const g = geos.get(frame);
      if (!g?.parent) return;
      const idx = out.elements.flatMap((e, i) => (e.clickable && e.pt ? [i] : []));
      if (!idx.length) return;
      let ok = idx.map(() => true);
      for (let cur: Geo = g; cur.parent && cur.owner; cur = cur.parent) {
        const p = cur.parent;
        const pts = idx.map((i) => {
          const pt = (out.elements[i] as RawElement).pt as [number, number];
          return [pt[0] + g.ox - p.ox, pt[1] + g.oy - p.oy] as [number, number];
        });
        const res = await cur.owner.evaluate(HIT_OWNER, pts).catch(() => null);
        ok = ok.map((v, k) => v && res?.[k] === true);
      }
      idx.forEach((i, k) => {
        if (!ok[k]) (out.elements[i] as RawElement).clickable = false;
      });
    }),
  );
}

/** 页面内结果 → 契约元素（bbox 换算到顶层视口）。 */
function toItem(raw: RawElement, g: Geo): Item {
  const el: ObservedElement = {
    ref: raw.ref,
    role: raw.role,
    name: raw.name,
    actions: raw.actions as ObservedElement['actions'],
  } as ObservedElement;
  if (raw.value !== undefined) el.value = raw.value;
  if (raw.inputType !== undefined) el.input_type = raw.inputType;
  if (raw.href !== undefined) el.href = raw.href;
  if (raw.options) el.options = raw.options;
  if (raw.omitted) el.options_omitted = raw.omitted;
  if (raw.states) el.states = raw.states as ObservedElement['states'];
  el.bbox = [
    round1(raw.rect[0] + g.ox),
    round1(raw.rect[1] + g.oy),
    round1(raw.rect[2]),
    round1(raw.rect[3]),
  ];
  el.visible_ratio = raw.ratio;
  el.clickable = raw.clickable;
  if (raw.within) el.within = raw.within;
  if (g.chain.length) el.frame = g.chain;
  const item: Item = { el };
  if (raw.kind) item.kind = raw.kind;
  if (raw.placeholder) item.placeholder = raw.placeholder;
  if (raw.scroll) item.scroll = raw.scroll;
  if (raw.hint) {
    el.hint = raw.hint;
    item.hint = raw.hint;
  }
  return item;
}

/** 把各 frame 的结果按文档位置拼起来：子 frame 的元素插回 iframe 所在位置，文本替换占位行。 */
function assemble(
  main: Frame,
  geos: Map<Frame, Geo>,
  outs: Map<Frame, FrameCollect>,
): { items: Item[]; lines: TextLine[] } {
  const kids = new Map<Frame, Geo[]>();
  for (const g of geos.values()) {
    if (!g.parent || !outs.has(g.frame)) continue;
    kids.set(g.parent.frame, [...(kids.get(g.parent.frame) ?? []), g]);
  }
  const rec = (frame: Frame): { items: Item[]; lines: TextLine[] } => {
    const out = outs.get(frame) as FrameCollect;
    const g = geos.get(frame) as Geo;
    const children = (kids.get(frame) ?? []).sort((a, b) => a.index - b.index);
    const sub = new Map<number, { items: Item[]; lines: TextLine[] }>();
    const at = new Map<number, Item[]>();
    const tail: { items: Item[]; lines: TextLine[] }[] = [];
    for (const c of children) {
      const r = rec(c.frame);
      const pos = out.slots[c.index];
      if (pos === undefined) {
        tail.push(r);
        continue;
      }
      sub.set(c.index, r);
      at.set(pos, [...(at.get(pos) ?? []), ...r.items]);
    }
    const items: Item[] = [];
    out.elements.forEach((raw, i) => {
      items.push(...(at.get(i) ?? []), toItem(raw, g));
    });
    items.push(...(at.get(out.elements.length) ?? []));
    const lines: TextLine[] = [];
    const placed = new Set<number>();
    for (const l of out.lines) {
      if (l.f === undefined) lines.push(l);
      else if (sub.has(l.f)) {
        lines.push(...(sub.get(l.f)?.lines ?? []));
        placed.add(l.f);
      }
    }
    // 没有文本占位的子 frame（如 iframe 在 aria-hidden 区域内）：元素已插回，文本放在最后
    for (const [k, r] of sub) if (!placed.has(k)) lines.push(...r.lines);
    for (const r of tail) {
      items.push(...r.items);
      lines.push(...r.lines);
    }
    return { items, lines };
  };
  return outs.has(main) ? rec(main) : { items: [], lines: [] };
}

/**
 * 观察页面（FR-05、FR-06、FR-08、FR-11、FR-31，契约 observe.json）。结果分两部分：
 * - 可操作功能：elements 与 snapshot_text（同一批元素），每个元素带可用操作 actions（与 act 的 op 同名）、
 *   当前值、选项、链接地址、关键状态、包围盒、可见比例、可点击性、所在行（within）与所在 frame；
 * - 纯网页信息：text_md，只放不可操作的内容，表格等内容里出现的可操作元素用 [编号] 引用。
 *
 * 先 markPage 编号，再按 frame 在页面内批量计算（不走可访问性树）；axtree 视图才取可访问性树。
 */
export async function observe(
  s: Session,
  params: ObserveParams,
  opts: ObserveOptions = {},
): Promise<ObserveResult> {
  const views = new Set<string>(params.views ?? ['text']);
  for (const v of views) {
    if (!VIEWS.has(v)) throw new ObactError('invalid_params', `未知的观察形式：${v}`, { view: v });
  }
  const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS) {
    throw new ObactError('invalid_params', `max_chars 必须是不小于 ${MIN_MAX_CHARS} 的整数`, {
      max_chars: maxChars,
    });
  }
  const { pageId } = params;
  const page = s.pages.get(pageId);
  const main = page.mainFrame();
  const marked = await markPage(s, pageId);
  const geos = await frameGeometry(
    page,
    marked.map((m) => m.frame),
  );
  try {
    const outs = new Map<Frame, FrameCollect>();
    await Promise.all(
      marked.map(async ({ frame, refs }) => {
        const g = geos.get(frame);
        if (!g?.rendered) return;
        const clip: Rect = [g.clip[0] - g.ox, g.clip[1] - g.oy, g.clip[2], g.clip[3]];
        try {
          const out = await frame.evaluate(COLLECT, {
            attr: s.attr,
            key: s.refKey,
            refs,
            clip,
            ...LIMITS,
          });
          outs.set(frame, out);
        } catch (e) {
          // 子 frame 可能正在导航或已移除，跳过；顶层文档失败则报错
          if (frame === main) throw asObactError(e);
        }
      }),
    );
    await recheckFrameHits(geos, outs);
    const { items, lines } = assemble(main, geos, outs);
    const mainOut = outs.get(main) as FrameCollect;
    const vp = mainOut.viewport;
    let canvas = 0;
    for (const out of outs.values()) canvas += out.canvasArea;

    const url = page.url();
    const [title, sig] = await Promise.all([
      page.title(),
      opts.signatures?.length ? matchSignature(s, pageId, opts.signatures) : null,
    ]);
    const budget = applyBudget(items, lines, maxChars, url);
    const result: ObserveResult = {
      pageId,
      url,
      title,
      signature: sig?.id ?? null,
      canvas_warning: canvas / Math.max(1, vp.width * vp.height) > CANVAS_WARN_RATIO,
    } as ObserveResult;
    if (views.has('text')) result.snapshot_text = budget.snapshot;
    result.elements = budget.items.map((it) => it.el);
    result.text_md = budget.text;
    result.truncated = budget.truncated;
    result.viewport = {
      width: Math.max(1, Math.round(vp.width)),
      height: Math.max(1, Math.round(vp.height)),
      scale: vp.scale > 0 ? vp.scale : 1,
    };
    if (views.has('screenshot')) {
      result.screenshot_path = await takeScreenshot(page, pageId, opts.outDir);
    }
    if (views.has('som')) {
      const boxes: SomBox[] = [];
      for (const { el } of budget.items) {
        if (el.visible_ratio <= 0) continue;
        const r = obsIntersect(el.bbox as Rect, [0, 0, vp.width, vp.height]);
        if (r[2] > 0 && r[3] > 0) boxes.push({ ref: el.ref, x: r[0], y: r[1], w: r[2], h: r[3] });
      }
      result.som_path = await takeSom(page, pageId, boxes, opts.outDir);
    }
    if (views.has('axtree')) {
      // 敏感字段取页面内收集的全集（含被预算截掉、零尺寸而没列入 elements 的）
      const sensitive = new Set([...outs.values()].flatMap((out) => out.sensitive));
      const ax = await axtreeText(
        page,
        marked.map((m) => m.frame),
        s.attr,
        new Set(result.elements.map((e) => e.ref)),
        maxChars,
        sensitive,
      );
      result.axtree = ax.text;
      if (ax.truncated) result.truncated = true;
    }
    return result;
  } finally {
    await Promise.all(
      [...geos.values()].map((g) => (g.owner ? g.owner.dispose().catch(() => {}) : null)),
    );
  }
}
