/**
 * 夹具服务（PRD 9.3 本地夹具库）：静态页面 + 夹具接口。每个夹具的结果完全确定。
 *
 * - 页面：fixtures/pages/<夹具名>/...，按路径 /<夹具名>/... 访问。
 * - 接口：fixtures/api/*.ts 启动时自动加载；每个模块导出 `routes`（路径 → 处理函数），
 *   可选导出 `upgrades`（路径 → WebSocket 升级处理函数）。接口路径统一以 /api/<夹具名>/ 开头。
 * - 同一服务有两个站点：base（127.0.0.1）与 crossBase（localhost），用来构造跨域 iframe 和新标签页。
 * - 需要“随机”的夹具一律用 URL 参数 seed 决定，不读 Math.random。
 *
 * 命令行：node fixtures/server.ts [--port 8710]
 */
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PAGES = join(here, 'pages');
const API_DIR = join(here, 'api');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export type FixtureCtx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** 读完整请求体（文本）。 */
  body(): Promise<string>;
  /** 发送 JSON。 */
  json(data: unknown, status?: number): void;
};
export type FixtureHandler = (ctx: FixtureCtx) => void | Promise<void>;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type FixtureServer = {
  /** http://127.0.0.1:端口 */
  base: string;
  /** http://localhost:端口：同一服务的另一个站点，用于跨域 iframe。 */
  crossBase: string;
  close(): Promise<void>;
};

async function loadApi(): Promise<{
  routes: Record<string, FixtureHandler>;
  upgrades: Record<string, UpgradeHandler>;
}> {
  const routes: Record<string, FixtureHandler> = {};
  const upgrades: Record<string, UpgradeHandler> = {};
  let files: string[] = [];
  try {
    files = (await readdir(API_DIR)).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    // 还没有接口模块
  }
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(API_DIR, f)).href)) as {
      routes?: Record<string, FixtureHandler>;
      upgrades?: Record<string, UpgradeHandler>;
    };
    for (const [path, h] of Object.entries(mod.routes ?? {})) {
      if (routes[path]) throw new Error(`夹具接口路径重复：${path}（${f}）`);
      routes[path] = h;
    }
    Object.assign(upgrades, mod.upgrades ?? {});
  }
  return { routes, upgrades };
}

export async function startFixtures(opts: { port?: number } = {}): Promise<FixtureServer> {
  const { routes, upgrades } = await loadApi();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const handler = routes[url.pathname];
    if (handler) {
      const ctx: FixtureCtx = {
        req,
        res,
        url,
        body: async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          return Buffer.concat(chunks).toString('utf8');
        },
        json: (data, status = 200) => {
          res.writeHead(status, { 'content-type': TYPES['.json'] as string });
          res.end(JSON.stringify(data));
        },
      };
      try {
        await handler(ctx);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      }
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(PAGES, path));
    if (!file.startsWith(PAGES)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const h = upgrades[new URL(req.url ?? '/', 'http://x').pathname];
    if (h) h(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法获取端口');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    crossBase: `http://localhost:${addr.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port');
  const s = await startFixtures({ port: i > 0 ? Number(process.argv[i + 1]) : 8710 });
  console.log(`夹具服务：${s.base}/（跨域站点 ${s.crossBase}/）`);
}
