// 工作流解释执行（FR-16~19、FR-25、FR-26，DESIGN 约定 1、5、6、10、11）。
// 只依赖 Executor 接口，不 import @obact/core：executor 与模板抛出的 ObactError 按名字识别；
// 不带 code 的异常（包括测试里模拟崩溃抛的）一律向外抛，相当于进程崩溃，靠检查点续跑。
//
// 结构：exec 按下标解释执行步骤（loop / if 用预先算好的配对表跳转，循环条目用 frames 栈）；
// ordinary 管重试与 on_fail；检查点只由根工作流写，call 的子工作流整体算根工作流的一步。
import { join } from 'node:path';
import { createFiles } from './files.ts';
import { formatDate, Output } from './output.ts';
import { loadParams } from './params.ts';
import { RunStore } from './store.ts';
import { parsePath, redact, renderWithTrace } from './template.ts';
import type {
  Action,
  ActResult,
  Checkpoint,
  Executor,
  RunOptions,
  RunResult,
  RunStats,
  Scope,
  Step,
  UnverifiedRecord,
  Workflow,
} from './types.ts';
import { formatProblems, loadWorkflow, validateWorkflow } from './workflow.ts';

type LoopStep = Extract<Step, { op: 'loop_begin' }>;
type ExtractStep = Extract<Step, { op: 'extract' }>;

/** 失败：executor 的错误（ObactError）和 runner 自己产生的都是这个形状。 */
class Failure extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** 带 code 的错误转成 Failure；其他异常（程序错误、模拟崩溃）原样抛出。 */
function toFail(e: unknown): Failure {
  if (e instanceof Failure) return e;
  if (e instanceof Error && e.name === 'ObactError') {
    const x = e as Error & { code: string; details?: Record<string, unknown> };
    return new Failure(x.code, x.message, x.details);
  }
  throw e;
}

/** 循环的一层：s 是 loop_begin 步骤；begin / end 是 loop_begin / loop_end 的下标，i 是当前条目。 */
type Frame = { s: LoopStep; begin: number; end: number; items: unknown[]; i: number };

/** 一个工作流的执行环境；call 的子工作流有自己的变量与循环栈。 */
type Ctx = {
  wf: Workflow;
  vars: Record<string, unknown>;
  frames: Frame[];
  scope: Scope;
  /** 控制流配对：loop_begin → loop_end；if → else 或 end_if；else → end_if。 */
  lay: Map<number, number>;
  root: boolean;
  depth: number;
};

type Status = 'ok' | 'error' | 'skipped';
type Outcome = { state: Checkpoint['state']; stepId: string; error?: RunResult['error'] };
/** 一次尝试的结果：fail 为空即成功；cond / items 分别是 if 与 loop_begin 的求值结果。 */
type Out = {
  fail?: Failure;
  res?: ActResult;
  cond?: boolean;
  items?: unknown[];
  shown?: string;
  out?: Outcome;
  /** 动作已交给 executor（单次提交据此判断是否可能已发出）。 */
  sent?: boolean;
};
/** 一步处理完的去向：out 终止运行；skipTo 跳到该下标；o 是成功时的结果；都没有表示失败后按 skip 继续。 */
type Next = { out?: Outcome; o?: Out; skipTo?: number };
type NextP = Promise<Next>;

/** 步骤自己的字段，不属于动作（DESIGN 约定 1）。 */
const STEP_ONLY =
  'step_id section pre retry on_fail once_only idempotency_key volatile note opens'.split(' ');
const MAX_CALL_DEPTH = 8;
/** 页面别名的写法，与标签页编号（p 加数字）同形的不算别名。 */
const ALIAS = /^[A-Za-z][A-Za-z0-9_]*$/;
const TAB_ID = /^p\d+$/;

/** 动作已发出、结果未确认的错误码 → 待核实原因（DESIGN 约定 7）。 */
const UNVERIFIED_REASON: Record<string, UnverifiedRecord['reason']> = {
  assertion_failed: 'post_failed',
  timeout: 'post_timeout',
  navigation_failed: 'navigation_lost',
  browser_disconnected: 'browser_lost',
};
/** 动作确定没有发出的错误码：按普通失败处理。 */
const NOT_SENT = new Set(
  'not_found not_unique not_actionable obscured stale_ref invalid_params landing_mismatch page_not_found path_outside_workspace'.split(
    ' ',
  ),
);

/** 单次提交步骤的动作报错时：状态未明的原因；动作确定没发出返回 null。其他错误码无法确认，保守按状态未明。 */
function unverifiedReason(f: Failure): UnverifiedRecord['reason'] | null {
  if (f.code === 'dialog_blocking') return f.details?.dispatched === true ? 'stuck' : null;
  if (NOT_SENT.has(f.code)) return null;
  return UNVERIFIED_REASON[f.code] ?? 'post_failed';
}

/** 终止运行的结果：error.step_id 是出错的步骤。 */
const halt = (
  state: Checkpoint['state'],
  stepId: string,
  code: string,
  message: string,
): Outcome => ({
  state,
  stepId,
  error: { code, message, step_id: stepId },
});

/** 控制流配对（加载时已校验过嵌套）。 */
function pairs(steps: Step[]): Map<number, number> {
  const m = new Map<number, number>();
  const stack: { at: number; els?: number }[] = [];
  steps.forEach((s, i) => {
    const top = stack.at(-1);
    if (s.op === 'loop_begin' || s.op === 'if') stack.push({ at: i });
    else if (s.op === 'else' && top) top.els = i;
    else if ((s.op === 'loop_end' || s.op === 'end_if') && top) {
      stack.pop();
      m.set(top.at, s.op === 'loop_end' ? i : (top.els ?? i));
      if (top.els !== undefined) m.set(top.els, i);
    }
  });
  return m;
}

export async function run(
  workflow: Workflow,
  executor: Executor,
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const { runId, workspace, events, hooks } = options;
  const store = new RunStore(workspace, runId);
  const stats: RunStats = { steps: 0, failed: 0, skipped: 0, unverified: 0, duration_ms: 0 };
  const early = (message: string): RunResult => ({
    state: 'FAILED',
    stats,
    step_id: '',
    error: { code: 'invalid_params', message, step_id: '' },
  });

  const problems = validateWorkflow(workflow);
  if (problems.length > 0) return early(formatProblems(problems));

  const cp = options.resume ? store.readCheckpoint() : null;
  if (options.resume && (!cp || cp.workflow !== workflow.name)) {
    return early(`没有可续跑的检查点：${runId}`);
  }
  if (cp?.state === 'DONE') return { state: 'DONE', stats, step_id: cp.step_id };

  const files = createFiles(workspace);
  const sensitiveVars = new Set<string>();
  /** 页面别名 → 标签页编号；不进检查点，续跑后辅助页不恢复。 */
  const aliases = new Map<string, string>();
  const mode = options.mode ?? cp?.mode ?? workflow.meta.mode ?? 'headless';
  /** 采集输出的日期目录在运行开始时定下，写进检查点，跨午夜续跑也沿用。 */
  const cursor: Record<string, unknown> = { ...cp?.cursor };
  cursor.output_date ??= formatDate();
  let output: Output | undefined;
  const outputs = () =>
    (output ??= new Output(workspace, workflow.name, String(cursor.output_date)));
  /** 续跑时检查点停在 RUNNING 的 once_only 步骤的下标：它可能已经执行了一半。 */
  let crashAt = -1;
  const scopeFor = (w: Workflow, vars: Record<string, unknown>): Scope => {
    const params = loadParams(workspace, w.name, w.meta.site);
    return { param: (n) => params.get(n), vars, file: (p) => files.read(p) };
  };
  // 检查点里没有敏感变量，调用方传入的参数补上
  const vars: Record<string, unknown> = { ...options.vars, ...cp?.vars };
  const mkCtx = (wf: Workflow, vars: Record<string, unknown>, depth: number): Ctx => ({
    wf,
    vars,
    frames: [],
    scope: scopeFor(wf, vars),
    lay: pairs(wf.steps),
    root: depth === 0,
    depth,
  });
  let root: Ctx;
  try {
    root = mkCtx(workflow, vars, 0);
  } catch (e) {
    return early((e as Error).message); // 参数库损坏等
  }

  /** 前置路径是 steps 的开头一段（校验保证），其后是主流程。 */
  const mainAt = workflow.steps.findIndex((x) => x.section !== 'preamble');
  const firstMain = mainAt < 0 ? workflow.steps.length : mainAt;
  /** 连续几条单次提交状态未明（成功一条清零）。 */
  let consecutive = 0;

  // ---------- 留痕与检查点 ----------

  const loopIndex = (c: Ctx): Record<string, number> =>
    Object.fromEntries(c.frames.map((f) => [f.s.step_id, f.i]));

  const loopVars = new Set(workflow.steps.flatMap((x) => (x.op === 'loop_begin' ? [x.as] : [])));

  /**
   * 写检查点（只有根工作流写）。不写的变量：循环变量（续跑时由 over 与 loop_index 重建）、
   * 敏感变量、以及脱敏会改变内容的变量（恢复出来的会是 ***）。
   */
  const save = (c: Ctx, stepId: string, state: Checkpoint['state'] = 'RUNNING'): void => {
    if (!c.root) return;
    const masked = redact(c.vars) as Record<string, unknown>;
    store.writeCheckpoint({
      run_id: runId,
      workflow: workflow.name,
      mode,
      state,
      step_id: stepId,
      loop_index: loopIndex(c),
      vars: Object.fromEntries(
        Object.entries(c.vars).filter(
          ([k, v]) =>
            !loopVars.has(k) &&
            !sensitiveVars.has(k) &&
            JSON.stringify(masked[k]) === JSON.stringify(v),
        ),
      ),
      cursor,
    });
  };

  /** 记一步：steps.log 一行 + step 事件 + 统计。detail 必须是已脱敏的。 */
  const note = (c: Ctx, s: Step, status: Status, since: number, detail = ''): void => {
    const ms = Date.now() - since;
    stats.steps++;
    store.appendStepLog(
      [new Date().toISOString(), s.step_id, s.op, status, `${ms}ms`, detail].join('\t'),
    );
    events?.step?.({
      run_id: runId,
      step_id: s.step_id,
      op: s.op,
      status,
      duration_ms: ms,
      loop: loopIndex(c),
    });
  };

  // ---------- 渲染与动作 ----------

  const render = (c: Ctx, v: unknown) =>
    renderWithTrace(v, c.scope, {
      isSensitive: (kind, name) =>
        kind === 'var' && sensitiveVars.has(String(parsePath(name)?.[0])),
    });

  /** pageId 先按别名解析再当标签页编号（DESIGN 约定 15）。 */
  const page = (id: string): string => {
    const real = id === 'main' ? executor.mainPage() : aliases.get(id);
    if (real === undefined) {
      if (!ALIAS.test(id) || TAB_ID.test(id)) return id;
      throw new Failure('page_not_found', `页面别名 ${id} 没有绑定到任何页面`);
    }
    if (!executor.pageOpen(real)) throw new Failure('page_not_found', `页面 ${id} 已关闭`);
    return real;
  };

  /** 检查项（pre、if、锚点）：渲染模板后交给 executor。 */
  const check = (c: Ctx, pageId: string, checks: NonNullable<Action['post']>) =>
    executor.check(page(pageId), render(c, checks).value as typeof checks);

  /** opens：把动作打开的那一个新标签页绑定到别名。 */
  const bind = (name: string, res: ActResult | undefined): Failure | null => {
    const pages = res?.effects.new_pages ?? [];
    const old = aliases.get(name);
    const bad = (code: string, why: string) =>
      new Failure(code, `opens:${name}：${why}`, { pages });
    if (name === 'main' || TAB_ID.test(name))
      return bad('invalid_params', '别名不可用（main 保留）');
    if (pages.length === 0) return bad('not_found', '动作没有打开新页面');
    if (pages.length > 1) return bad('not_unique', `动作打开了 ${pages.length} 个新页面`);
    if (old !== undefined && executor.pageOpen(old)) {
      return bad('invalid_params', `别名已绑定到仍打开的页面 ${old}`);
    }
    aliases.set(name, pages[0] as string);
    return null;
  };

  /** 渲染动作部分（去掉步骤字段），pageId 解析成真实编号。redacted 是可以写进日志与留痕的版本。 */
  const prepare = (c: Ctx, s: Step) => {
    const a: Record<string, unknown> = { ...s };
    for (const k of STEP_ONLY) delete a[k];
    const r = render(c, a);
    const v = r.value as Record<string, unknown>;
    if (s.op !== 'new_page' && typeof v.pageId === 'string') v.pageId = page(v.pageId);
    return { a: v, redacted: r.redacted };
  };

  const itemsOf = (c: Ctx, s: LoopStep): unknown[] => {
    const items = render(c, s.over).value;
    if (!Array.isArray(items)) {
      throw new Failure('invalid_params', `${s.step_id}：over 渲染结果不是数组`);
    }
    return items;
  };

  /** 留痕失败不应中断运行。 */
  const trace = (c: Ctx, s: Step, action: unknown, result: ActResult): void => {
    try {
      store.appendTrajectory({
        step_id: s.step_id,
        loop_index: loopIndex(c),
        action: action as Action,
        result,
        source: 'workflow',
      });
    } catch {}
  };

  const takeShot = async (s: Step): Promise<string | null> => {
    try {
      return await executor.screenshot(page(s.pageId ?? 'main'), `${s.step_id}_${stats.steps}`);
    } catch {
      return null;
    }
  };

  /** 执行一步的一次尝试：前置检查 → 渲染 → 执行。beforeAct 在动作交给 executor 之前调用。 */
  const doStep = async (c: Ctx, s: Step, beforeAct?: () => void): Promise<Out> => {
    let sent = false;
    try {
      if (s.pre?.length) {
        const r = await check(c, s.pageId ?? 'main', s.pre);
        if (!r.pass) {
          throw new Failure('assertion_failed', `前置检查未通过${r.detail ? `：${r.detail}` : ''}`);
        }
      }
      switch (s.op) {
        case 'loop_begin':
          return { items: itemsOf(c, s) };
        case 'if': {
          if (s.checks) return { cond: (await check(c, s.pageId ?? 'main', s.checks)).pass };
          const v = render(c, s.value).value;
          const eq = s.equals;
          return { cond: v === eq || (v != null && eq != null && String(v) === String(eq)) };
        }
        case 'set_var': {
          const r = render(c, s.value);
          c.vars[s.name] = r.value;
          if (r.sensitive) sensitiveVars.add(s.name);
          else sensitiveVars.delete(s.name);
          return {};
        }
        case 'call': {
          if (c.depth >= MAX_CALL_DEPTH) {
            throw new Failure('invalid_params', `call 嵌套超过 ${MAX_CALL_DEPTH} 层`);
          }
          const w = loadWorkflow(join(workspace, 'workflows', s.workflow));
          if (w.steps.some((x) => x.once_only)) {
            throw new Failure('invalid_params', `子工作流 ${w.name} 含 once_only 步骤：M2 不支持`);
          }
          const args = render(c, s.args ?? {}).value as Record<string, unknown>;
          const out = await exec(mkCtx(w, args, c.depth + 1), 0, w.steps.length, false);
          return out.state === 'DONE' ? {} : { out };
        }
        case 'extract': {
          const { a, redacted } = prepare(c, s);
          const r = await executor.extract({ ...a, step_id: s.step_id } as ExtractStep);
          if (s.into) {
            const key = s.key ?? c.wf.meta.outputs?.[s.into]?.key;
            const n = outputs().append(s.into, r.rows, key ? { key } : {}).written;
            stats.rows = { ...stats.rows, [s.into]: (stats.rows?.[s.into] ?? 0) + n };
          }
          if (s.as) {
            c.vars[s.as] =
              s.source.type === 'dom' && s.source.kind === 'kv' ? (r.rows[0] ?? {}) : r.rows;
          }
          return { shown: JSON.stringify(redacted).slice(0, 300) };
        }
        default: {
          const { a, redacted } = prepare(c, s);
          beforeAct?.();
          sent = true;
          const res = await executor.act(a as unknown as Action);
          trace(c, s, redacted, res);
          if (res.status === 'error') {
            const e = res.error;
            throw new Failure(e?.code ?? 'internal', e?.message ?? 'act 失败', e?.details);
          }
          if (s.op === 'evaluate_script' && s.as) c.vars[s.as] = res.data;
          return { res, shown: JSON.stringify(redacted).slice(0, 300) };
        }
      }
    } catch (e) {
      return { fail: toFail(e), sent };
    }
  };

  // ---------- 失败处理 ----------

  /** 重试用尽后按 on_fail 处理（DESIGN 约定 6）。strict：前置路径重放，失败一律终止。 */
  const onFail = async (c: Ctx, s: Step, f: Failure, since: number, strict: boolean): NextP => {
    const policy = strict ? 'stop' : (s.on_fail ?? 'human');
    stats.failed++;
    note(c, s, policy === 'skip' ? 'skipped' : 'error', since, `${f.code}：${f.message}`);
    if (policy === 'skip') {
      stats.skipped++;
      return {};
    }
    if (policy === 'human') {
      const shot = await takeShot(s);
      events?.need_human?.({
        run_id: runId,
        step_id: s.step_id,
        reason: f.code,
        message: f.message,
        screenshot: shot,
      });
    }
    return { out: halt(policy === 'stop' ? 'FAILED' : 'NEED_HUMAN', s.step_id, f.code, f.message) };
  };

  /** 普通步骤：按 retry 重试，仍失败交给 onFail。 */
  const ordinary = async (c: Ctx, s: Step, strict: boolean): Promise<Next> => {
    const since = Date.now();
    let o: Out;
    for (let n = 0; ; n++) {
      o = await doStep(c, s);
      if (!o.fail && s.opens) o.fail = bind(s.opens, o.res) ?? undefined;
      if (!o.fail || n >= (s.retry?.max ?? 0)) break;
      const delay = s.retry?.delay_ms ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    if (o.fail) return onFail(c, s, o.fail, since, strict);
    if (o.out) return { out: { ...o.out, stepId: s.step_id } };
    note(c, s, 'ok', since, o.shown);
    return { o };
  };

  // ---------- 单次提交 ----------

  /** 跳过模式下重置页面：重放前置路径，再确认循环锚点。 */
  const reset = async (loop: Frame, s: Step): Promise<Outcome | null> => {
    aliases.clear();
    const out = await exec(root, 0, firstMain, true);
    if (out.state !== 'DONE') return out;
    const anchor = loop.s.anchor;
    if (!anchor?.length) return null;
    let why: string | null = null;
    try {
      const r = await check(root, 'main', anchor);
      if (!r.pass) why = r.detail ?? '检查未通过';
    } catch (e) {
      why = toFail(e).message;
    }
    if (why === null) return null;
    return halt('FAILED', s.step_id, 'assertion_failed', `重置页面后循环锚点未满足：${why}`);
  };

  /** 状态未明：记入待核实清单，绝不重试；按 on_unverified 停止，或重置页面后处理下一条。 */
  const unverified = async (
    c: Ctx,
    s: Step,
    key: string,
    reason: UnverifiedRecord['reason'],
    since: number,
  ): Promise<Next> => {
    store.recordUnverified({
      step_id: s.step_id,
      idempotency_key: key,
      reason,
      screenshot: await takeShot(s),
    });
    stats.unverified++;
    note(c, s, 'error', since, `状态未明（${reason}）：${key}`);
    const rec = store.getUnverified(key);
    if (rec) events?.unverified?.(rec);
    // 缺省取最内层设了 on_unverified 的循环，再取工作流的，再缺省 stop；不在循环里没有“下一条”，也只能停
    const mode =
      options.onUnverified ??
      c.frames.findLast((f) => f.s.on_unverified)?.s.on_unverified ??
      workflow.meta.on_unverified;
    const loop = c.frames.at(-1);
    if (++consecutive >= 2 || mode !== 'skip' || !loop) {
      const message = `单次提交状态未明（${reason}），已停止：${key}`;
      return { out: halt('STOPPED', s.step_id, 'unverified', message) };
    }
    const failed = await reset(loop, s);
    return failed ? { out: failed } : { skipTo: loop.end };
  };

  /** 单次提交步骤（FR-18，DESIGN 约定 7、16）：永不自动重试，结果分成功、状态未明、未发出三类。 */
  const onceOnly = async (c: Ctx, s: Step, pc: number): Promise<Next> => {
    const since = Date.now();
    let key: string;
    try {
      key = String(render(c, s.idempotency_key).value);
    } catch (e) {
      return onFail(c, s, toFail(e), since, false);
    }
    if (store.hasSideEffect(key)) {
      stats.skipped++;
      note(c, s, 'skipped', since, `幂等键已提交：${key}`);
      return {};
    }
    const old = store.getUnverified(key);
    if (old && !old.resolution) return unverified(c, s, key, old.reason, since);
    // 续跑时检查点停在这一步、却没有成功记录：上次可能已经发出，按崩溃处理
    if (pc === crashAt) {
      crashAt = -1;
      return unverified(c, s, key, 'crash', since);
    }
    const o = await doStep(c, s, () => save(c, s.step_id));
    if (o.fail) {
      const reason = o.sent ? unverifiedReason(o.fail) : null;
      return reason ? unverified(c, s, key, reason, since) : onFail(c, s, o.fail, since, false);
    }
    const evidence = o.res?.assertions;
    store.recordSideEffect({
      step_id: s.step_id,
      idempotency_key: key,
      ...(evidence ? { evidence } : {}),
    });
    consecutive = 0;
    save(c, c.wf.steps[pc + 1]?.step_id ?? s.step_id);
    const f = s.opens ? bind(s.opens, o.res) : null;
    if (f) return onFail(c, s, f, since, false);
    note(c, s, 'ok', since, o.shown);
    return {};
  };

  // ---------- 解释执行 ----------

  const frameAt = (c: Ctx, pc: number, items: unknown[], i: number): Frame => ({
    s: c.wf.steps[pc] as LoopStep,
    begin: pc,
    end: c.lay.get(pc) ?? pc,
    items,
    i,
  });

  /** 切到循环的当前条目：设置循环变量。 */
  const setItem = (c: Ctx, f: Frame): void => {
    c.vars[f.s.as] = f.items[f.i];
  };

  /** 执行 [from, to) 的步骤。 */
  const exec = async (c: Ctx, from: number, to: number, strict: boolean): Promise<Outcome> => {
    const steps = c.wf.steps;
    let pc = from;
    while (pc < to) {
      const s = steps[pc] as Step;
      await hooks?.beforeStep?.(s);
      let next = pc + 1;
      const f = c.frames.at(-1);
      switch (s.op) {
        case 'loop_end':
          if (f) {
            f.i++;
            if (f.i < f.items.length) {
              setItem(c, f);
              save(c, f.s.step_id);
              next = f.begin + 1;
            } else c.frames.pop();
          }
          break;
        case 'break':
          if (f) {
            c.frames.pop();
            next = f.end + 1;
          }
          break;
        case 'else':
          next = (c.lay.get(pc) ?? pc) + 1;
          break;
        case 'end_if':
          break;
        case 'checkpoint':
          save(c, steps[pc + 1]?.step_id ?? s.step_id);
          break;
        default: {
          const r = s.once_only ? await onceOnly(c, s, pc) : await ordinary(c, s, strict);
          if (r.out) return r.out;
          const end = (c.lay.get(pc) ?? pc) + 1;
          if (r.skipTo !== undefined) next = r.skipTo;
          else if (s.op === 'if') next = r.o?.cond ? pc + 1 : end;
          else if (s.op === 'loop_begin') {
            const items = r.o?.items ?? [];
            if (items.length > 0) {
              const fr = frameAt(c, pc, items, 0);
              c.frames.push(fr);
              setItem(c, fr);
              save(c, fr.s.step_id);
            } else next = end;
          }
        }
      }
      await hooks?.afterStep?.(s);
      pc = next;
    }
    return { state: 'DONE', stepId: steps[to - 1]?.step_id ?? '' };
  };

  const finish = (out: Outcome): RunResult => {
    if (out.state === 'DONE') {
      for (const [name, o] of Object.entries(workflow.meta.outputs ?? {})) {
        if (o?.export?.length && outputs().count(name) > 0) outputs().export(name, o.export);
      }
    }
    save(root, out.stepId, out.state);
    store.pruneShots();
    stats.duration_ms = Date.now() - started;
    if (out.state !== 'NEED_HUMAN') events?.run_done?.({ run_id: runId, state: out.state, stats });
    const { state, stepId: step_id, error } = out;
    return { state, stats, step_id, ...(error && { error }) };
  };

  const steps = workflow.steps;
  if (!cp) {
    save(root, steps[0]?.step_id ?? '');
    return finish(await exec(root, 0, steps.length, false));
  }

  // 续跑（DESIGN 约定 9）：回到检查点所在的步骤（循环内回到对应条目），并无条件重放前置路径
  const at = steps.findIndex((x) => x.step_id === cp.step_id);
  if (at < 0) return early(`检查点的步骤不存在：${cp.step_id}`);
  const target = Math.max(at, firstMain);
  let from = target;
  try {
    const open: number[] = [];
    steps.slice(0, target).forEach((x, i) => {
      if (x.op === 'loop_begin') open.push(i);
      else if (x.op === 'loop_end') open.pop();
    });
    if (steps[target]?.op === 'loop_begin') {
      open.push(target);
      from = target + 1;
    }
    for (const b of open) {
      const st = steps[b] as LoopStep;
      const fr = frameAt(root, b, itemsOf(root, st), cp.loop_index?.[st.step_id] ?? 0);
      root.frames.push(fr);
      setItem(root, fr);
    }
  } catch (e) {
    const f = toFail(e);
    return finish(halt('FAILED', cp.step_id, f.code, f.message));
  }
  // 前置路径重放失败：检查点仍停在原来的位置，修好之后可以再续跑
  const replay = await exec(root, 0, firstMain, true);
  if (replay.state !== 'DONE') return finish({ ...replay, stepId: cp.step_id });
  crashAt = cp.state === 'RUNNING' && steps[target]?.once_only ? target : -1;
  save(root, steps[target]?.step_id ?? cp.step_id);
  return finish(await exec(root, from, steps.length, false));
}
