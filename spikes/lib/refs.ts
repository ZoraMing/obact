// 预研：把编号写进元素属性（参考 BrowserGym），并检查各视图编号一致、编号绑定具体节点。
import type { CDPSession, Frame, Page } from 'puppeteer-core';

export const ATTR = 'data-obact-ref';

const INTERACTIVE_ROLES = [
  'button',
  'link',
  'checkbox',
  'radio',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
];

/** 在 frame 的页面环境中运行：遍历文档与开放的 Shadow DOM，给尚未编号的可交互元素写编号。 */
function markInPage(start: number, attr: string, roles: string[]) {
  const selector = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    ...roles.map((r) => `[role="${r}"]`),
  ].join(',');
  let next = start;
  const marked: { ref: number; tag: string; text: string }[] = [];
  const visit = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector) && !el.hasAttribute(attr)) {
        el.setAttribute(attr, String(next));
        const text = (el as HTMLElement).innerText || (el as HTMLInputElement).value || '';
        marked.push({ ref: next, tag: el.tagName.toLowerCase(), text: text.trim().slice(0, 30) });
        next++;
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return { next, marked };
}

/** Puppeteer 没有公开 OOPIF 判断；本机站点下按源判断即可（站点隔离按站点分进程）。 */
export function isCrossOrigin(page: Page, frame: Frame): boolean {
  return new URL(frame.url()).origin !== new URL(page.url()).origin;
}

export async function markFrames(page: Page, start: number) {
  let next = start;
  const frames: { url: string; crossOrigin: boolean; marked: number }[] = [];
  for (const frame of page.frames()) {
    const r = await frame.evaluate(markInPage, next, ATTR, INTERACTIVE_ROLES);
    next = r.next;
    frames.push({
      url: frame.url(),
      crossOrigin: isCrossOrigin(page, frame),
      marked: r.marked.length,
    });
  }
  return { next, frames };
}

type DomNode = {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: (DomNode & { shadowRootType?: string })[];
  contentDocument?: DomNode;
};

const CDP_INTERACTIVE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'SUMMARY']);

/** 页面脚本进不去封闭的 Shadow DOM；用 CDP 的 DOM.getDocument(pierce) 找到并写编号。 */
export async function markClosedShadow(cdp: CDPSession, start: number) {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
    root: DomNode;
  };
  let next = start;
  const marked: number[] = [];
  const walk = async (node: DomNode, inClosed: boolean) => {
    const attrs = node.attributes ?? [];
    if (inClosed && CDP_INTERACTIVE.has(node.nodeName) && !attrs.includes(ATTR)) {
      await cdp.send('DOM.setAttributeValue', {
        nodeId: node.nodeId,
        name: ATTR,
        value: String(next),
      });
      marked.push(next++);
    }
    for (const sr of node.shadowRoots ?? [])
      await walk(sr, inClosed || sr.shadowRootType === 'closed');
    for (const c of node.children ?? []) await walk(c, inClosed);
    if (node.contentDocument) await walk(node.contentDocument, false);
  };
  await walk(root, false);
  return { next, marked };
}

type Snapshot = {
  documents: {
    frameId: number;
    nodes: { backendNodeId: number[]; attributes: number[][]; nodeName: number[] };
  }[];
  strings: string[];
};

/** DOMSnapshot 一次取回同进程所有文档（含 Shadow DOM），建立 编号 → backendNodeId。 */
export async function snapshotRefs(cdp: CDPSession) {
  const snap = (await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [],
  })) as unknown as Snapshot;
  const refToNode = new Map<number, number>();
  const nodeToRef = new Map<number, number>();
  for (const doc of snap.documents) {
    doc.nodes.attributes.forEach((attrs, i) => {
      for (let k = 0; k < attrs.length; k += 2) {
        if (snap.strings[attrs[k] as number] === ATTR) {
          const ref = Number(snap.strings[attrs[k + 1] as number]);
          const backend = doc.nodes.backendNodeId[i] as number;
          refToNode.set(ref, backend);
          nodeToRef.set(backend, ref);
        }
      }
    });
  }
  return { refToNode, nodeToRef, documents: snap.documents.length };
}

type AXNode = { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number };

/** 可访问性树里的可交互节点，是否都能对上同一个编号。 */
export async function axConsistency(cdp: CDPSession, nodeToRef: Map<number, number>) {
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
  const interactive = nodes.filter((n) => INTERACTIVE_ROLES.includes(n.role?.value ?? ''));
  const missing = interactive
    .filter((n) => !n.backendDOMNodeId || !nodeToRef.has(n.backendDOMNodeId))
    .map((n) => `${n.role?.value} "${n.name?.value ?? ''}"`);
  return { axNodes: nodes.length, interactive: interactive.length, missing };
}

/** 按属性找编号：节点被克隆重绘后，新节点带着旧属性也会被找到（误命中）。 */
export async function findByAttr(frame: Frame, ref: number) {
  return frame.evaluate(
    (attr, r) => {
      const el = document.querySelector(`[${attr}="${r}"]`);
      return el ? (el as HTMLElement).innerText : null;
    },
    ATTR,
    ref,
  );
}

/** 按 backendNodeId 找编号：节点被替换后能判断为失效。 */
export async function resolveBound(cdp: CDPSession, backendNodeId: number) {
  try {
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId })) as {
      object: { objectId: string };
    };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.isConnected; }',
      returnByValue: true,
    })) as { result: { value: boolean } };
    return result.value ? 'connected' : 'stale';
  } catch {
    return 'stale';
  }
}
