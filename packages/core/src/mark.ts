import type { CDPSession, Frame, Page } from 'puppeteer-core';
import { bundle } from './page/bundle.ts';
import { DOM_LIB, obMark } from './page/dom.ts';
import type { Session } from './session.ts';

const MARK = bundle(obMark, DOM_LIB);

export type FrameRefs = { frame: Frame; refs: number[]; added: number[] };

type DomNode = {
  nodeId: number;
  children?: DomNode[];
  shadowRoots?: (DomNode & { shadowRootType?: string })[];
  contentDocument?: DomNode;
};

/**
 * 把封闭的 Shadow Root 挂到宿主元素的不可枚举属性 __obactClosedRoot 上，让页面内助手能遍历到。
 * 只处理与主文档同进程的文档；跨域 iframe（OOPIF）内的封闭 Shadow DOM 暂不支持。
 * 返回挂上的数量。
 */
export async function exposeClosedShadowRoots(page: Page): Promise<number> {
  const cdp: CDPSession = await page.createCDPSession();
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    const pairs: [number, number][] = [];
    const walk = (n: DomNode) => {
      for (const sr of n.shadowRoots ?? []) {
        if (sr.shadowRootType === 'closed') pairs.push([n.nodeId, sr.nodeId]);
        walk(sr);
      }
      for (const c of n.children ?? []) walk(c);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(root);
    for (const [hostId, rootId] of pairs) {
      const host = await cdp.send('DOM.resolveNode', { nodeId: hostId });
      const sr = await cdp.send('DOM.resolveNode', { nodeId: rootId });
      if (!host.object.objectId || !sr.object.objectId) continue;
      await cdp.send('Runtime.callFunctionOn', {
        objectId: host.object.objectId,
        functionDeclaration:
          'function (r) { Object.defineProperty(this, "__obactClosedRoot", { value: r, configurable: true }); }',
        arguments: [{ objectId: sr.object.objectId }],
      });
    }
    return pairs.length;
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
  opts: { closedShadow?: boolean } = {},
): Promise<FrameRefs[]> {
  const page = s.pages.get(pageId);
  if (opts.closedShadow !== false) await exposeClosedShadowRoots(page);
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
