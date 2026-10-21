/**
 * Obact Lab 服务：把 lab/src/modules/*.ts 的模块装配到一个 HTTP 服务上。
 * 结构说明见 core.ts；启动见 lab/server.ts。
 */
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BodyTooLarge,
  type Ctx,
  DEFAULT_FAULTS,
  esc,
  type LabModule,
  LOG_MAX,
  MAX_BODY,
  page,
  parseFaults,
  parseReset,
  type Route,
  Router,
  type SessionInfo,
  type Space,
  type Submission,
  seeded,
  seedOf,
} from './core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'lab_session';
const SPACE_ID = /^[\w-]{1,64}$/;

export type Lab = {
  /** http://127.0.0.1:端口 */
  base: string;
  /** http://localhost:端口：同一服务的另一个站点，用于跨域 iframe。 */
  crossBase: string;
  /** 某个空间的地址前缀，如 http://127.0.0.1:端口/s/run1 */
  url(space: string, cross?: boolean): string;
  modules: readonly LabModule[];
  close(): Promise<void>;
};

export async function loadModules(): Promise<LabModule[]> {
  const dir = join(here, 'modules');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    // 还没有模块
  }
  const mods: LabModule[] = [];
  for (const f of files) {
    const m = (await import(pathToFileURL(join(dir, f)).href)) as { default?: LabModule };
    if (!m.default) throw new Error(`Lab 模块 ${f} 没有默认导出`);
    mods.push(m.default);
  }
  // 登录模块排在导航最前
  return mods.sort((a, b) => Number(b.name === 'auth') - Number(a.name === 'auth'));
}

function newSpace(
  id: string,
  modules: readonly LabModule[],
  seed = seedOf(id),
  options: Record<string, number> = {},
): Space {
  const space: Space = {
    id,
    seed,
    options,
    data: {},
    faults: { ...DEFAULT_FAULTS },
    sessions: new Map(),
    submissions: new Map(),
    autoKey: 0,
    redesign: { left: null, at: null },
    rng: seeded(seed),
    log: [],
  };
  for (const m of modules) m.init(space);
  return space;
}

/** 百分号解码；编码不合法返回 null（调用方回 400 或保留原文，不能让异常变成 500）。 */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    // 别的本地服务或浏览器配置里残留的 cookie 可能不是百分号编码（foo=100%）：解码失败保留原文
    if (i > 0) {
      const raw = part.slice(i + 1).trim();
      out[part.slice(0, i).trim()] = decode(raw) ?? raw;
    }
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // 超过上限后继续读完但不再缓存：内存有界，客户端也能收到 413 而不是连接重置
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= MAX_BODY) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY) throw new BodyTooLarge(`请求体超过 ${MAX_BODY} 字节`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) return JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createLab(
  opts: {
    port?: number /** 指定模块（测试用）；默认加载 modules 目录 */;
    modules?: LabModule[];
  } = {},
): Promise<Lab> {
  const modules = opts.modules ?? (await loadModules());
  const routes: Route[] = [];
  for (const m of modules) {
    const r = new Router(m.name);
    m.routes(r);
    routes.push(...r.routes);
  }
  // 各模块声明的重置参数（如 orders 的订单数量）合并后交给 parseReset 校验
  const resetOptions = Object.assign({}, ...modules.map((m) => m.resetOptions));
  const spaces = new Map<string, Space>();
  const faultRng = new Map<string, () => number>();

  const getSpace = (id: string): Space => {
    let s = spaces.get(id);
    if (!s) {
      s = newSpace(id, modules);
      spaces.set(id, s);
      faultRng.set(id, seeded(s.seed ^ 0x5bd1e995));
    }
    return s;
  };

  const sessionOf = (space: Space, token: string | undefined): SessionInfo | null => {
    if (!token) return null;
    const s = space.sessions.get(token);
    if (!s) return null;
    const ttl = space.faults.session_ttl_ms;
    if (ttl !== null && Date.now() - s.created > ttl) {
      space.sessions.delete(token);
      space.log.push({ at: new Date().toISOString(), type: 'session_expired', detail: s.user });
      return null;
    }
    return s;
  };

  /** 读控制接口的请求体；JSON 不合法按“不是对象”处理（交给 parseFaults / parseReset 回 400）。 */
  const bodyOrNull = async (ctx: Ctx): Promise<unknown> => {
    try {
      return await ctx.body();
    } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      return null;
    }
  };

  const badRequest = (ctx: Ctx, message: string): true => {
    ctx.json({ error: 'bad_request', message }, 400);
    return true;
  };

  /**
   * 定时改版：每个模块请求（含 /api/，不含控制接口）到达时检查，请求数用完或时间到就把 redesign 切到 redesign_to，只切一次。
   * 设置 redesign_after_requests = N 时，之后的 N 个请求仍是旧版，第 N+1 个请求起是新版。
   */
  const tickRedesign = (space: Space): void => {
    const s = space.redesign;
    let by: 'requests' | 'ms' | null = null;
    if (s.left !== null) {
      if (s.left <= 0) by = 'requests';
      else s.left--;
    }
    if (by === null && s.at !== null && Date.now() >= s.at) by = 'ms';
    if (by === null) return;
    const f = space.faults;
    space.log.push({
      at: new Date().toISOString(),
      type: 'redesign_switch',
      detail: { from: f.redesign, to: f.redesign_to, by },
    });
    f.redesign = f.redesign_to;
    f.redesign_after_requests = null;
    f.redesign_after_ms = null;
    s.left = null;
    s.at = null;
  };

  const control = async (ctx: Ctx, action: string): Promise<boolean> => {
    const { space } = ctx;
    if (action === 'state' && ctx.req.method === 'GET') {
      const mods: Record<string, unknown> = {};
      for (const m of modules) if (m.state) mods[m.name] = m.state(space);
      ctx.json({
        space: space.id,
        seed: space.seed,
        options: space.options,
        faults: space.faults,
        sessions: [...space.sessions.values()].map((s) => ({
          user: s.user,
          created: new Date(s.created).toISOString(),
        })),
        submissions: [...space.submissions.values()],
        log: space.log.slice(-LOG_MAX),
        modules: mods,
      });
      return true;
    }
    if (action === 'reset' && ctx.req.method === 'POST') {
      const parsed = parseReset(await bodyOrNull(ctx), resetOptions);
      if ('error' in parsed) return badRequest(ctx, parsed.error);
      const seed = parsed.seed ?? seedOf(space.id);
      const fresh = newSpace(space.id, modules, seed, parsed.options);
      spaces.set(space.id, fresh);
      faultRng.set(space.id, seeded(seed ^ 0x5bd1e995));
      ctx.json({ ok: true, space: space.id, seed, options: parsed.options });
      return true;
    }
    if (action === 'faults' && ctx.req.method === 'POST') {
      const parsed = parseFaults(await bodyOrNull(ctx));
      if ('error' in parsed) return badRequest(ctx, parsed.error);
      Object.assign(space.faults, parsed.faults);
      // 定时改版从设置的这一刻开始计
      const { redesign_after_requests: n, redesign_after_ms: ms } = parsed.faults;
      if (n !== undefined) space.redesign.left = n;
      if (ms !== undefined) space.redesign.at = ms === null ? null : Date.now() + ms;
      space.log.push({ at: new Date().toISOString(), type: 'faults', detail: parsed.faults });
      ctx.json(space.faults);
      return true;
    }
    return false;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/_lab/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end('{"ok":true}');
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return void res.end();
    }
    const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) {
      res.writeHead(302, { location: '/s/default/' });
      return void res.end();
    }
    const id = decode(m[1] as string);
    if (id === null || !SPACE_ID.test(id))
      return void res.writeHead(400).end('空间名只能用字母、数字、_ 和 -');
    if (m[2] === undefined) {
      res.writeHead(302, { location: `/s/${id}/` });
      return void res.end();
    }
    const rest = m[2];
    const space = getSpace(id);
    // 事件日志只留最近 LOG_MAX 条：长时间不 reset 的浸泡里不能无限增长
    if (space.log.length > LOG_MAX) space.log.splice(0, space.log.length - LOG_MAX);
    const base = `/s/${id}`;
    const cookies = parseCookies(req.headers.cookie);
    let bodyCache: Promise<Record<string, unknown>> | null = null;
    const session = sessionOf(space, cookies[SESSION_COOKIE]);
    const ctx: Ctx = {
      req,
      res,
      url,
      space,
      base,
      modules,
      params: {},
      user: session?.user ?? null,
      session,
      body: () => {
        bodyCache ??= readBody(req);
        return bodyCache;
      },
      json(data, status = 200) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      },
      html(body, status = 200) {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      },
      redirect(location) {
        res.writeHead(303, { location });
        res.end();
      },
      setCookie(name, value, o = {}) {
        const parts = [
          `${name}=${encodeURIComponent(value)}`,
          `Path=${base}/`,
          'HttpOnly',
          'SameSite=Lax',
        ];
        if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
        const prev = res.getHeader('set-cookie');
        res.setHeader('set-cookie', [
          ...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []),
          parts.join('; '),
        ]);
      },
      cookie: (name) => cookies[name],
      signIn(user) {
        const token = randomBytes(16).toString('hex');
        const created: SessionInfo = { token, user, created: Date.now() };
        space.sessions.set(token, created);
        ctx.setCookie(SESSION_COOKIE, token);
        ctx.user = user;
        ctx.session = created;
        space.log.push({ at: new Date().toISOString(), type: 'login', detail: user });
      },
      signOut() {
        const t = cookies[SESSION_COOKIE];
        if (t) space.sessions.delete(t);
        ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
        ctx.user = null;
        ctx.session = null;
      },
      record(op, key, payload) {
        const k = key || `auto-${++space.autoKey}`;
        const now = new Date().toISOString();
        const prev = space.submissions.get(k);
        // 重复提交保留首次的载荷（实际落库的是它）；同键但操作或载荷不同的标 conflict，对账时能看出键被复用
        const reused =
          prev && (prev.op !== op || JSON.stringify(prev.payload) !== JSON.stringify(payload));
        const sub: Submission = prev
          ? { ...prev, count: prev.count + 1, last_at: now, ...(reused ? { conflict: true } : {}) }
          : { key: k, op, count: 1, first_at: now, last_at: now, payload };
        space.submissions.set(k, sub);
        space.log.push({ at: now, type: 'submit', detail: { key: k, op, count: sub.count } });
        return sub;
      },
    };

    const ctl = /^\/_lab\/(\w+)$/.exec(rest);
    if (ctl && (await control(ctx, ctl[1] as string))) return;

    if (rest === '/' && req.method === 'GET') {
      const items = modules
        .filter((x) => x.nav)
        .map((x) => `<li><a href="${base}${x.nav}">${esc(x.title)}</a></li>`)
        .join('');
      return ctx.html(page(ctx, modules, '首页', `<h1>Obact Lab</h1><ul>${items}</ul>`));
    }

    const route = routes.find((r) => r.method === req.method && r.pattern.test(rest));
    if (!route) {
      return ctx.html(page(ctx, modules, '未找到', '<h1>页面不存在</h1>'), 404);
    }
    const hit = route.pattern.exec(rest) as RegExpExecArray;
    for (const [i, k] of route.keys.entries()) {
      const v = decode(hit[i + 1] as string);
      if (v === null)
        return ctx.json({ error: 'bad_request', message: `路径参数 ${k} 的百分号编码不合法` }, 400);
      ctx.params[k] = v;
    }
    const isApi = rest.startsWith('/api/');
    tickRedesign(space);

    if (route.opts.auth && !ctx.user) {
      if (isApi) return ctx.json({ error: 'unauthorized' }, 401);
      return ctx.redirect(`${base}/login?next=${encodeURIComponent(rest + url.search)}`);
    }

    if (isApi) {
      const f = space.faults;
      const rng = faultRng.get(space.id) as () => number;
      if (f.delay_ms > 0) await sleep(f.delay_ms);
      // 提交超时与丢弃响应都是“写操作已执行、客户端拿不到响应”：把响应函数换成空操作再执行
      const swallowResponse = () => {
        ctx.json = () => {};
        ctx.html = () => {};
        ctx.redirect = () => {};
      };
      if (f.drop_rate > 0 && rng() < f.drop_rate) {
        space.log.push({ at: new Date().toISOString(), type: 'fault_drop', detail: rest });
        if (route.opts.commit) {
          // 写接口照常执行并落库，再断开连接：客户端看到的是连接重置，状态未明
          swallowResponse();
          await route.handler(ctx);
        }
        return void req.socket.destroy();
      }
      if (f.error_rate > 0 && rng() < f.error_rate) {
        space.log.push({ at: new Date().toISOString(), type: 'fault_500', detail: rest });
        return ctx.json({ error: 'injected_500' }, 500);
      }
      if (route.opts.commit && f.commit_timeout) {
        // 提交超时但已落库：照常执行写操作，但吞掉响应，让客户端等到超时
        space.log.push({
          at: new Date().toISOString(),
          type: 'fault_commit_timeout',
          detail: rest,
        });
        swallowResponse();
        await route.handler(ctx);
        return;
      }
    }
    await route.handler(ctx);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof BodyTooLarge) {
        if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json' });
        return void res.end('{"error":"payload_too_large"}');
      }
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String((e as Error).stack ?? e));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法获取端口');
  const base = `http://127.0.0.1:${addr.port}`;
  const crossBase = `http://localhost:${addr.port}`;
  return {
    base,
    crossBase,
    url: (space, cross = false) => `${cross ? crossBase : base}/s/${space}`,
    modules,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
