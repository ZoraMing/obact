// 夹具服务本身（不需要浏览器）：畸形请求不能让进程退出，静态路径不能逃出页面目录。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveStatic } from '../../tools/static.ts';
import { type FixtureServer, PAGES, startFixtures } from '../server.ts';

describe('夹具服务：畸形请求与静态路径', () => {
  let server: FixtureServer;
  before(async () => {
    server = await startFixtures();
  });
  after(async () => {
    await server?.close();
  });

  // 出问题时请求得不到响应，超时让它明确失败而不是一直挂着
  const get = (path: string) => fetch(server.base + path, { signal: AbortSignal.timeout(5000) });

  test('非法百分号编码与非法请求目标回 400，服务继续可用', async () => {
    // fetch 对 %E0%A4%A 原样发出；// 发出的请求行是 GET //（new URL 解析会抛）
    for (const path of ['/%E0%A4%A', '/%', '//']) {
      assert.equal((await get(path)).status, 400, `${path} 应回 400`);
    }
    // 之前直接 TypeError / URIError 让进程退出：再请求一次页面和接口
    assert.equal((await get('/timing/')).status, 200);
    assert.equal((await get('/api/polling/tick')).status, 200);
  });

  test('路径逃到名字以 pages 开头的同级目录回 403（%2f 绕过 URL 规范化）', async () => {
    assert.equal((await get('/..%2fpages-private/secret.txt')).status, 403);
  });

  test('resolveStatic：根目录内放行，越界、同名前缀的兄弟目录和非法编码被拒', () => {
    assert.deepEqual(resolveStatic(PAGES, '/timing/index.html'), {
      file: join(PAGES, 'timing', 'index.html'),
    });
    assert.deepEqual(resolveStatic(PAGES, '/a%20b.txt'), { file: join(PAGES, 'a b.txt') });
    assert.deepEqual(resolveStatic(PAGES, '/..%2f..%2fpackage.json'), { status: 403 });
    assert.deepEqual(resolveStatic(PAGES, '/..%2fpages-private/x'), { status: 403 });
    assert.deepEqual(resolveStatic(PAGES, '/%E0%A4%A'), { status: 400 });
    // root 末尾带分隔符（如环境变量里写的目录）也按同一个根判断
    assert.deepEqual(resolveStatic(`${PAGES}/`, '/..%2fpages-private/x'), { status: 403 });
  });
});
