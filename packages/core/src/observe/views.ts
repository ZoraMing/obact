/**
 * observe 的附加视图（FR-31）：视口截图、编号框截图、可访问性树文本。
 * 截图坐标与 bbox 同一坐标系（顶层视口 CSS 像素），截图像素 = CSS 像素 × viewport.scale。
 */
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CDPSession, Frame, Page } from 'puppeteer-core';
import { bundle } from '../page/bundle.ts';
import { DOM_LIB } from '../page/dom.ts';
import { OBS_LIB, obsSomHide, obsSomShow } from './page.ts';

const SOM_SHOW = bundle(obsSomShow, [...DOM_LIB, ...OBS_LIB]);
const SOM_HIDE = bundle(obsSomHide, [...DOM_LIB, ...OBS_LIB]);

/** 截图默认目录：系统临时目录下的 obact-shots/。 */
export function defaultShotDir(): string {
  return join(tmpdir(), 'obact-shots');
}

let seq = 0;

async function shotFile(dir: string | undefined, pageId: string, suffix: string): Promise<string> {
  const d = resolve(dir ?? defaultShotDir());
  await mkdir(d, { recursive: true });
  return join(d, `${pageId}-${Date.now()}-${++seq}${suffix}.png`);
}

/** 视口截图，返回文件路径。 */
export async function takeScreenshot(page: Page, pageId: string, dir?: string): Promise<string> {
  const path = await shotFile(dir, pageId, '');
  await page.screenshot({ path, type: 'png' });
  return path;
}

export type SomBox = { ref: number; x: number; y: number; w: number; h: number };

/**
 * 编号框截图：在顶层文档注入 position:fixed、pointer-events:none 的覆盖层（不改变布局），
 * 给可见元素画框并标上与文本快照相同的编号；截图后一定移除，出错也移除。
 */
export async function takeSom(
  page: Page,
  pageId: string,
  boxes: SomBox[],
  dir?: string,
): Promise<string> {
  const path = await shotFile(dir, pageId, '-som');
  const main = page.mainFrame();
  try {
    await main.evaluate(SOM_SHOW, boxes);
    await page.screenshot({ path, type: 'png' });
  } finally {
    await main.evaluate(SOM_HIDE).catch(() => {});
  }
  return path;
}

type AXValue = { value?: unknown };
type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
};
type Snapshot = {
  documents: { nodes: { backendNodeId: number[]; attributes: number[][] } }[];
  strings: string[];
};

/** Puppeteer 未公开的 frame 内部字段：frame 自己 target 的 CDP 会话（OOPIF 为独立会话）与 frameId。 */
type FrameInternals = { client?: CDPSession; _id?: string };

const FLATTEN = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'Unknown']);
const PROPS = ['checked', 'pressed', 'expanded', 'selected', 'disabled', 'required', 'level'];

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** 用 DOMSnapshot 读出每个节点的编号属性：backendNodeId → 编号。 */
async function refsByBackend(client: CDPSession, attr: string): Promise<Map<number, number>> {
  const snap = (await client.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [],
  })) as unknown as Snapshot;
  const attrIdx = snap.strings.indexOf(attr);
  const out = new Map<number, number>();
  if (attrIdx < 0) return out;
  for (const doc of snap.documents) {
    const { backendNodeId, attributes } = doc.nodes;
    attributes.forEach((attrs, i) => {
      for (let k = 0; k < attrs.length; k += 2) {
        if (attrs[k] !== attrIdx) continue;
        const ref = Number(snap.strings[attrs[k + 1] as number]);
        if (ref) out.set(backendNodeId[i] as number, ref);
      }
    });
  }
  return out;
}

/**
 * 可访问性树文本（view=axtree）：只在请求时取（M0 预研：全量取树开销大），受字符预算限制。
 * 节点的编号由 DOMSnapshot 按 backendDOMNodeId 读编号属性得到，只标出 elements 中列出的编号，保证一致；
 * 子 frame 的树接在它的 iframe 节点下（OOPIF 用它自己的 CDP 会话）。
 */
export async function axtreeText(
  page: Page,
  frames: Frame[],
  attr: string,
  listed: Set<number>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  type FrameTree = { nodes: AXNode[]; refs: Map<number, number>; owner?: number };
  const snapshots = new Map<CDPSession, Promise<Map<number, number>>>();
  const trees = new Map<Frame, FrameTree>();
  await Promise.all(
    frames.map(async (frame) => {
      const { client, _id: frameId } = frame as unknown as FrameInternals;
      if (!client || !frameId || frame.detached) return;
      let refs = snapshots.get(client);
      if (!refs) {
        refs = refsByBackend(client, attr);
        snapshots.set(client, refs);
      }
      const parent = frame.parentFrame() as unknown as FrameInternals | null;
      const [map, ax, owner] = await Promise.all([
        refs,
        client.send('Accessibility.getFullAXTree', { frameId }) as Promise<{ nodes: AXNode[] }>,
        parent?.client
          ? parent.client
              .send('DOM.getFrameOwner', { frameId })
              .then((r) => r.backendNodeId)
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ]).catch(() => [null, null, undefined] as const);
      if (map && ax) trees.set(frame, { nodes: ax.nodes, refs: map, owner });
    }),
  );

  const out: string[] = [];
  let used = 0;
  let truncated = false;
  const push = (line: string) => {
    if (truncated) return;
    if (used + line.length + 1 > cap - 40) {
      truncated = true;
      out.push('…（可访问性树已截断：超出字符预算）');
      return;
    }
    out.push(line);
    used += line.length + 1;
  };
  const rendered = new Set<Frame>();
  const render = (frame: Frame, depth: number) => {
    const tree = trees.get(frame);
    if (!tree || rendered.has(frame)) return;
    rendered.add(frame);
    const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
    // 本 frame 中各 iframe 节点下的子 frame
    const kids = new Map<number, Frame[]>();
    for (const f of frames) {
      const owner = trees.get(f)?.owner;
      if (f.parentFrame() === frame && owner !== undefined) {
        kids.set(owner, [...(kids.get(owner) ?? []), f]);
      }
    }
    const rec = (id: string, d: number, parentName: string) => {
      if (truncated) return;
      const n = byId.get(id);
      if (!n) return;
      const role = String(n.role?.value ?? '');
      if (role === 'InlineTextBox' || role === 'LineBreak') return;
      const name = String(n.name?.value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const ref = n.backendDOMNodeId === undefined ? undefined : tree.refs.get(n.backendDOMNodeId);
      const isListed = ref !== undefined && listed.has(ref);
      let show = true;
      if (role === 'StaticText') {
        if (!name || parentName.includes(name)) return;
      } else if (!isListed && (n.ignored || (FLATTEN.has(role) && !name))) show = false;
      if (show) {
        const props = (n.properties ?? [])
          .filter((p) => PROPS.includes(p.name) && p.value.value !== false)
          .map((p) => `${p.name}=${String(p.value.value)}`);
        push(
          `${'  '.repeat(d)}${isListed ? `[${ref}] ` : ''}${role}${name ? ` ${quote(cut(name, 100))}` : ''}${props.length ? ` ${props.join(' ')}` : ''}`,
        );
      }
      const next = show ? d + 1 : d;
      for (const c of n.childIds ?? []) rec(c, next, show ? name : parentName);
      const sub = n.backendDOMNodeId === undefined ? undefined : kids.get(n.backendDOMNodeId);
      for (const f of sub ?? []) render(f, next);
    };
    const root = tree.nodes.find((n) => !n.parentId) ?? tree.nodes[0];
    if (root) rec(root.nodeId, depth, '');
  };
  const main = page.mainFrame();
  render(main, 0);
  // 没能接到 iframe 节点下的子 frame（如 iframe 节点被忽略）放在最后
  for (const f of frames) if (!rendered.has(f) && trees.has(f)) render(f, 0);
  return { text: out.join('\n'), truncated };
}
