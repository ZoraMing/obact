import type { ActResult } from '@obact/schemas';
import type { Dialog, Page, Target } from 'puppeteer-core';
import type { Session } from '../session.ts';

export type DialogInfo = ActResult['effects']['dialogs'][number];
export type DialogType = DialogInfo['type'];

/** 未处理的对话框。JS 对话框是模态的：它打开期间页面脚本停住，页面内求值和输入派发都会挂起。 */
export type PendingDialog = { page: Page; dialog: Dialog; type: DialogType; message: string };

/** 会话内 act 的状态：动作序号、对话框、被对话框打断而悬空的输入派发。 */
export type ActState = {
  /** 每个会话递增的动作序号（PRD 5.6：接口缓存按它判定响应先后）。 */
  seq: number;
  pending: PendingDialog[];
  /** 动作执行期间订阅对话框出现。 */
  hooks: Set<(d: PendingDialog) => void>;
  /** 被对话框打断的动作：对话框处理后它的输入派发才会返回。 */
  inflight: WeakMap<Page, Promise<unknown>>;
  watched: WeakSet<Page>;
};

const states = new WeakMap<Session, ActState>();

const TYPES = new Set<string>(['alert', 'confirm', 'prompt', 'beforeunload']);

export function stateOf(s: Session): ActState {
  let st = states.get(s);
  if (st) return st;
  const state: ActState = {
    seq: 0,
    pending: [],
    hooks: new Set(),
    inflight: new WeakMap(),
    watched: new WeakSet(),
  };
  st = state;
  states.set(s, st);
  // 新标签页尽早挂上对话框监听（弹出页一打开就 alert 的情况）
  const onTarget = (t: Target) => {
    if (t.type() !== 'page') return;
    void t
      .page()
      .then((p) => p && watchPage(state, p))
      .catch(() => {});
  };
  s.browser.on('targetcreated', onTarget);
  return st;
}

/** 给页面挂对话框监听（每个页面一次）：对话框一律先记为未处理，由 handle_dialog 处理（FR-12）。 */
export function watchPage(st: ActState, page: Page): void {
  if (st.watched.has(page)) return;
  st.watched.add(page);
  page.on('dialog', (dialog: Dialog) => {
    const type = (TYPES.has(dialog.type()) ? dialog.type() : 'alert') as DialogType;
    const d: PendingDialog = { page, dialog, type, message: dialog.message() };
    st.pending.push(d);
    for (const h of st.hooks) h(d);
  });
  page.once('close', () => {
    st.pending = st.pending.filter((d) => d.page !== page);
  });
}

/** 页面上第一个未处理的对话框。 */
export function pendingOf(st: ActState, page: Page): PendingDialog | undefined {
  return st.pending.find((d) => d.page === page);
}

export function dropPending(st: ActState, d: PendingDialog): void {
  st.pending = st.pending.filter((x) => x !== d);
}

/** 当前的动作序号（接口缓存等模块读取；还没有动作时为 0）。 */
export function currentActionSeq(s: Session): number {
  return states.get(s)?.seq ?? 0;
}
