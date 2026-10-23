// 工作流引擎的共享类型与接口。各模块只依赖这里，不互相引用内部实现（见 DESIGN.md）。
import type {
  Action,
  ActResult,
  Checkpoint,
  Locator,
  SideEffectRecord,
  Step,
  UnverifiedRecord,
  WorkflowMeta,
} from '@obact/schemas';

export type {
  Action,
  ActResult,
  Checkpoint,
  Locator,
  SideEffectRecord,
  Step,
  UnverifiedRecord,
  WorkflowMeta,
};

/** 已加载的工作流（workflow.ts 产出）。 */
export type Workflow = {
  name: string;
  dir: string;
  meta: WorkflowMeta;
  steps: Step[];
  /** signatures.json、rules.json 原样（M3 才用到弹窗规则）。 */
  signatures: unknown[];
  rules: unknown[];
};

/** 模板渲染所需的环境。 */
export type Scope = {
  /** 参数库查找：工作流 → 网站 → 全局；找不到返回 undefined。 */
  param(name: string): unknown;
  vars: Record<string, unknown>;
  /** {{file:路径}} 的读取（路径相对工作区）。 */
  file(path: string): unknown;
};

export type ParamsStore = {
  get(name: string): unknown;
  set(name: string, value: unknown, scope?: 'global' | 'site' | 'workflow'): void;
  /** 名称是否敏感（含 password、token、secret，不分大小写）。 */
  isSensitive(name: string): boolean;
};

/** 抽取步骤的结果。 */
export type ExtractResult = {
  rows: Record<string, unknown>[];
  /** 抽取到的行数（去重前）。 */
  count: number;
  /** 说明：翻了几页、滚动了几轮、等待了多久。 */
  notes?: string[];
};

/**
 * 执行器：runner 通过它操作浏览器，测试里可以用假的实现。
 * CoreExecutor（executor.ts）基于 @obact/core 的 act、observe、定位器和 network 缓存。
 */
export interface Executor {
  /** 执行一个动作（模板已渲染，步骤字段已去掉）。不抛异常：失败以 status:'error' 返回。 */
  act(action: Action): Promise<ActResult>;
  /** 抽取（页面或接口）。失败抛 ObactError（code 取自契约）。 */
  extract(step: Extract<Step, { op: 'extract' }>): Promise<ExtractResult>;
  /** 判断检查项（前置检查、if 条件、循环锚点）；返回每项是否通过。 */
  check(
    pageId: string,
    checks: NonNullable<Action['post']>,
  ): Promise<{ pass: boolean; detail?: string }>;
  /** 当前动作序号（接口缓存用）。 */
  actionSeq(): number;
  /** 保存当前页面截图，返回路径；不可用时返回 null。 */
  screenshot(pageId: string, name: string): Promise<string | null>;
  /** 关闭并释放（浏览器由调用方管理时不关）。 */
  close(): Promise<void>;
}

/** 运行事件回调（对应 events.json）。 */
export type RunEvents = {
  step?(e: {
    run_id: string;
    step_id: string;
    op: string;
    status: 'ok' | 'error' | 'skipped';
    duration_ms: number;
    loop?: Record<string, number>;
  }): void;
  need_human?(e: {
    run_id: string;
    step_id: string;
    /** 失败原因代码（契约 ErrorCode）。 */
    reason: string;
    message?: string;
    screenshot: string | null;
  }): void;
  unverified?(e: UnverifiedRecord): void;
  run_done?(e: { run_id: string; state: Checkpoint['state']; stats: RunStats }): void;
};

export type RunStats = {
  steps: number;
  failed: number;
  skipped: number;
  unverified: number;
  duration_ms: number;
  rows?: Record<string, number>;
};

export type RunOptions = {
  runId: string;
  /** 工作区根目录（含 params.yaml、workflows/、runs/、outputs/、files/）。 */
  workspace: string;
  mode?: Checkpoint['mode'];
  /** true：从检查点续跑。 */
  resume?: boolean;
  events?: RunEvents;
  /** 覆盖工作流里的 on_unverified。 */
  onUnverified?: 'stop' | 'skip';
  /** 传入 call 或命令行的参数，作为 {{var:..}} 的初始值。 */
  vars?: Record<string, unknown>;
  /** 测试用：每步之间调用，可抛异常模拟崩溃。 */
  hooks?: {
    beforeStep?(step: Step): void | Promise<void>;
    afterStep?(step: Step): void | Promise<void>;
  };
};

export type RunResult = {
  state: Checkpoint['state'];
  stats: RunStats;
  /** 最后一个步骤 ID。 */
  step_id: string;
  error?: { code: string; message: string; step_id: string };
};
