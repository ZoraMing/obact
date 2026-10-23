// 工作流解释执行（FR-16~19、FR-25、FR-26，DESIGN 约定 1、5、6、10、11）。
// 只依赖 Executor 接口，不 import @obact/core：executor 与模板抛出的 ObactError 按名字识别；
// 不带 code 的异常（包括测试里模拟崩溃抛的）一律向外抛，相当于进程崩溃，靠检查点续跑。
//
// 结构：exec 按下标解释执行步骤（loop / if 用预先算好的配对表跳转，循环条目用 frames 栈）；
// ordinary 管重试与 on_fail；检查点只由根工作流写，call 的子工作流整体算根工作流的一步。
import { join } from 'node:path';
import { createFiles } from './files.ts';
import { loadParams } from './params.ts';
import { RunStore } from './store.ts';
import { parsePath, renderWithTrace } from './template.ts';
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

/** 循环的一层：id 是 loop_begin 的 step_id；begin / end 是 loop_begin / loop_end 的下标。 */
type Frame = {
  id: string;
  as: string;
  begin: number;
  end: number;
  items: unknown[];
  i: number;
  on: LoopStep['on_unverified'];
  anchor: LoopStep['anchor'];
};

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

type Outcome = { state: Checkpoint['state']; stepId: string; error?: RunResult['error'] };
/** 一次尝试的结果：fail 为空即成功；cond / items 分别是 if 与 loop_begin 的求值结果。 */
type Out = {
  fail?: Failure;
  res?: ActResult;
  cond?: boolean;
  items?: unknown[];
  shown?: string;
  out?: Outcome;
};
/** 一步处理完的去向：out 终止运行；o 是成功时的结果；都没有表示失败后按 skip 继续。 */
type Next = { out?: Outcome; o?: Out };

/** 步骤自己的字段，不属于动作（DESIGN 约定 1）。 */
const STEP_ONLY = [
  'step_id',
  'section',
  'pre',
  'retry',
  'on_fail',
  'once_only',
  'idempotency_key',
  'volatile',
  'note',
  'opens',
];
const MAX_CALL_DEPTH = 8;

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

  const files = createFiles(workspace);
  const sensitiveVars = new Set<string>();
  const mode = options.mode ?? workflow.meta.mode ?? 'headless';
  const scopeFor = (w: Workflow, vars: Record<string, unknown>): Scope => {
    const params = loadParams(workspace, w.name, w.meta.site);
    return { param: (n) => params.get(n), vars, file: (p) => files.read(p) };
  };
  const vars: Record<string, unknown> = { ...options.vars };
  let scope: Scope;
  try {
    scope = scopeFor(workflow, vars);
  } catch (e) {
    return early((e as Error).message);
  }
  const root: Ctx = {
    wf: workflow,
    vars,
    frames: [],
    scope,
    lay: pairs(workflow.steps),
    root: true,
    depth: 0,
  };

  // ---------- 留痕与检查点 ----------

  const loopIndex = (c: Ctx): Record<string, number> =>
    Object.fromEntries(c.frames.map((f) => [f.id, f.i]));

  /** 写检查点（只有根工作流写）。循环变量与敏感变量不写：前者由 over 与 loop_index 重建。 */
  const save = (c: Ctx, stepId: string, state: Checkpoint['state'] = 'RUNNING'): void => {
    if (!c.root) return;
    const loopVars = new Set(c.frames.map((f) => f.as));
    store.writeCheckpoint({
      run_id: runId,
      workflow: workflow.name,
      mode,
      state,
      step_id: stepId,
      loop_index: loopIndex(c),
      vars: Object.fromEntries(
        Object.entries(c.vars).filter(([k]) => !loopVars.has(k) && !sensitiveVars.has(k)),
      ),
    });
  };

  /** 记一步：steps.log 一行 + step 事件 + 统计。detail 必须是已脱敏的。 */
  const note = (
    c: Ctx,
    s: Step,
    status: 'ok' | 'error' | 'skipped',
    since: number,
    detail = '',
  ): void => {
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

  const page = (id: string): string => id;

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

  /** 执行一步的一次尝试：前置检查 → 渲染 → 执行。 */
  const doStep = async (c: Ctx, s: Step): Promise<Out> => {
    try {
      if (s.pre?.length) {
        const r = await executor.check(page(s.pageId ?? 'main'), s.pre);
        if (!r.pass) {
          throw new Failure('assertion_failed', `前置检查未通过${r.detail ? `：${r.detail}` : ''}`);
        }
      }
      switch (s.op) {
        case 'loop_begin':
          return { items: itemsOf(c, s) };
        case 'if': {
          if (s.checks)
            return { cond: (await executor.check(page(s.pageId ?? 'main'), s.checks)).pass };
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
          const args = render(c, s.args ?? {}).value as Record<string, unknown>;
          const child: Ctx = {
            wf: w,
            vars: args,
            frames: [],
            scope: scopeFor(w, args),
            lay: pairs(w.steps),
            root: false,
            depth: c.depth + 1,
          };
          const out = await exec(child, 0, w.steps.length, false);
          return out.state === 'DONE' ? {} : { out };
        }
        case 'extract': {
          const { a, redacted } = prepare(c, s);
          await executor.extract({ ...a, step_id: s.step_id } as ExtractStep);
          return { shown: JSON.stringify(redacted).slice(0, 300) };
        }
        default: {
          const { a, redacted } = prepare(c, s);
          const res = await executor.act(a as unknown as Action);
          trace(c, s, redacted, res);
          if (res.status === 'error') {
            const e = res.error;
            throw new Failure(e?.code ?? 'internal', e?.message ?? 'act 失败', e?.details);
          }
          return { res, shown: JSON.stringify(redacted).slice(0, 300) };
        }
      }
    } catch (e) {
      return { fail: toFail(e) };
    }
  };

  // ---------- 失败处理 ----------

  /** 重试用尽后按 on_fail 处理（DESIGN 约定 6）。strict：前置路径重放，失败一律终止。 */
  const onFail = async (
    c: Ctx,
    s: Step,
    f: Failure,
    since: number,
    strict: boolean,
  ): Promise<Next> => {
    const policy = strict ? 'stop' : (s.on_fail ?? 'human');
    const error = { code: f.code, message: f.message, step_id: s.step_id };
    stats.failed++;
    if (policy === 'skip') {
      stats.skipped++;
      note(c, s, 'skipped', since, `${f.code}：${f.message}`);
      return {};
    }
    note(c, s, 'error', since, `${f.code}：${f.message}`);
    if (policy === 'stop') return { out: { state: 'FAILED', stepId: s.step_id, error } };
    events?.need_human?.({
      run_id: runId,
      step_id: s.step_id,
      reason: f.code,
      message: f.message,
      screenshot: await takeShot(s),
    });
    return { out: { state: 'NEED_HUMAN', stepId: s.step_id, error } };
  };

  /** 普通步骤：按 retry 重试，仍失败交给 onFail。 */
  const ordinary = async (c: Ctx, s: Step, strict: boolean): Promise<Next> => {
    const since = Date.now();
    let o: Out;
    for (let n = 0; ; n++) {
      o = await doStep(c, s);
      if (!o.fail || n >= (s.retry?.max ?? 0)) break;
      const delay = s.retry?.delay_ms ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    if (o.fail) return onFail(c, s, o.fail, since, strict);
    if (o.out) return { out: { ...o.out, stepId: s.step_id } };
    note(c, s, 'ok', since, o.shown);
    return { o };
  };

  // ---------- 解释执行 ----------

  const frameAt = (c: Ctx, pc: number, items: unknown[], i: number): Frame => {
    const s = c.wf.steps[pc] as LoopStep;
    return {
      id: s.step_id,
      as: s.as,
      begin: pc,
      end: c.lay.get(pc) ?? pc,
      items,
      i,
      on: s.on_unverified,
      anchor: s.anchor,
    };
  };

  /** 开始一个循环条目：设置循环变量。 */
  const enter = (c: Ctx, f: Frame): void => {
    c.vars[f.as] = f.items[f.i];
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
              enter(c, f);
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
        case 'checkpoint':
          break;
        default: {
          const r = await ordinary(c, s, strict);
          if (r.out) return r.out;
          const end = (c.lay.get(pc) ?? pc) + 1;
          if (s.op === 'if') next = r.o?.cond ? pc + 1 : end;
          else if (s.op === 'loop_begin') {
            const items = r.o?.items ?? [];
            if (items.length > 0) {
              const fr = frameAt(c, pc, items, 0);
              c.frames.push(fr);
              enter(c, fr);
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
    save(root, out.stepId, out.state);
    stats.duration_ms = Date.now() - started;
    if (out.state !== 'NEED_HUMAN') events?.run_done?.({ run_id: runId, state: out.state, stats });
    return {
      state: out.state,
      stats,
      step_id: out.stepId,
      ...(out.error ? { error: out.error } : {}),
    };
  };

  save(root, workflow.steps[0]?.step_id ?? '');
  return finish(await exec(root, 0, workflow.steps.length, false));
}
