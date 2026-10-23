// 模板渲染（FR-16，DESIGN 约定 4）：{{param:名称}}、{{var:路径}}、{{file:路径}}，以及敏感值脱敏（FR-22 / DEV_PLAN 第 6 节规则 6）。
import { ObactError } from '@obact/core';
import type { Scope } from './types.ts';

export type TemplateKind = 'param' | 'var' | 'file';

/** 一处模板引用。kind 可能不是三种之一（写错了），由调用方决定怎么报。 */
export type TemplateRef = { kind: string; name: string; raw: string };

const KINDS: ReadonlySet<string> = new Set<TemplateKind>(['param', 'var', 'file']);
/** 名称里不允许花括号，所以模板不会嵌套；渲染结果只渲染一遍，不会被二次渲染。 */
const TEMPLATE = /\{\{\s*([A-Za-z_]\w*)\s*:\s*([^{}]*?)\s*\}\}/g;
const SENSITIVE = /password|token|secret/i;

/** 脱敏后的显示值。 */
export const MASK = '***';

/** 名称是否敏感：含 password、token、secret（不分大小写）。参数库与模板共用这一条规则。 */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE.test(name);
}

// ---------- 路径 ----------

const PATH_SHAPE = /^[^.[\]]+(?:\.[^.[\]]+|\[\d+\])*$/;

/** 解析 a.b[0].c 为 ['a','b',0,'c']；写法不合法返回 null。 */
export function parsePath(path: string): (string | number)[] | null {
  if (!PATH_SHAPE.test(path)) return null;
  const segs: (string | number)[] = [];
  for (const m of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    segs.push(m[1] !== undefined ? Number(m[1]) : (m[2] as string));
  }
  return segs;
}

/** 沿路径取值，只认自有属性（不会取到 constructor、__proto__ 这类原型上的东西）。 */
function getPath(root: unknown, segs: (string | number)[]): { found: boolean; value?: unknown } {
  let cur = root;
  for (const seg of segs) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, seg)) {
      return { found: false };
    }
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur === undefined ? { found: false } : { found: true, value: cur };
}

// ---------- 扫描 ----------

/** 深度扫描值里所有字符串中的模板引用（用于加载时的静态检查）。 */
export function listTemplates(value: unknown): TemplateRef[] {
  const out: TemplateRef[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TEMPLATE)) {
        out.push({ kind: m[1] as string, name: m[2] as string, raw: m[0] });
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isPlainObject(v)) {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(value);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------- 脱敏 ----------

/**
 * 深度复制并脱敏：名称敏感的键，其值整个输出 '***'（不论类型）。
 * 只处理数组与普通对象；循环引用输出占位文字而不是死循环。
 */
export function redact(
  value: unknown,
  isSensitive: (name: string) => boolean = isSensitiveName,
): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v) || isPlainObject(v)) {
      if (seen.has(v)) return '[循环引用]';
      seen.add(v);
      try {
        if (Array.isArray(v)) return v.map(walk);
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = isSensitive(k) ? MASK : walk(x);
        return out;
      } finally {
        seen.delete(v);
      }
    }
    return v;
  };
  return walk(value);
}

/** 值里字符串、数字叶子的文本；onlySensitive：只取名称敏感的键下面的。 */
function leaves(value: unknown, out: Set<string>, onlySensitive: boolean): void {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, hot: boolean): void => {
    if (Array.isArray(v) || isPlainObject(v)) {
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) for (const x of v) walk(x, hot);
      else for (const [k, x] of Object.entries(v)) walk(x, hot || isSensitiveName(k));
    } else if (hot && (typeof v === 'string' || typeof v === 'number')) out.add(String(v));
  };
  walk(value, !onlySensitive);
}

function hasSensitiveKey(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): boolean => {
    if (!Array.isArray(v) && !isPlainObject(v)) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some(walk);
    return Object.entries(v).some(([k, x]) => isSensitiveName(k) || walk(x));
  };
  return walk(value);
}

// ---------- 渲染 ----------

export type RenderTrace = {
  /** 渲染结果。 */
  value: unknown;
  /** 是否用到了敏感内容：模板名称含 password|token|secret，或引入的值里有名称敏感的键。 */
  sensitive: boolean;
  /** 可以安全写进日志与留痕的版本：渲染自敏感内容的字符串整个换成 '***'，敏感键的值也打码。 */
  redacted: unknown;
  /**
   * 本次渲染引入的敏感值原文（字符串、数字叶子的文本）：名称敏感的模板取整个值，引入的值里有敏感键的取敏感键下的值。
   * 供调用方做值级脱敏——执行器的错误消息可能把渲染后的值（如 URL 里的 api_token）原样带出来。
   */
  secrets: string[];
};

export type TraceOptions = {
  /**
   * 额外的敏感判断，与按名称的判断取并集。runner 用它标记“由敏感参数赋值而来的变量”
   * （set_var 把密码存进变量后，后面再引用该变量同样要打码）。
   */
  isSensitive?: (kind: TemplateKind, name: string) => boolean;
};

function notFound(raw: string, kind: string, name: string, what: string): ObactError {
  return new ObactError('invalid_params', `模板 ${raw} 找不到${what}：${name}`, {
    template: raw,
    kind,
    name,
  });
}

function resolveRef(ref: TemplateRef, scope: Scope): unknown {
  const { kind, name, raw } = ref;
  if (!KINDS.has(kind)) {
    throw new ObactError(
      'invalid_params',
      `模板 ${raw} 的类型 ${kind} 不存在（可用 param、var、file）`,
      {
        template: raw,
        kind,
      },
    );
  }
  if (!name) {
    throw new ObactError('invalid_params', `模板 ${raw} 缺少名称`, { template: raw, kind });
  }
  if (kind === 'param') {
    let v = scope.param(name);
    if (v === undefined) {
      // 参数值可以是对象：{{param:account.user}} 取参数 account 的 user 字段
      const segs = parsePath(name);
      if (segs && segs.length > 1) {
        const head = scope.param(String(segs[0]));
        const r = head === undefined ? { found: false } : getPath(head, segs.slice(1));
        if (r.found) v = r.value;
      }
    }
    if (v === undefined) throw notFound(raw, kind, name, '参数');
    return v;
  }
  if (kind === 'var') {
    const segs = parsePath(name);
    if (!segs) {
      throw new ObactError('invalid_params', `模板 ${raw} 的变量路径写法不对（应为 a.b[0].c）`, {
        template: raw,
        kind,
        name,
      });
    }
    const r = getPath(scope.vars, segs);
    if (!r.found) throw notFound(raw, kind, name, '变量');
    return r.value;
  }
  const v = scope.file(name);
  if (v === undefined) throw notFound(raw, kind, name, '文件');
  return v;
}

/** 插值进文本时的写法：字符串原样，null 为空文本，对象与数组为 JSON。 */
function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function render(value: unknown, scope: Scope, opts: TraceOptions, trace: boolean): RenderTrace {
  let sensitive = false;
  const secrets = new Set<string>();

  /** mask：名称敏感，渲染结果整个打码；keyed：引入的值里有敏感键，对象整体保留、由 redact 按键打码。 */
  const one = (ref: TemplateRef): { value: unknown; mask: boolean; keyed: boolean } => {
    const v = resolveRef(ref, scope);
    if (!trace) return { value: v, mask: false, keyed: false };
    const mask =
      isSensitiveName(ref.name) ||
      (opts.isSensitive?.(ref.kind as TemplateKind, ref.name) ?? false);
    const keyed = !mask && hasSensitiveKey(v);
    if (mask || keyed) {
      sensitive = true;
      leaves(v, secrets, keyed);
    }
    return { value: v, mask, keyed };
  };

  const walk = (node: unknown): [unknown, unknown] => {
    if (typeof node === 'string') {
      const matches = [...node.matchAll(TEMPLATE)];
      if (matches.length === 0) return [node, node];
      const first = matches[0] as RegExpMatchArray;
      const refOf = (m: RegExpMatchArray): TemplateRef => ({
        kind: m[1] as string,
        name: m[2] as string,
        raw: m[0],
      });
      if (matches.length === 1 && first[0].length === node.length) {
        // 整体是单个模板：保持原类型
        const r = one(refOf(first));
        return [r.value, r.mask ? MASK : r.value];
      }
      let anySens = false;
      const text = node.replace(TEMPLATE, (raw: string, kind: string, name: string) => {
        const r = one({ kind, name, raw });
        if (r.mask || r.keyed) anySens = true;
        return toText(r.value);
      });
      return [text, anySens ? MASK : text];
    }
    if (Array.isArray(node)) {
      const pairs = node.map(walk);
      return [pairs.map((p) => p[0]), trace ? pairs.map((p) => p[1]) : undefined];
    }
    if (isPlainObject(node)) {
      const rendered: Record<string, unknown> = {};
      const shown: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(node)) {
        const [v, r] = walk(x);
        rendered[k] = v;
        shown[k] = r;
      }
      return [rendered, trace ? shown : undefined];
    }
    return [node, node];
  };

  const [rendered, shown] = walk(value);
  return {
    value: rendered,
    sensitive,
    redacted: trace ? redact(shown) : undefined,
    secrets: [...secrets],
  };
}

/**
 * 深度渲染对象、数组、字符串里的模板。
 * 字符串整体是单个模板时返回引用值的原类型（数组、对象、数字……）；混合文本插值为字符串。
 * 找不到变量、参数或文件报 invalid_params，消息里带模板原文。
 */
export function renderTemplate(value: unknown, scope: Scope): unknown {
  return render(value, scope, {}, false).value;
}

/** 渲染并给出脱敏信息：runner 写日志、留痕、检查点时用 redacted，不要用 value。 */
export function renderWithTrace(
  value: unknown,
  scope: Scope,
  opts: TraceOptions = {},
): RenderTrace {
  return render(value, scope, opts, true);
}
