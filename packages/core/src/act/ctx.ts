import type { Action, ActResult, AssertionResult, PageSignature } from '@obact/schemas';
import type { Frame, HTTPRequest, Page, Target as PTarget } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import type { Session } from '../session.ts';
import { ACT_DEPS, obActText, obActTrack, obActTrackRead } from './page.ts';
import type { ActState, DialogInfo, PendingDialog } from './state.ts';
import { sleep, textDiff, within } from './util.ts';

const TRACK = bundle(obActTrack, ACT_DEPS);
const TRACK_READ = bundle(obActTrackRead, ACT_DEPS);
const TEXT = bundle(obActText, ACT_DEPS);
const RAF = () =>
  new Promise<void>((r) => {
    requestAnimationFrame(() => r());
  });

/** 被遮挡时交给调用方的信息（M3 的弹窗规则接在 onObscured 上）。 */
export type ObscuredInfo = {
  pageId: string;
  op: string;
  /** 本动作的目标（按坐标的动作为 null）。 */
  target: unknown;
  /** 顶层视口坐标。 */
  point: [number, number];
  /** 点击点上实际命中的元素简述。 */
  hit: string;
  /** 第几次不符（1 起）。 */
  attempt: number;
};

export type ActOptions = {
  /** 上传等文件路径的根（工作区）；越出报 path_outside_workspace。 */
  filesRoot?: string;
  /** 截图目录；省略时用系统临时目录下的 obact-shots。 */
  outDir?: string;
  /** 被遮挡时的回调：返回 true 表示已处理（如关掉了弹窗），随后重试当前动作；已处理的不计入连续不符的次数（最多处理 10 轮）。 */
  onObscured?: (info: ObscuredInfo) => boolean | Promise<boolean>;
  /** 页面签名（assertion 的 signature 检查用，FR-08）。 */
  signatures?: PageSignature[];
  /** 签名判定函数；省略时按签名规则做最小判定（URL、标题、必须存在/不存在的元素）。 */
  matchSignature?: (
    s: Session,
    pageId: string,
    signatures: PageSignature[],
  ) => Promise<PageSignature | null>;
  /** 默认超时（毫秒）：定位、可操作性、后置检查、等待、导航；动作的 timeout_ms 优先。默认 5000。 */
  timeoutMs?: number;
};

/** 等待方式（FR-14）：action 做短时稳定等待；input 只等一帧；none 不等。 */
export type WaitKind = 'action' | 'input' | 'none';

/** 动作被对话框打断：悬空的处理函数在下一步检查时停下。 */
export class Aborted extends Error {}

/** 一次 act 调用的上下文：处理函数在这里登记结果与进度。 */
export type Ctx = {
  s: Session;
  st: ActState;
  action: Action;
  opts: ActOptions;
  pageId: string;
  page: Page | null;
  seq: number;
  timeout: number;
  /** 定位与可操作性等待的期限。 */
  deadline: number;
  locator: ActResult['locator_used'];
  wait: WaitKind;
  /** 输入是否已经派发（之后被对话框打断时，动作本身算已执行）。 */
  dispatched: boolean;
  aborted: boolean;
  /** 页面主线程无响应（期限过后探测不返回）：之后不再读取页面。 */
  stalled: boolean;
  data?: unknown;
  screenshot: string | null;
  assertions?: AssertionResult[];
  /** 导航类动作直接声明发生了导航。 */
  navigated: boolean;
  /** 动作本身已知会改变页面（如 handle_dialog 让被挂起的页面脚本继续）。 */
  changed: boolean;
  newPages: string[];
  dialogs: DialogInfo[];
  /** 需要记录变化的 frame（主 frame 与目标所在 frame）。 */
  tracked: Set<Frame>;
  /** 动作开始后才确定的标签页（new_page）。 */
  alive(): void;
  /**
   * 输入即将派发：先确认动作没被对话框打断（悬空的处理函数到这里停下，不会在 handle_dialog 之后补发输入），
   * 再置 dispatched；检查与置位之间不能有 await。已经派发过的动作被对话框打断后由 handle_dialog 收尾，
   * 后续的派发照常进行（页面无响应而放弃的动作除外）。
   */
  dispatch(): void;
};

export function makeCtx(
  s: Session,
  st: ActState,
  action: Action,
  opts: ActOptions,
  seq: number,
): Ctx {
  // 契约校验在此之后才做：action 可能是 null、undefined 等非法值，取值不能抛异常
  const raw = action as { timeout_ms?: number; pageId?: string } | null | undefined;
  const timeout = raw?.timeout_ms ?? opts.timeoutMs ?? 5000;
  const ctx: Ctx = {
    s,
    st,
    action,
    opts,
    pageId: raw?.pageId ?? '',
    page: null,
    seq,
    timeout,
    deadline: Date.now() + timeout,
    locator: null,
    wait: 'none',
    dispatched: false,
    aborted: false,
    stalled: false,
    screenshot: null,
    navigated: false,
    changed: false,
    newPages: [],
    dialogs: [],
    tracked: new Set(),
    alive() {
      if (ctx.aborted) throw new Aborted('动作已被对话框打断');
    },
    dispatch() {
      if (!ctx.dispatched || ctx.stalled) ctx.alive();
      ctx.dispatched = true;
    },
  };
  return ctx;
}

/** 页面内记录变化用的键名（含会话随机串与动作序号：规则里嵌套的 act 不会清掉外层动作的记录）。 */
function trackKey(ctx: Ctx): string {
  return `__obactTrack_${ctx.s.key}_${ctx.seq}`;
}

/**
 * 动作效果的记录（FR-15）：主 frame 导航、新标签页、对话框、DOM/URL 变化。
 * begin 在派发前调用；finish 在等待结束后调用。
 */
export class Effects {
  readonly ctx: Ctx;
  readonly page: Page;
  readonly #mark: number;
  readonly #url: string;
  readonly #navReqs = new Set<HTTPRequest>();
  #committed = false;
  #targets: Promise<Page | null>[] = [];
  #textBefore: string | null = null;
  /** 本动作所在页面出现对话框时 resolve。 */
  readonly dialogOpened: Promise<PendingDialog>;
  #onDialog: (d: PendingDialog) => void = () => {};
  readonly #onRequest = (r: HTTPRequest) => {
    if (r.isNavigationRequest() && r.frame() === this.page.mainFrame()) this.#navReqs.add(r);
  };
  readonly #onRequestDone = (r: HTTPRequest) => {
    this.#navReqs.delete(r);
  };
  readonly #onNavigated = (f: Frame) => {
    if (f === this.page.mainFrame()) this.#committed = true;
  };
  readonly #onTarget = (t: PTarget) => {
    if (t.type() === 'page') this.#targets.push(t.page().catch(() => null));
  };

  constructor(ctx: Ctx, page: Page) {
    this.ctx = ctx;
    this.page = page;
    this.#mark = ctx.s.pages.mark();
    this.#url = page.url();
    this.dialogOpened = new Promise((resolve) => {
      this.#onDialog = (d) => {
        ctx.dialogs.push({ type: d.type, message: d.message, handled: 'pending' });
        if (d.page === page) resolve(d);
      };
    });
    ctx.st.hooks.add(this.#onDialog);
    page.on('request', this.#onRequest);
    page.on('requestfinished', this.#onRequestDone);
    page.on('requestfailed', this.#onRequestDone);
    page.on('framenavigated', this.#onNavigated);
    ctx.s.browser.on('targetcreated', this.#onTarget);
  }

  /** 开始记录某个 frame 的变化。 */
  async track(frame: Frame): Promise<void> {
    if (this.ctx.tracked.has(frame) || frame.detached) return;
    this.ctx.tracked.add(frame);
    await within(frame.evaluate(TRACK, trackKey(this.ctx)), 2000, false).catch(() => false);
  }

  async captureTextBefore(): Promise<void> {
    this.#textBefore = await pageText(this.page, 200_000);
  }

  /** 主 frame 有导航请求正在进行（已发出、未结束）。 */
  get navPending(): boolean {
    return this.#navReqs.size > 0;
  }

  /** 主 frame 发生过提交（含同文档导航，如 pushState）。 */
  get committed(): boolean {
    return this.#committed;
  }

  /** 页面读不了：有未处理的对话框挡在本页面上，或页面主线程无响应。 */
  get blocked(): boolean {
    return this.ctx.stalled || this.ctx.st.pending.some((d) => d.page === this.page);
  }

  /** 等主 frame 导航结束：导航请求都已结束，且当前文档已解析完（readyState 不是 loading），上限 deadline。 */
  async waitNavigation(deadline: number): Promise<void> {
    while (Date.now() < deadline && !this.blocked && !this.page.isClosed()) {
      if (this.#navReqs.size === 0) {
        const state = await within(
          this.page.mainFrame().evaluate(() => document.readyState),
          Math.max(50, deadline - Date.now()),
          'loading',
        ).catch(() => 'loading');
        if (state !== 'loading') return;
      }
      await sleep(20);
    }
  }

  /** 只等一帧（纯输入类动作，FR-14）；若随之发出了导航请求（如回车提交表单）就等导航结束。 */
  async waitFrame(cap: number): Promise<void> {
    if (this.blocked || this.page.isClosed()) return;
    await within(this.page.mainFrame().evaluate(RAF), 100, null).catch(() => null);
    if (this.navPending) await this.waitNavigation(Date.now() + cap);
  }

  /**
   * 短时稳定等待（FR-14）：DOM 变动静止约 100 毫秒，或主 frame 导航完成，上限 cap 毫秒。
   * 不等网络空闲；周期性刷新的节点不推迟判定（见 obActTrack）。轮询在 Node 侧进行，
   * 不依赖页面计时器（后台标签页的计时器会被节流）。
   */
  async settle(cap: number): Promise<void> {
    const deadline = Date.now() + cap;
    const key = trackKey(this.ctx);
    const main = this.page.mainFrame();
    let reset = true;
    while (Date.now() < deadline) {
      if (this.blocked || this.page.isClosed()) return;
      if (this.navPending) {
        await this.waitNavigation(deadline);
        return;
      }
      let age = Number.POSITIVE_INFINITY;
      for (const f of this.ctx.tracked) {
        if (f.detached) continue;
        const r = await within(
          f.evaluate(TRACK_READ, key, { reset }),
          Math.max(50, deadline - Date.now()),
          null,
        ).catch(() => null);
        if (!r) continue;
        if (r.missing && f === main) {
          // 主文档已被替换（跨文档导航）：等新文档解析完即结束
          await this.waitNavigation(deadline);
          return;
        }
        if (!r.missing) age = Math.min(age, r.age);
      }
      reset = false;
      if (age === Number.POSITIVE_INFINITY || age >= 100) return;
      await sleep(Math.min(100 - age + 5, deadline - Date.now()));
    }
  }

  /** 结束记录，汇总效果。 */
  async finish(): Promise<ActResult['effects'] & { diff?: string | null }> {
    const ctx = this.ctx;
    ctx.st.hooks.delete(this.#onDialog);
    this.page.off('request', this.#onRequest);
    this.page.off('requestfinished', this.#onRequestDone);
    this.page.off('requestfailed', this.#onRequestDone);
    this.page.off('framenavigated', this.#onNavigated);
    ctx.s.browser.off('targetcreated', this.#onTarget);

    // 新标签页：给弹出页一点登记时间（targetcreated 之后才能拿到页面对象）
    const newPages = new Set(ctx.newPages);
    if (this.#targets.length) {
      const pages = await within(Promise.all(this.#targets), 2000, [] as (Page | null)[]);
      for (const p of pages) {
        if (p && !p.isClosed()) {
          try {
            newPages.add(ctx.s.pages.register(p));
          } catch {
            // 已登记或已关闭
          }
        }
      }
    }
    for (const id of ctx.s.pages.createdSince(this.#mark)) newPages.add(id);

    let navigated = ctx.navigated;
    let changed = navigated || ctx.changed;
    const blocked = this.blocked;
    if (!this.page.isClosed() && !blocked) {
      const key = trackKey(ctx);
      for (const f of ctx.tracked) {
        if (f.detached) {
          changed = true;
          continue;
        }
        const r = await within(f.evaluate(TRACK_READ, key, { stop: true }), 2000, null).catch(
          () => null,
        );
        if (!r) continue;
        if (r.missing) {
          changed = true;
          if (f === this.page.mainFrame()) navigated = true;
        } else if (r.muts > 0 || r.inputs > 0) changed = true;
      }
      if (this.page.url() !== this.#url) changed = true;
    } else if (!this.page.isClosed() && this.page.url() !== this.#url) changed = true;

    let diff: string | null | undefined;
    if (ctx.action.diff) {
      if (this.#textBefore !== null && !this.page.isClosed() && !blocked) {
        diff = textDiff(this.#textBefore, await pageText(this.page, 200_000));
      } else diff = null;
    }
    return {
      navigated,
      new_pages: [...newPages],
      dialogs: ctx.dialogs,
      changed,
      diff,
    };
  }
}

/** 主 frame 的可见文本（diff 用）。 */
async function pageText(page: Page, limit: number): Promise<string> {
  return (await within(page.mainFrame().evaluate(TEXT, limit), 3000, '').catch(() => '')) as string;
}

/** 构造 ObactError 的简写。 */
export function fail(
  code: ConstructorParameters<typeof ObactError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ObactError(code, message, details);
}
