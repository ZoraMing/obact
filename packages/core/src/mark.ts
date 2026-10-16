import type { CDPSession, Frame, Page } from 'puppeteer-core';
import { bundle } from './page/bundle.ts';
import { DOM_LIB, obMark } from './page/dom.ts';
import type { Session } from './session.ts';

const MARK = bundle(obMark, DOM_LIB);

export type FrameRefs = { frame: Frame; refs: number[]; added: number[] };

type Snapshot = {
  documents: {
    nodes: {
      parentIndex: number[];
      backendNodeId: number[];
      nodeName: number[];
      attributes: number[][];
      isClickable?: { index: number[] };
      shadowRootType?: { index: number[]; value: number[] };
    };
  }[];
  strings: string[];
};

/** 原生可交互标签：不需要再打点击监听标记（<a> 只在有 href 时算原生可交互，单独判断）。 */
const NATIVE = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'SUMMARY',
  'LABEL',
  'HTML',
  'BODY',
]);

const SET_CLOSED_ROOT =
  'function () { const r = this.getRootNode(); if (r instanceof ShadowRoot) Object.defineProperty(r.host, "__obactClosedRoot", { value: r, configurable: true }); }';
const SET_CLICKABLE =
  'function () { Object.defineProperty(this, "__obactClickable", { value: true, configurable: true }); }';

/**
 * 编号前用一次 DOMSnapshot 补齐页面脚本看不到的信息（只处理与主文档同进程的文档，OOPIF 内暂不支持）：
 * - 封闭的 Shadow Root：挂到宿主元素的不可枚举属性 __obactClosedRoot 上，让页面内助手能遍历；
 * - 绑定了点击类监听（click、mousedown、pointerdown 等）的非原生元素：打上不可枚举标记 __obactClickable，
 *   让它们算作可交互（Vue、jQuery 等直接绑定事件的自绘控件）。事件委托到根节点的框架（如 React）
 *   看不到监听，由页面内的 cursor:pointer 推断兜底（obInferredKind）。
 */
export async function exposeForMarking(
  page: Page,
  opts: { closedShadow?: boolean; clickListeners?: boolean } = {},
): Promise<{ closedRoots: number; clickable: number }> {
  const cdp: CDPSession = await page.createCDPSession();
  try {
    const snap = (await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
    })) as unknown as Snapshot;
    const roots: number[] = [];
    const clickable: number[] = [];
    for (const doc of snap.documents) {
      const n = doc.nodes;
      if (opts.closedShadow !== false) {
        // DOMSnapshot 不输出影子根节点本身：影子树内的节点直接挂在宿主下，并标注 shadowRootType。
        // 取每个宿主下第一层的封闭影子节点，到页面里用 getRootNode() 拿到影子根。
        const sr = n.shadowRootType;
        const closed = new Set<number>();
        sr?.index.forEach((i, k) => {
          if (snap.strings[sr.value[k] as number] === 'closed') closed.add(i);
        });
        const hosts = new Set<number>();
        for (const i of closed) {
          const parent = n.parentIndex[i] as number;
          if (parent < 0 || closed.has(parent) || hosts.has(parent)) continue;
          hosts.add(parent);
          roots.push(n.backendNodeId[i] as number);
        }
      }
      if (opts.clickListeners !== false) {
        for (const i of n.isClickable?.index ?? []) {
          const name = snap.strings[n.nodeName[i] as number] ?? '';
          if (NATIVE.has(name)) continue;
          if (name === 'A') {
            const attrs = n.attributes[i] ?? [];
            let hasHref = false;
            for (let k = 0; k < attrs.length; k += 2) {
              if (snap.strings[attrs[k] as number] === 'href') hasHref = true;
            }
            if (hasHref) continue;
          }
          // 带非交互角色的容器（如可拖拽的 dialog、事件委托的 tablist）也算：它们确实响应点击
          clickable.push(n.backendNodeId[i] as number);
        }
      }
    }
    const resolve = async (backendNodeId: number) =>
      (await cdp.send('DOM.resolveNode', { backendNodeId }).catch(() => null))?.object.objectId;
    for (const id of roots) {
      const obj = await resolve(id);
      if (obj)
        await cdp.send('Runtime.callFunctionOn', {
          objectId: obj,
          functionDeclaration: SET_CLOSED_ROOT,
        });
    }
    for (const id of clickable) {
      const obj = await resolve(id);
      if (obj)
        await cdp.send('Runtime.callFunctionOn', {
          objectId: obj,
          functionDeclaration: SET_CLICKABLE,
        });
    }
    return { closedRoots: roots.length, clickable: clickable.length };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * 给标签页内所有 frame 的可交互元素编号（会话内递增、不复用），并登记到编号表。
 * 返回每个 frame 内当前有效的全部编号（按文档顺序）。
 */
export async function markPage(
  s: Session,
  pageId: string,
  opts: { closedShadow?: boolean; clickListeners?: boolean } = {},
): Promise<FrameRefs[]> {
  const page = s.pages.get(pageId);
  if (opts.closedShadow !== false || opts.clickListeners !== false) {
    await exposeForMarking(page, opts);
  }
  const out: FrameRefs[] = [];
  for (const frame of page.frames()) {
    if (frame.detached) continue;
    const r = await frame.evaluate(MARK, s.attr, s.refKey, s.refs.next).catch(() => null);
    if (!r) continue; // frame 在编号过程中被移除或尚未就绪
    s.refs.commit(r.next, r.added, pageId, frame);
    out.push({ frame, refs: r.refs, added: r.added });
  }
  return out;
}
