// 工作流加载与静态校验（FR-16）：workflows/<名称>/ 下的 workflow.json、steps.jsonl、signatures.json、rules.json。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ObactError } from '@obact/core';
import { Contracts, loadSchemas, SCHEMA_BASE, type WorkflowMeta } from '@obact/schemas';
import { listTemplates, parsePath } from './template.ts';
import type { Step, Workflow } from './types.ts';

type ErrorObject = NonNullable<ReturnType<Contracts['check']>>[number];
type ValidateFunction = ReturnType<Contracts['validator']>;

export type ProblemCode =
  | 'duplicate_step_id'
  | 'unclosed'
  | 'unmatched'
  | 'break_outside_loop'
  | 'preamble_after_main'
  | 'preamble_in_block'
  | 'ref_target'
  | 'call_not_found'
  | 'bad_template'
  | 'once_only_not_action'
  | 'once_only_in_preamble'
  | 'missing_idempotency_key'
  | 'duplicate_idempotency_key'
  | 'key_not_per_item'
  | 'key_var_out_of_scope';

export type WorkflowProblem = {
  step_id: string;
  code: ProblemCode;
  message: string;
  /** steps.jsonl 里的行号（经 loadWorkflow 加载的步骤才有）。 */
  line?: number;
};

/** 步骤 → steps.jsonl 行号。放在步骤对象之外，步骤本身保持契约里的样子。 */
const lineOf = new WeakMap<object, number>();

export function formatProblems(problems: WorkflowProblem[]): string {
  return problems
    .map((p) => `${p.line ? `第 ${p.line} 行（${p.step_id}）` : p.step_id}：${p.message}`)
    .join('\n');
}

// ---------- 契约校验与可读的错误信息 ----------

type StepSchemas = {
  contracts: Contracts;
  /** op → 该 op 的定义（action.json 或 step.json 的 $defs）。 */
  defs: Map<string, string>;
  stepDoc: { if?: unknown; else?: unknown };
  byOp: Map<string, ValidateFunction>;
};

let schemas: StepSchemas | null = null;

function stepSchemas(): StepSchemas {
  if (schemas) return schemas;
  const docs = loadSchemas();
  const defs = new Map<string, string>();
  for (const file of ['action.json', 'step.json']) {
    const doc = docs.find((d) => d.$id === SCHEMA_BASE + file);
    const $defs = (doc?.$defs ?? {}) as Record<
      string,
      { properties?: { op?: { const?: unknown } } }
    >;
    for (const [name, def] of Object.entries($defs)) {
      const op = def.properties?.op?.const;
      if (typeof op === 'string') defs.set(op, `${SCHEMA_BASE}${file}#/$defs/${name}`);
    }
  }
  const stepDoc = docs.find((d) => d.$id === `${SCHEMA_BASE}step.json`) as StepSchemas['stepDoc'];
  schemas = { contracts: new Contracts(docs), defs, stepDoc, byOp: new Map() };
  return schemas;
}

/**
 * step.json 是一大串 oneOf，直接报错会列出几十个分支的错误。
 * 先按 op 找到对应分支，只用这一支重新校验，错误才是针对这一行的。
 */
function opValidator(op: string): ValidateFunction | undefined {
  const s = stepSchemas();
  const def = s.defs.get(op);
  if (!def) return undefined;
  let v = s.byOp.get(op);
  if (!v) {
    v = s.contracts.ajv.compile({
      type: 'object',
      allOf: [
        { $ref: `${SCHEMA_BASE}step.json#/$defs/StepCommon` },
        { $ref: `${SCHEMA_BASE}action.json#/$defs/Common` },
        { $ref: def },
      ],
      if: s.stepDoc.if,
      else: s.stepDoc.else,
      unevaluatedProperties: false,
    });
    s.byOp.set(op, v);
  }
  return v;
}

function where(e: ErrorObject): string {
  return e.instancePath ? `${e.instancePath.slice(1).replaceAll('/', '.')}：` : '';
}

function describeError(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'required':
      return `${where(e)}缺少字段 ${p.missingProperty}`;
    case 'additionalProperties':
    case 'unevaluatedProperties': {
      const name = String(p.additionalProperty ?? p.unevaluatedProperty);
      const hint =
        name === 'ref' ? '（工作流里的目标只能是定位器 css / role，不能用编号 ref）' : '';
      return `${where(e)}不允许的字段 ${name}${hint}`;
    }
    case 'type':
      return `${where(e)}类型应为 ${[p.type].flat().join(' 或 ')}`;
    case 'enum':
      return `${where(e)}取值应为 ${(p.allowedValues as unknown[]).join('、')}`;
    case 'const':
      return `${where(e)}取值应为 ${JSON.stringify(p.allowedValue)}`;
    default:
      return `${where(e)}${e.message}`;
  }
}

/** 把校验错误整理成短句：anyOf / oneOf 下全是“缺字段”的合并成“至少需要其一”，聚合项本身不单独报。 */
export function describeContractErrors(errors: ErrorObject[]): string[] {
  const hidden = new Set<ErrorObject>();
  const lines: string[] = [];
  for (const e of errors) {
    if (e.keyword !== 'anyOf' && e.keyword !== 'oneOf' && e.keyword !== 'if') continue;
    hidden.add(e);
    const kids = errors.filter(
      (k) =>
        k !== e && k.instancePath === e.instancePath && k.schemaPath.startsWith(`${e.schemaPath}/`),
    );
    const passing = (e.params as { passingSchemas?: unknown[] | null }).passingSchemas;
    if (e.keyword === 'oneOf' && passing) {
      lines.push(`${where(e)}同时满足了多种写法，只能保留一种`);
      for (const k of kids) hidden.add(k); // 其余分支“不满足”的细节没有意义
    } else if (kids.length > 0 && kids.every((k) => k.keyword === 'required')) {
      const names = kids.map((k) => (k.params as { missingProperty: string }).missingProperty);
      lines.push(`${where(e)}至少需要 ${names.join('、')} 之一`);
      for (const k of kids) hidden.add(k);
    }
  }
  for (const e of errors) if (!hidden.has(e)) lines.push(describeError(e));
  return [...new Set(lines)];
}

/** 校验一行步骤，返回问题短句；空数组表示通过。 */
function stepErrors(step: unknown): string[] {
  const { contracts, defs } = stepSchemas();
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return ['必须是 JSON 对象'];
  const errors = contracts.check('step', step);
  if (!errors) return [];
  const op = (step as { op?: unknown }).op;
  if (typeof op !== 'string') return ['缺少 op'];
  const validate = opValidator(op);
  if (!validate) return [`未知的 op：${op}（可用：${[...defs.keys()].join('、')}）`];
  if (validate(step)) return ['不符合步骤契约'];
  return describeContractErrors(validate.errors ?? []);
}

// ---------- 加载 ----------

function readJson(file: string, optional: boolean): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    if (optional) return undefined;
    throw new ObactError('invalid_params', `找不到 ${basename(file)}：${file}`, { file });
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new ObactError(
      'invalid_params',
      `${basename(file)} 不是合法 JSON：${(e as Error).message}`,
      {
        file,
      },
    );
  }
}

function readList(dir: string, name: 'signatures' | 'rules'): unknown[] {
  const file = join(dir, `${name}.json`);
  const data = readJson(file, true);
  if (data === undefined) return [];
  const { contracts } = stepSchemas();
  const errors = contracts.check(name, data);
  if (errors) {
    throw new ObactError(
      'invalid_params',
      `${name}.json 不符合契约：${describeContractErrors(errors).join('；')}`,
      { file },
    );
  }
  return data as unknown[];
}

function readSteps(dir: string): Step[] {
  const file = join(dir, 'steps.jsonl');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ObactError('invalid_params', `找不到 steps.jsonl：${file}`, { file });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const steps: Step[] = [];
  const bad: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (raw.trim() === '') continue;
    const n = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      bad.push(`第 ${n} 行：不是合法 JSON（${(e as Error).message}）`);
      continue;
    }
    const problems = stepErrors(obj);
    if (problems.length > 0) {
      const id = (obj as { step_id?: unknown } | null)?.step_id;
      const who = typeof id === 'string' ? `（${id}）` : '';
      bad.push(`第 ${n} 行${who}：${problems.join('；')}`);
      continue;
    }
    lineOf.set(obj as object, n);
    steps.push(obj as Step);
  }
  if (bad.length > 0) {
    const shown = bad.slice(0, 30).join('\n');
    const more = bad.length > 30 ? `\n……另有 ${bad.length - 30} 处` : '';
    throw new ObactError(
      'invalid_params',
      `steps.jsonl 有 ${bad.length} 行不合格：\n${shown}${more}`,
      {
        file,
        lines: bad,
      },
    );
  }
  return steps;
}

/**
 * 加载 workflows/<名称>/：契约校验每一行（错误带行号与 step_id），再做结构校验。
 * 任何问题都抛 invalid_params，消息里列出全部问题；传入 resolveWorkflow 时还会检查 call 的工作流是否存在。
 */
export function loadWorkflow(dir: string, resolveWorkflow?: (name: string) => unknown): Workflow {
  const meta = readJson(join(dir, 'workflow.json'), false);
  const { contracts } = stepSchemas();
  const metaErrors = contracts.check('workflow', meta);
  if (metaErrors) {
    throw new ObactError(
      'invalid_params',
      `workflow.json 不符合契约：${describeContractErrors(metaErrors).join('；')}`,
      { file: join(dir, 'workflow.json') },
    );
  }
  const workflow: Workflow = {
    name: (meta as WorkflowMeta).name,
    dir,
    meta: meta as WorkflowMeta,
    steps: readSteps(dir),
    signatures: readList(dir, 'signatures'),
    rules: readList(dir, 'rules'),
  };
  const problems = validateWorkflow(workflow, resolveWorkflow);
  if (problems.length > 0) {
    throw new ObactError(
      'invalid_params',
      `工作流 ${workflow.name} 有 ${problems.length} 个问题：\n${formatProblems(problems)}`,
      { problems },
    );
  }
  return workflow;
}

// ---------- 结构校验 ----------

type Frame =
  | { kind: 'loop'; step: Step; as: string }
  | { kind: 'if'; step: Step; elseSeen: boolean };

/** 控制流的开头、结尾与分支：不能放在前置路径里（前置路径无条件重放，不含循环与分支）。 */
const BLOCK_OPS = new Set(['loop_begin', 'loop_end', 'if', 'else', 'end_if', 'break']);

/** 不是动作的步骤：控制流、call、set_var、checkpoint 与 extract。单次提交只能是一次页面动作（DESIGN 约定 7）。 */
const NOT_ACTION = new Set([...BLOCK_OPS, 'call', 'set_var', 'checkpoint', 'extract']);

function hasRef(x: unknown): boolean {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.hasOwn(x, 'ref');
}

/**
 * 结构校验，返回全部问题（不抛）：step_id 唯一；loop / if 配对与嵌套；break 在循环内；
 * 前置路径在所有主流程之前且不在循环或分支内；目标不能用 ref；模板写法；call 的工作流存在；
 * 单次提交只能用在动作步骤上、不在前置路径里，其幂等键要引用每一层外层循环的变量，且各步骤的键模板互不相同。
 */
export function validateWorkflow(
  w: Workflow,
  resolveWorkflow?: (name: string) => unknown,
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const add = (step: Step, code: ProblemCode, message: string) =>
    problems.push({ step_id: step.step_id, code, message, line: lineOf.get(step) });

  const allLoopVars = new Set<string>();
  for (const s of w.steps) if (s.op === 'loop_begin') allLoopVars.add(s.as);

  const stack: Frame[] = [];
  const ids = new Set<string>();
  let mainSeen = false;

  const innermostLoop = () => stack.findLast((f) => f.kind === 'loop');
  /** 幂等键模板 → 用它的 once_only 步骤。 */
  const keyOwners = new Map<string, string>();

  const close = (step: Step, kind: Frame['kind'], opener: string) => {
    const top = stack.at(-1);
    if (top?.kind === kind) {
      stack.pop();
      return;
    }
    const idx = stack.findLastIndex((f) => f.kind === kind);
    if (idx < 0) {
      add(step, 'unmatched', `${step.op} 没有对应的 ${opener}`);
      return;
    }
    for (const f of stack.splice(idx + 1)) {
      add(f.step, 'unclosed', `${f.step.op} 在 ${step.op}（${step.step_id}）之前没有闭合`);
    }
    stack.pop();
  };

  for (const step of w.steps) {
    if (ids.has(step.step_id)) add(step, 'duplicate_step_id', `step_id 重复：${step.step_id}`);
    ids.add(step.step_id);

    if (step.section === 'preamble') {
      if (mainSeen) add(step, 'preamble_after_main', '前置路径步骤出现在主流程步骤之后');
      if (stack.length > 0) add(step, 'preamble_in_block', '前置路径步骤不能放在循环或分支里');
      else if (BLOCK_OPS.has(step.op)) {
        add(step, 'preamble_in_block', `${step.op} 是控制流，不能属于前置路径`);
      }
    } else {
      mainSeen = true;
    }

    const rec = step as Record<string, unknown>;
    const refAt = [
      ...['target', 'from', 'to'].filter((k) => hasRef(rec[k])),
      ...(Array.isArray(rec.elements) ? rec.elements : []).flatMap((el, i) =>
        hasRef((el as { target?: unknown } | null)?.target) ? [`elements[${i}].target`] : [],
      ),
    ];
    for (const k of refAt) add(step, 'ref_target', `${k} 用了编号 ref：工作流里的目标只能是定位器`);

    for (const t of listTemplates({ ...step, note: undefined })) {
      const bad =
        t.kind !== 'param' && t.kind !== 'var' && t.kind !== 'file'
          ? `模板类型 ${t.kind} 不存在（可用 param、var、file）`
          : t.name === ''
            ? '模板缺少名称'
            : t.kind === 'var' && !parsePath(t.name)
              ? '变量路径写法不对（应为 a.b[0].c）'
              : null;
      if (bad) add(step, 'bad_template', `${t.raw}：${bad}`);
    }

    switch (step.op) {
      case 'loop_begin':
        stack.push({ kind: 'loop', step, as: step.as });
        break;
      case 'loop_end':
        close(step, 'loop', 'loop_begin');
        break;
      case 'if':
        stack.push({ kind: 'if', step, elseSeen: false });
        break;
      case 'else': {
        const top = stack.at(-1);
        if (top?.kind !== 'if') add(step, 'unmatched', 'else 没有对应的 if');
        else if (top.elseSeen) add(step, 'unmatched', '同一个 if 里出现了多个 else');
        else top.elseSeen = true;
        break;
      }
      case 'end_if':
        close(step, 'if', 'if');
        break;
      case 'break':
        if (!innermostLoop()) add(step, 'break_outside_loop', 'break 不在任何循环内');
        break;
      case 'call':
        if (resolveWorkflow && !resolveWorkflow(step.workflow)) {
          add(step, 'call_not_found', `找不到被调用的工作流：${step.workflow}`);
        }
        break;
    }

    if (step.once_only) {
      if (NOT_ACTION.has(step.op)) {
        add(
          step,
          'once_only_not_action',
          `${step.op} 不是动作步骤，不能 once_only：单次提交只能是一次页面动作，子流程、抽取、赋值失败后无法判断是否已提交`,
        );
        continue;
      }
      if (step.section === 'preamble') {
        add(step, 'once_only_in_preamble', '前置路径续跑时无条件重放，不能 once_only');
      }
      const key = step.idempotency_key;
      if (!key) {
        add(step, 'missing_idempotency_key', 'once_only 步骤必须有 idempotency_key');
        continue;
      }
      const owner = keyOwners.get(key);
      if (owner !== undefined) {
        add(
          step,
          'duplicate_idempotency_key',
          `idempotency_key 与步骤 ${owner} 的模板完全相同：同一条目的两次提交共用一个键，第二个会被当作已提交而跳过`,
        );
      } else keyOwners.set(key, step.step_id);
      const heads = listTemplates(key)
        .filter((t) => t.kind === 'var')
        .map((t) => parsePath(t.name)?.[0])
        .filter((h): h is string => typeof h === 'string');
      for (const h of new Set(heads)) {
        const enclosing = stack.some((f) => f.kind === 'loop' && f.as === h);
        if (allLoopVars.has(h) && !enclosing) {
          add(
            step,
            'key_var_out_of_scope',
            `idempotency_key 引用的循环变量 ${h} 不在其所在的循环内`,
          );
        }
      }
      // 每一层外层循环的变量都要出现在键里，否则那一层的不同条目会得到相同的键；
      // 循环内 set_var、extract.as 设的变量不随条目自动变化，不算
      for (const f of stack) {
        if (f.kind === 'loop' && !heads.includes(f.as)) {
          add(
            step,
            'key_not_per_item',
            `idempotency_key 没有引用循环变量 ${f.as}：该循环的不同条目会得到相同的键，第一条之后都会被当作已提交而跳过`,
          );
        }
      }
    }
  }

  for (const f of stack) {
    add(f.step, 'unclosed', `${f.step.op} 没有对应的 ${f.kind === 'loop' ? 'loop_end' : 'end_if'}`);
  }
  return problems;
}
