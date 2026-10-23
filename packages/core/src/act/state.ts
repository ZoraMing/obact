import type { ActResult } from '@obact/schemas';
import type { Dialog, Page } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
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

/** 会话的 act 状态：Session 构造时建好，并在标签页登记时给每个页面挂上对话框监听（见 session.ts）。 */
export function stateOf(s: Session): ActState {
  let st = states.get(s);
  if (st) return st;
  st = {
    seq: 0,
    pending: [],
    hooks: new Set(),
    inflight: new WeakMap(),
    watched: new WeakSet(),
  };
  states.set(s, st);
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

/**
 * 页面上有未处理对话框时的错误（act 与 observe 共用）：页面脚本被挂起，要先 handle_dialog。
 * note 说明当时动作进行到哪一步（默认只提示先处理对话框），extra 并入 details。
 */
export function dialogBlocked(
  d: PendingDialog,
  note = '请先 handle_dialog',
  extra?: Record<string, unknown>,
): ObactError {
  return new ObactError(
    'dialog_blocking',
    `页面上有未处理的 ${d.type} 对话框：“${d.message}”，${note}`,
    { dialog: { type: d.type, message: d.message }, ...extra },
  );
}

/**
 * 页面主线程无响应的超时错误。没有本页的对话框记录时，多半是别的标签页的对话框（同进程的弹窗会连带挂住打开者）
 * 或页面里的长任务：别的标签页有未处理的对话框时，在 details 里带上它们的 pageId 与类型。
 */
export function stalledError(s: Session, st: ActState, page: Page, ms: number): ObactError {
  const others = st.pending
    .filter((d) => d.page !== page)
    .map((d) => ({ pageId: s.pages.idOf(d.page), type: d.type, message: d.message }));
  let msg = `页面主线程无响应（等待 ${ms} 毫秒），可能被对话框挂起，可 handle_dialog 或 close_page`;
  if (others.length) {
    const who = others.map((d) => `${d.pageId}（${d.type}）`).join('、');
    msg += `；其他标签页有未处理的对话框：${who}，同进程的页面会被它挂住，请先在该页 handle_dialog`;
  }
  return new ObactError('timeout', msg, others.length ? { dialogs: others } : undefined);
}

/**
 * 页面内的调用在页面被对话框挂起时不会返回（直到 CDP 的协议超时）：与本页出现对话框、期限竞争，先到者胜出。
 * 对话框先出现报 dialog_blocking；到期仍没结束报 timeout。被放弃的调用仍在后台跑完，结果与错误都丢弃。
 */
export function raceDialog<T>(
  s: Session,
  st: ActState,
  page: Page,
  start: () => Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      st.hooks.delete(onDialog);
      clearTimeout(timer);
    };
    const onDialog = (d: PendingDialog) => {
      if (d.page !== page) return;
      done();
      reject(dialogBlocked(d));
    };
    const timer = setTimeout(() => {
      done();
      reject(stalledError(s, st, page, ms));
    }, ms);
    st.hooks.add(onDialog);
    start().then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

/** 当前的动作序号（接口缓存等模块读取；还没有动作时为 0）。 */
export function currentActionSeq(s: Session): number {
  return states.get(s)?.seq ?? 0;
}
