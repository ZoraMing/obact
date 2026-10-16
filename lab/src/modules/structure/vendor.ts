/**
 * 组件库静态资源：把 @shoelace-style/shoelace 的 cdn 目录按路径提供出来（/structure/vendor/shoelace/...）。
 *
 * Router 的路径参数只匹配单段，所以按目录深度（1 ~ 5 层）各注册一条路由，再把各段拼回相对路径。
 * 防目录穿越：参数已经过 URL 解码，所以先拒绝含 / \ NUL 和 . .. 的段；
 * 再解析成绝对路径，要求落在 cdn 目录之内（realpath 之后也要在其内，防符号链接逃逸）；只提供 js、css、svg、json。
 */
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx, Router } from '../../core.ts';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** 对外路径前缀（相对空间）。 */
export const VENDOR_PREFIX = '/structure/vendor/shoelace';
const MAX_DEPTH = 5;

/** Shoelace 的 cdn 目录；包没装时返回 null（路由回 404 并提示安装）。 */
export function shoelaceRoot(): string | null {
  try {
    // 包的 exports 没有开放 package.json 和 cdn，所以从入口文件（dist/shoelace.js）往上找
    const entry = fileURLToPath(import.meta.resolve('@shoelace-style/shoelace'));
    return join(dirname(dirname(entry)), 'cdn');
  } catch {
    return null;
  }
}

/** 把路径段解析成 root 下的文件路径；不合法返回 null。 */
export function safeResolve(root: string, segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || /[\\/\0]/.test(s)) return null;
  }
  const full = resolve(root, ...segments);
  const base = resolve(root);
  if (!full.startsWith(base + sep)) return null;
  return full;
}

async function serve(ctx: Ctx, root: string | null, segments: string[]): Promise<void> {
  const notFound = () => {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('资源不存在');
  };
  if (!root) {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return void ctx.res.end('未安装 @shoelace-style/shoelace：请在仓库根目录运行 npm install');
  }
  const type = MIME[extname(segments[segments.length - 1] as string).toLowerCase()];
  const full = safeResolve(root, segments);
  if (!type || !full) return notFound();
  try {
    const real = await realpath(full);
    if (!real.startsWith((await realpath(root)) + sep)) return notFound();
    const body = await readFile(real);
    ctx.res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.length),
      'cache-control': 'public, max-age=3600',
    });
    ctx.res.end(body);
  } catch {
    notFound();
  }
}

/** 注册 /structure/vendor/shoelace/** 路由。 */
export function vendorRoutes(r: Router): void {
  const root = shoelaceRoot();
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const keys = Array.from({ length: depth }, (_, i) => `p${i}`);
    r.get(`${VENDOR_PREFIX}/${keys.map((k) => `:${k}`).join('/')}`, (ctx) =>
      serve(
        ctx,
        root,
        keys.map((k) => ctx.params[k] as string),
      ),
    );
  }
}
