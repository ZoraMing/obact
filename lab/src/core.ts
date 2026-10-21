/**
 * Obact Lab 的公共部分（PRD 9.3）：数据空间、路由、登录态、故障注入、三个控制接口。
 *
 * 数据空间：所有页面和接口都在 /s/<空间名>/ 下，每个空间的数据互相独立，首次访问时按种子初始化；
 * 多个运行用不同的空间名即可并行。会话 cookie 的 Path 限定在空间内，空间之间不串登录态。
 *
 * 控制接口（不受故障注入影响，不需要登录）：
 *   POST /s/<空间>/_lab/reset    重置为初始数据（可传 {seed}），清空会话、提交记录和故障开关
 *   GET  /s/<空间>/_lab/state    状态查询：供评分点判定和对账
 *   POST /s/<空间>/_lab/faults   设置故障开关（部分字段合并），返回当前开关
 *
 * 模块：lab/src/modules/*.ts 自动加载，默认导出 LabModule。模块只在自己的 data[模块名] 下存数据。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 故障注入开关。只影响 /api/ 下的接口（popup、redesign 影响页面渲染）。 */
export type Faults = {
  /** 接口延迟（毫秒）。 */
  delay_ms: number;
  /** 偶发 500 的比例，0~1。 */
  error_rate: number;
  /** 丢弃响应（直接断开连接）的比例，0~1。commit 写接口先照常执行并落库再断开，读接口直接断开。 */
  drop_rate: number;
  /** 提交超时但已落库：标记为 commit 的写接口照常执行并记录，然后不返回响应（挂起直到客户端放弃）。 */
  commit_timeout: boolean;
  /** 会话有效期（毫秒）；null 为不过期。 */
  session_ttl_ms: number | null;
  /** 改版变体：0 为原版，1 起为各模块定义的改版（改 id、改文案、改层级、移位置等）。 */
  redesign: number;
  /** 随机弹窗：每次加载页面按此概率弹出广告层（按空间的随机序列，结果可复现）。 */
  popup_rate: number;
};

export const DEFAULT_FAULTS: Faults = {
  delay_ms: 0,
  error_rate: 0,
  drop_rate: 0,
  commit_timeout: false,
  session_ttl_ms: null,
  redesign: 0,
  popup_rate: 0,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 数字或数字字符串（表单编码里所有值都是字符串）转成有限数字；不是则 undefined。 */
function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

const nonNegative = (v: unknown) => {
  const n = toNumber(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

/** 每个故障开关的取值规则：parse 返回转换后的值，不合法返回 undefined。 */
const FAULT_RULES: {
  [K in keyof Faults]: { parse(v: unknown): Faults[K] | undefined; expect: string };
} = {
  delay_ms: { parse: nonNegative, expect: '不小于 0 的数字' },
  error_rate: { parse: (v) => rate(v), expect: '0~1 的数字' },
  drop_rate: { parse: (v) => rate(v), expect: '0~1 的数字' },
  commit_timeout: {
    parse: (v) =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined,
    expect: 'true 或 false',
  },
  session_ttl_ms: {
    parse: (v) => (v === null || v === 'null' ? null : nonNegative(v)),
    expect: '不小于 0 的数字或 null',
  },
  redesign: {
    parse: (v) => {
      const n = nonNegative(v);
      return n !== undefined && Number.isInteger(n) ? n : undefined;
    },
    expect: '不小于 0 的整数',
  },
  popup_rate: { parse: (v) => rate(v), expect: '0~1 的数字' },
};

function rate(v: unknown): number | undefined {
  const n = toNumber(v);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

/**
 * 校验并转换 _lab/faults 的请求体：必须是对象，只认 Faults 里的键，值按类型转换（表单里的 "0.5"、"true"、"null"）。
 * 任何一项不合法就整体拒绝，一个开关都不改。
 */
export function parseFaults(body: unknown): { faults: Partial<Faults> } | { error: string } {
  if (!isRecord(body)) return { error: '请求体必须是 JSON 对象或表单' };
  const faults: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(FAULT_RULES, k)) {
      return { error: `未知的故障开关 ${k}，可用：${Object.keys(FAULT_RULES).join('、')}` };
    }
    const rule = FAULT_RULES[k as keyof Faults];
    const value = rule.parse(v);
    if (value === undefined)
      return { error: `故障开关 ${k} 的值 ${JSON.stringify(v)} 不合法，应为${rule.expect}` };
    faults[k] = value;
  }
  return { faults: faults as Partial<Faults> };
}

/** 校验 _lab/reset 的请求体：对象，可选 seed（整数，表单里的数字字符串也行）；未知键拒绝。 */
export function parseReset(body: unknown): { seed?: number } | { error: string } {
  if (!isRecord(body)) return { error: '请求体必须是 JSON 对象或表单' };
  for (const k of Object.keys(body)) {
    if (k !== 'seed') return { error: `未知的重置参数 ${k}，可用：seed` };
  }
  if (body.seed === undefined) return {};
  const seed = toNumber(body.seed);
  if (seed === undefined || !Number.isSafeInteger(seed)) {
    return { error: `seed 的值 ${JSON.stringify(body.seed)} 不合法，应为整数` };
  }
  return { seed };
}

export type Submission = {
  /** 幂等键（客户端随请求带上，缺省时服务端生成 auto-N）。 */
  key: string;
  op: string;
  /** 同一幂等键被提交的次数；对账时大于 1 即重复提交。 */
  count: number;
  first_at: string;
  last_at: string;
  /** 首次提交的载荷（重复提交不覆盖）。 */
  payload: unknown;
  /** 同一个键后来带了不同的操作或载荷：这个键被复用了，服务端仍只按首次处理。 */
  conflict?: boolean;
};

export type SessionInfo = { token: string; user: string; created: number };

export type Space = {
  id: string;
  seed: number;
  /** 各模块的数据：data[模块名]。 */
  data: Record<string, unknown>;
  faults: Faults;
  sessions: Map<string, SessionInfo>;
  submissions: Map<string, Submission>;
  /** 无键提交的自动幂等键序号（auto-N）：按空间计数，reset 随新空间归零。 */
  autoKey: number;
  /** 本空间的确定性随机数（种子 + 调用次序）。 */
  rng(): number;
  /** 事件日志（最近 500 条），用于调试与对账。 */
  log: { at: string; type: string; detail?: unknown }[];
};

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  space: Space;
  /** 本空间的路径前缀，如 /s/run1；页面里的链接和接口地址都要带上。 */
  base: string;
  /** 本 Lab 装配的全部模块（页面外壳据此渲染完整导航，并让每个模块的 shell 钩子在所有页面生效）。 */
  modules: readonly LabModule[];
  /** 路径参数（:name）。 */
  params: Record<string, string>;
  /** 当前登录用户；未登录或会话过期为 null。 */
  user: string | null;
  /** 读请求体：JSON 或表单（application/x-www-form-urlencoded）都解析成对象。 */
  body(): Promise<Record<string, unknown>>;
  json(data: unknown, status?: number): void;
  html(body: string, status?: number): void;
  redirect(location: string): void;
  /** 设置 cookie（Path 自动限定在本空间）。 */
  setCookie(name: string, value: string, opts?: { maxAge?: number }): void;
  cookie(name: string): string | undefined;
  /** 登录：在本空间建会话并写会话 cookie。 */
  signIn(user: string): void;
  /** 退出登录：删除当前会话。 */
  signOut(): void;
  /** 记录一次提交（按幂等键计数）；commit 写接口在执行写操作后调用。 */
  record(op: string, key: string | undefined, payload: unknown): Submission;
};

export type Handler = (ctx: Ctx) => void | Promise<void>;

export type RouteOpts = {
  /** 需要登录：未登录的页面跳到登录页，接口返回 401。 */
  auth?: boolean;
  /** 写接口：受 commit_timeout 影响（执行后挂起不返回）。 */
  commit?: boolean;
};

export type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  opts: RouteOpts;
  module: string;
};

export class Router {
  readonly routes: Route[] = [];
  #module = '';
  constructor(module: string) {
    this.#module = module;
  }
  #add(method: string, path: string, handler: Handler, opts: RouteOpts = {}): void {
    const keys: string[] = [];
    const src = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method,
      pattern: new RegExp(`^${src}$`),
      keys,
      handler,
      opts,
      module: this.#module,
    });
  }
  get(path: string, h: Handler, opts?: RouteOpts): void {
    this.#add('GET', path, h, opts);
  }
  post(path: string, h: Handler, opts?: RouteOpts): void {
    this.#add('POST', path, h, opts);
  }
}

export type LabModule = {
  /** 模块名（英文，用作 data 键与路径前缀，如 orders）。 */
  name: string;
  /** 导航里显示的中文名。 */
  title: string;
  /** 导航链接（相对空间，如 /orders）；不填则不出现在导航里。 */
  nav?: string;
  /** 初始化或重置本模块数据（写 space.data[name]）。用 space.rng() 取随机数。 */
  init(space: Space): void;
  routes(r: Router): void;
  /** 状态查询里本模块的部分（评分点判定、对账用）。 */
  state?(space: Space): unknown;
  /**
   * 页面外壳钩子：每个页面 </body> 前追加的 HTML（如干扰层、随机弹窗）。
   * 可读 ctx.space.faults 决定是否输出。
   */
  shell?(ctx: Ctx): string;
};

/** mulberry32：小而确定的随机数生成器。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 空间名 → 默认种子（同名空间每次重置得到相同数据）。 */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 带空间前缀的公共页面外壳：标题、导航、内容、各模块的外壳钩子。
 * 导航与外壳钩子始终取 ctx.modules（全部模块）；modules 参数只在 ctx 没有模块列表时（单元测试）使用。
 */
export function page(
  ctx: Ctx,
  modules: readonly LabModule[],
  title: string,
  body: string,
  opts: { head?: string; nav?: boolean } = {},
): string {
  modules = ctx.modules?.length ? ctx.modules : modules;
  const nav =
    opts.nav === false
      ? ''
      : `<nav class="lab-nav">${modules
          .filter((m) => m.nav)
          .map((m) => `<a href="${ctx.base}${m.nav}">${esc(m.title)}</a>`)
          .join(
            '',
          )}${ctx.user ? `<span class="lab-user">${esc(ctx.user)}</span><form method="post" action="${ctx.base}/logout" class="lab-logout"><button type="submit">退出登录</button></form>` : ''}</nav>`;
  const hooks = modules
    .map((m) => {
      try {
        return m.shell?.(ctx) ?? '';
      } catch {
        return '';
      }
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Obact Lab</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #222; }
  .lab-nav { display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: #f3f4f6; border-bottom: 1px solid #ddd; }
  .lab-nav a { color: #1d4ed8; text-decoration: none; }
  .lab-user { margin-left: auto; color: #555; }
  .lab-logout { margin: 0; }
  main { padding: 16px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
</style>
${opts.head ?? ''}
</head>
<body data-lab-space="${esc(ctx.space.id)}">
${nav}
<main>
${body}
</main>
${hooks}
</body>
</html>`;
}
