// 浏览器测试助手：本机静态服务 + 无头浏览器 + 会话。各模块的测试共用。

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'puppeteer-core';
import { skipIfNoBrowser, testChrome, testFullChrome } from '../../../tools/browser.ts';
import { launchBrowser, Session } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..', '..');

export const CHROME = await testChrome();
/** 有头测试需要完整 Chrome（chrome-headless-shell 不能有头）。 */
export const FULL_CHROME = await testFullChrome();
/** 传给 describe/test 的 skip 选项：没有浏览器时跳过并说明原因（OBACT_REQUIRE_BROWSER=1 时直接失败）。 */
export const SKIP: false | string = skipIfNoBrowser(CHROME);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** 路由：路径前缀 → 本地目录；/api/ 下可注册自定义处理函数。 */
const MOUNTS: Record<string, string> = {
  '/fixtures/': join(REPO, 'fixtures'),
  '/pages/': join(here, 'pages'),
};

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export type TestServer = {
  /** http://127.0.0.1:端口 */
  base: string;
  /** 同一服务的另一个站点 http://localhost:端口，用于构造跨域 iframe。 */
  crossBase: string;
  close(): Promise<void>;
};

export async function startServer(api: Record<string, Handler> = {}): Promise<TestServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const handler = api[url.pathname];
    if (handler) return void (await handler(req, res));
    const mount = Object.keys(MOUNTS).find((m) => url.pathname.startsWith(m));
    if (!mount) return void res.writeHead(404).end();
    const root = MOUNTS[mount] as string;
    const file = normalize(join(root, decodeURIComponent(url.pathname.slice(mount.length))));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('无法获取端口');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    crossBase: `http://localhost:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export type TestEnv = {
  server: TestServer;
  browser: Browser;
  session: Session;
  /** 新开标签页打开 base + path，等到 load；返回 pageId。 */
  open(
    path: string,
    opts?: { pageId?: string; waitUntil?: 'load' | 'domcontentloaded' },
  ): Promise<string>;
  close(): Promise<void>;
};

/** 启动服务、无头浏览器（HEADED=1 时有头）和会话。 */
export async function setup(api: Record<string, Handler> = {}): Promise<TestEnv> {
  const server = await startServer(api);
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-test-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath: CHROME,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
  });
  const session = await Session.attach(browser);
  return {
    server,
    browser,
    session,
    async open(path, opts = {}) {
      const pageId = await session.pages.newPage({ pageId: opts.pageId });
      const page = session.pages.get(pageId);
      await page.goto(server.base + path, { waitUntil: opts.waitUntil ?? 'load' });
      return pageId;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await server.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

/** 断言 promise 以指定 code 的 ObactError 失败。 */
export async function rejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = (e as { code?: string }).code;
    if (got === code) return;
    throw new Error(`期望错误 ${code}，实际 ${got ?? (e as Error).message}`);
  }
  throw new Error(`期望错误 ${code}，实际成功`);
}
