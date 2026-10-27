import type { Action, ActResult, Assert, AssertionResult, WaitFor } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Page } from 'puppeteer-core';
import { asObactError, ObactError } from '../errors.ts';
import type { Session } from '../session.ts';
import { checkAssertions } from './assert.ts';
import { Aborted, type ActOptions, type Ctx, Effects, fail, makeCtx } from './ctx.ts';
import { HANDLERS, newPage, shotPath } from './ops.ts';
import { dialogBlocked, pendingOf, stalledError, stateOf } from './state.ts';
import { sleep, within } from './util.ts';

export type { ActOptions, ObscuredInfo } from './ctx.ts';
export { currentActionSeq } from './state.ts';

/** FR-14：没有后置检查时的短时稳定等待上限。 */
const SETTLE_CAP_MS = 5000;
/** 后置检查、wait_for 的轮询间隔。 */
const POLL_MS = 50;

/** 需要把鼠标事件送进页面的动作：后台标签页收不到鼠标事件，要先切到前台。 */
const POINTER_OPS = new Set([
  'click',
  'hover',
  'drag',
  'click_at',
  'mouse_move',
  'scroll',
  'upload_file',
]);

/** 标签页在后台（document 不可见）时切到前台，等到可见。键盘与脚本类动作不需要。 */
async function ensureForeground(page: Page): Promise<void> {
  const vis = await within(
    page.evaluate(() => document.visibilityState),
    1000,
    'visible',
  ).catch(() => 'visible');
  if (vis === 'visible') return;
  await page.bringToFront().catch(() => {});
  await within(
    page.waitForFunction(() => document.visibilityState === 'visible', { timeout: 1000 }),
    1200,
    null,
  ).catch(() => {});
}

/** 期限过后探测页面是否响应：探测求值在这个时间内不返回，就当作主线程无响应。 */
const STALL_PROBE_MS = 1000;
/** 页面有响应时，隔多久再探测一次。 */
const STALL_RECHECK_MS = 1000;
const STALLED = Symbol('stalled');

/**
 * 页面主线程被对话框（含同进程的其他标签页的对话框）、长任务占住时，页面里的 CDP 调用（定位、可操作性检查、
 * 输入派发、截图）都不会返回，一直等到协议超时（180 秒）。动作的期限过后仍没结束，就探测一次页面：
 * 探测也不返回才算无响应（页面有响应时，长文本输入这类正常耗时不受期限限制）。stop 在动作结束时调用。
 */
function watchStall(ctx: Ctx, page: Page): { stalled: Promise<typeof STALLED>; stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<typeof STALLED>((resolve) => {
    const check = async () => {
      if (stopped || page.isClosed()) return;
      let up = false;
      try {
        up = await within(
          page.mainFrame().evaluate(() => true),
          STALL_PROBE_MS,
          false,
        ).catch(() => true);
      } catch {
        up = true;
      }
      if (stopped) return;
      if (!up) return resolve(STALLED);
      timer = setTimeout(check, STALL_RECHECK_MS);
    };
    timer = setTimeout(check, Math.max(0, ctx.deadline - Date.now()));
  });
  return {
    stalled,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** 页面无响应：悬空的处理函数在下一步检查时停下，之后不再读页面。 */
function stall(ctx: Ctx, page: Page): ObactError {
  ctx.aborted = true;
  ctx.stalled = true;
  return stalledError(ctx.s, ctx.st, page, ctx.timeout);
}

let contracts: Contracts | null = null;

/** 轮询检查项直到全部通过或到期；返回最后一次的结果。 */
async function pollChecks(
  ctx: Ctx,
  checks: AssertionResult[] | Parameters<typeof checkAssertions>[2],
  deadline: number,
): Promise<{ results: AssertionResult[]; pass: boolean }> {
  const opts = {
    signatures: ctx.opts.signatures,
    matchSignature: ctx.opts.matchSignature,
    timeoutMs: Math.max(200, deadline - Date.now()),
  };
  for (;;) {
    ctx.alive();
    const results = await checkAssertions(ctx.s, ctx.pageId, checks, opts);
    const pass = results.every((r) => r.pass);
    if (pass || Date.now() >= deadline) return { results, pass };
    await sleep(POLL_MS);
  }
}

/** wait_for：直到 until 全部满足（FR-14），超时报 timeout。 */
async function waitFor(ctx: Ctx): Promise<void> {
  const a = ctx.action as Action & WaitFor;
  ctx.wait = 'none';
  const r = await pollChecks(ctx, a.until, Date.now() + ctx.timeout);
  ctx.assertions = r.results;
  if (!r.pass) {
    const failed = r.results
      .filter((x) => !x.pass)
      .map((x) => x.detail ?? '')
      .filter(Boolean);
    fail(
      'timeout',
      `等待 ${ctx.timeout} 毫秒后条件仍未满足${failed.length ? `：${failed.join('；')}` : ''}`,
    );
  }
}

/** assert：只判定一次，任一不通过报 assertion_failed。 */
async function assertOnce(ctx: Ctx): Promise<void> {
  const a = ctx.action as Action & Assert;
  ctx.wait = 'none';
  const results = await checkAssertions(ctx.s, ctx.pageId, a.checks, {
    signatures: ctx.opts.signatures,
    matchSignature: ctx.opts.matchSignature,
    timeoutMs: ctx.timeout,
  });
  ctx.assertions = results;
  if (!results.every((r) => r.pass)) fail('assertion_failed', '断言未通过');
}

async function runOp(ctx: Ctx, fx: Effects): Promise<void> {
  const op = ctx.action.op;
  if (op === 'wait_for') return waitFor(ctx);
  if (op === 'assert') return assertOnce(ctx);
  if (op === 'extract') {
    fail('invalid_params', 'extract（页面抽取与接口截获）在 M2 实现');
  }
  const h = HANDLERS[op];
  if (!h) fail('invalid_params', `未知动作：${op}`);
  return h(ctx, fx);
}

function emptyEffects(ctx: Ctx): ActResult['effects'] {
  return {
    navigated: ctx.navigated,
    new_pages: [...ctx.newPages],
    dialogs: ctx.dialogs,
    changed: ctx.navigated,
  };
}

/**
 * 执行一个动作（FR-12~FR-15、FR-32；契约 action.json → act-result.json）。不向外抛异常：
 * 失败都以 status:'error' 返回，error.code 取自契约的错误码。
 *
 * 流程：校验参数 → 页面上有未处理的对话框则除 handle_dialog 外一律报 dialog_blocking →
 * 执行（定位、可操作性检查、可信输入）→ 等待（有后置检查就轮询到通过；否则按动作类型做短时稳定等待
 * 或只等一帧）→ 汇总效果（导航、新标签页、对话框、页面变化、可选的文本差异与截图）。
 * 动作执行中弹出对话框时（页面脚本被挂起），只要输入已经派发就算执行完成，对话框记为 pending；
 * 输入还没派发、或 wait_for / assert / 后置检查正在判定条件时，报 dialog_blocking（条件未验证）。
 */
export async function act(s: Session, action: Action, opts: ActOptions = {}): Promise<ActResult> {
  const started = Date.now();
  const st = stateOf(s);
  const seq = ++st.seq;
  contracts ??= new Contracts();
  const invalid = contracts.check('action', action);
  const ctx = makeCtx(s, st, action, opts, seq);
  const done = (
    effects: ActResult['effects'],
    diff: string | null | undefined,
    err?: ObactError,
  ) => {
    const r: ActResult = {
      status: err ? 'error' : 'ok',
      locator_used: ctx.locator,
      duration_ms: Date.now() - started,
      screenshot_path: ctx.screenshot,
      effects,
      action_seq: seq,
    };
    // 所有失败统一带 details.dispatched（输入是否已经派发）：工作流的单次提交据此区分“可能已发出”与“确定没发出”；
    // 个别错误点自己写了的（如后置检查期间的 dialog_blocking）以它为准
    if (err) {
      const e = err.toJSON();
      r.error = { ...e, details: { dispatched: ctx.dispatched, ...e.details } };
    }
    if (ctx.assertions) r.assertions = ctx.assertions;
    if (diff !== undefined) r.diff = diff;
    if (ctx.data !== undefined) r.data = ctx.data;
    return r;
  };
  if (invalid) {
    const msg = contracts.ajv.errorsText(invalid.slice(0, 3));
    return done(
      emptyEffects(ctx),
      undefined,
      new ObactError('invalid_params', `动作参数不符合契约：${msg}`),
    );
  }

  let fx: Effects | null = null;
  try {
    if (action.op === 'new_page') {
      await newPage(ctx);
    } else {
      const page = s.pages.get(ctx.pageId);
      ctx.page = page;
      const pend = pendingOf(st, page);
      if (pend && action.op !== 'handle_dialog' && action.op !== 'close_page') {
        throw dialogBlocked(pend);
      }
      if (!pend && POINTER_OPS.has(action.op)) await ensureForeground(page);
      fx = new Effects(ctx, page);
      // 有待处理的对话框时页面脚本被挂起，在页面里取值会一直等到超时；handle_dialog 关闭对话框后再开始记录
      if (!pend) {
        await fx.track(page.mainFrame());
        if (action.diff) await fx.captureTextBefore();
      }

      const run = runOp(ctx, fx);
      const guard = watchStall(ctx, page);
      const first = await Promise.race([
        run.then(() => null),
        fx.dialogOpened,
        guard.stalled,
      ]).finally(guard.stop);
      if (first === STALLED) {
        throw stall(ctx, page);
      } else if (first) {
        // 页面脚本被对话框挂起，输入派发要等对话框处理后才返回：留给 handle_dialog 收尾
        ctx.aborted = true;
        st.inflight.set(
          page,
          run.catch(() => {}),
        );
        // wait_for、assert 没有页面副作用，不算已执行：条件没验证出结果，处理对话框后重新判定
        if (!ctx.dispatched) {
          const poll = action.op === 'wait_for' || action.op === 'assert';
          throw dialogBlocked(
            first,
            poll
              ? '条件尚未验证，请先 handle_dialog 再重新判定'
              : '动作尚未执行，请先 handle_dialog',
          );
        }
      } else if (action.post?.length) {
        // 轮询期间页面弹出对话框：检查的求值要等对话框处理后才返回，不等到期
        const polled = pollChecks(ctx, action.post, Date.now() + ctx.timeout);
        const r = await Promise.race([polled, fx.dialogOpened]);
        if (!('results' in r)) {
          ctx.aborted = true;
          polled.catch(() => {});
          throw dialogBlocked(
            r,
            '动作已执行，后置检查尚未验证，请先 handle_dialog，不要重复执行动作',
            {
              dispatched: true,
            },
          );
        }
        ctx.assertions = r.results;
        if (!r.pass) fail('assertion_failed', '后置检查未通过');
      } else if (ctx.wait === 'action') {
        await fx.settle(Math.min(SETTLE_CAP_MS, ctx.timeout));
      } else if (ctx.wait === 'input') {
        await fx.waitFrame(Math.min(SETTLE_CAP_MS, ctx.timeout));
      }
    }
    if (action.screenshot && ctx.page && !ctx.page.isClosed() && !pendingOf(st, ctx.page)) {
      const { path, type } = shotPath(ctx);
      const guard = watchStall(ctx, ctx.page);
      const shot = await Promise.race([ctx.page.screenshot({ path, type }), guard.stalled]).finally(
        guard.stop,
      );
      if (shot === STALLED) throw stall(ctx, ctx.page);
      ctx.screenshot = path;
    }
    const fin = fx ? await fx.finish() : { ...emptyEffects(ctx), diff: undefined };
    const { diff, ...effects } = fin;
    return done(effects, diff);
  } catch (e) {
    const err =
      e instanceof Aborted ? new ObactError('dialog_blocking', e.message) : asObactError(e);
    let effects = emptyEffects(ctx);
    let diff: string | null | undefined;
    if (fx) {
      const fin = await fx.finish().catch(() => null);
      if (fin) ({ diff, ...effects } = fin);
    }
    return done(effects, diff, err);
  }
}
