// runner 测试用的假执行器：不开浏览器，按脚本返回动作结果。
// 动作按 key（target.css，没有则 url，再没有则 op）分组，每组按调用次序依次取脚本里的回复，用完后重复最后一个；
// 没有脚本的动作一律成功。回复：'ok' | 'crash'（抛不带 code 的异常，模拟进程崩溃）| 错误码 | 带细节的错误 | 打开的新页面。
import type { Action, ActResult, Executor, ExtractResult, Step } from '../src/types.ts';

export type Reply =
  | string
  | { code: string; details?: Record<string, unknown> }
  | { pages: string[] };

export class FakeExecutor implements Executor {
  /** 收到的动作（按到达次序）。 */
  readonly acts: Action[] = [];
  /** check 的调用记录。 */
  readonly checked: { pageId: string; checks: unknown }[] = [];
  /** 抽取的调用记录。 */
  readonly extracted: Step[] = [];
  /** 打开着的页面；p1 是任务起点的标签页。 */
  readonly open = new Set(['p1']);
  /** check 的判定，默认全部通过。 */
  checkPass: (pageId: string, checks: unknown) => boolean = () => true;
  /** 抽取的结果，默认没有行。 */
  extractRows: (step: Step, nth: number) => Record<string, unknown>[] = () => [];
  /** 每个动作到达时先调用（测试用来观察那一刻磁盘上的状态）。 */
  onAct: (action: Action) => void = () => {};
  readonly #plans = new Map<string, Reply[]>();
  readonly #seen = new Map<string, number>();
  #extractN = 0;

  /** 设定某组动作的回复。 */
  plan(key: string, ...replies: Reply[]): this {
    this.#plans.set(key, replies);
    return this;
  }

  /** 某组动作被调用的次数。 */
  count(key: string): number {
    return this.acts.filter((a) => keyOf(a) === key).length;
  }

  /** 收到的动作的 key 序列。 */
  keys(): string[] {
    return this.acts.map(keyOf);
  }

  async act(action: Action): Promise<ActResult> {
    this.onAct(action);
    this.acts.push(action);
    const key = keyOf(action);
    const n = this.#seen.get(key) ?? 0;
    this.#seen.set(key, n + 1);
    const plan = this.#plans.get(key) ?? ['ok'];
    const reply = plan[Math.min(n, plan.length - 1)] as Reply;
    if (reply === 'crash') throw new Error('crash');
    const base = { duration_ms: 1, locator_used: null };
    const fx = { navigated: false, new_pages: [] as string[], dialogs: [], changed: false };
    const fail = (code: string, details?: Record<string, unknown>): ActResult => ({
      ...base,
      status: 'error',
      effects: fx,
      error: { code: code as never, message: `${code} @ ${key}`, ...(details ? { details } : {}) },
    });
    if (action.op !== 'new_page' && !this.open.has(String(action.pageId))) {
      return fail('page_not_found');
    }
    if (typeof reply === 'string') return reply === 'ok' ? this.#ok(action, fx) : fail(reply);
    if ('code' in reply) return fail(reply.code, reply.details);
    for (const p of reply.pages) this.open.add(p);
    return this.#ok(action, { ...fx, new_pages: reply.pages });
  }

  #ok(action: Action, effects: ActResult['effects']): ActResult {
    if (action.op === 'close_page') this.open.delete(String(action.pageId));
    return { status: 'ok', duration_ms: 1, locator_used: null, effects };
  }

  async extract(step: Extract<Step, { op: 'extract' }>): Promise<ExtractResult> {
    this.extracted.push(step);
    const rows = this.extractRows(step, this.#extractN++);
    return { rows, count: rows.length };
  }

  async check(pageId: string, checks: unknown[]): Promise<{ pass: boolean; detail?: string }> {
    this.checked.push({ pageId, checks });
    const pass = this.checkPass(pageId, checks);
    return pass ? { pass } : { pass, detail: '假执行器判定不通过' };
  }

  mainPage(): string {
    return 'p1';
  }

  pageOpen(pageId: string): boolean {
    return this.open.has(pageId);
  }

  actionSeq(): number {
    return this.acts.length;
  }

  async screenshot(_pageId: string, name: string): Promise<string | null> {
    return `shots/${name}.webp`;
  }

  async close(): Promise<void> {}
}

function keyOf(a: Action): string {
  const x = a as { target?: { css?: string }; url?: string };
  return x.target?.css ?? x.url ?? a.op;
}
