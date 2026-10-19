// 接口响应缓存（FR-10，PRD 5.6）：不错过约 20 毫秒的响应、按动作序号排除常驻轮询的旧响应、
// 每页淘汰与大小上限、超时。用 fixtures 的 fast-response、polling、virtual-table 夹具。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  act,
  currentActionSeq,
  type NetworkAttachOptions,
  NetworkCache,
  ObactError,
} from '@obact/core';
import { resultFor } from '../../../fixtures/api/fast-response.ts';
import { rowsAt } from '../../../fixtures/api/virtual-table.ts';
import { type FixtureEnv, SKIP, setup } from '../../../fixtures/test/helpers.ts';

type Tick = { tick: number };

describe('接口响应缓存（FR-10）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  const caches: NetworkCache[] = [];
  before(async () => {
    env = await setup();
  });
  after(async () => {
    for (const c of caches) c.dispose();
    await env?.close();
  });

  async function cacheWith(opts: NetworkAttachOptions) {
    const cache = new NetworkCache(env.session);
    caches.push(cache);
    await cache.attach(opts);
    return cache;
  }
  /** 新开标签页并等监听就绪后再导航：页面加载时发出的接口也不会漏。 */
  async function openAfterAttach(cache: NetworkCache, path: string): Promise<string> {
    const pageId = await env.session.pages.newPage();
    await cache.ready();
    await env.session.pages.get(pageId).goto(env.server.base + path, { waitUntil: 'load' });
    return pageId;
  }
  /** 动作返回的序号（act 总会给）。 */
  const seqOf = (r: { action_seq?: number }): number => {
    assert.ok(r.action_seq !== undefined, 'act 返回了 action_seq');
    return r.action_seq;
  };
  const rejectsTimeout = (p: Promise<unknown>) =>
    assert.rejects(p, (e) => e instanceof ObactError && e.code === 'timeout');

  test('点击后约 20 毫秒就返回的响应不会错过：动作之后再取，每次拿到的是本次点击的那一条', async () => {
    const cache = await cacheWith({ rules: [/\/api\/fast-response\/data/] });
    const pageId = await openAfterAttach(cache, '/fast-response/?seed=4');
    for (const n of [1, 2, 3]) {
      const r = await act(env.session, { op: 'click', pageId, target: { css: '#query' } });
      assert.equal(r.status, 'ok');
      const e = await cache.wait(pageId, {
        url: /fast-response\/data/,
        method: 'get',
        afterSeq: seqOf(r),
        timeoutMs: 5000,
      });
      assert.deepEqual(e.body, { ...resultFor(4, n), delay_ms: 20 }, `第 ${n} 次点击`);
      assert.equal(e.seq, seqOf(r), '响应到达时的动作序号就是这次点击');
      assert.equal(e.pageId, pageId);
      assert.deepEqual(cache.get(e.id), e);
    }
    assert.equal(cache.list(pageId).length, 3, '三次响应都在缓存里');
  });

  test('常驻轮询的旧响应不算“动作之后”：只返回动作开始后到达的，没到就等', async () => {
    const cache = await cacheWith({ rules: [/\/api\/polling\/tick/] });
    const pageId = await openAfterAttach(cache, '/polling/');
    const url = /polling\/tick/;
    const first = await cache.wait(pageId, { url, afterSeq: 0, timeoutMs: 5000 });
    const r = await act(env.session, { op: 'click', pageId, target: { css: '#save' } });
    assert.equal(r.status, 'ok');

    // 点击之前到达的 first 的 seq 小于本次动作序号，不会被当成结果
    const next = await cache.wait(pageId, { url, afterSeq: seqOf(r), timeoutMs: 5000 });
    assert.ok(next.seq >= seqOf(r));
    assert.ok((next.body as Tick).tick > (first.body as Tick).tick, '是动作之后才到达的轮询');

    // 序号还没到的（未来的动作）不会被满足，常驻轮询持续到达（每秒一次）也一样，直到超时
    const cached = cache.list(pageId).length;
    await rejectsTimeout(
      cache.wait(pageId, { url, afterSeq: currentActionSeq(env.session) + 100, timeoutMs: 1500 }),
    );
    assert.ok(cache.list(pageId).length > cached, '等待期间轮询的响应确实到达并入了缓存');
  });

  test('每页只留最近 N 条、超过大小的丢弃、不匹配规则的不缓存；各标签页互不影响', async () => {
    // 标签页 A 在 attach 之前就打开了，B 是 attach 之后新开的
    const a = await env.open('/fast-response/');
    const cache = await cacheWith({
      rules: [/\/api\/virtual-table\/rows/],
      maxPerPage: 3,
      maxBytes: 2000,
    });
    const b = await openAfterAttach(cache, '/fast-response/');
    const get = (pageId: string, path: string) =>
      env.session.pages.get(pageId).evaluate((u) => fetch(u).then((r) => r.status), path);
    const rows = (offset: number, limit = 1) =>
      `/api/virtual-table/rows?offset=${offset}&limit=${limit}&seed=1`;

    // 6 条小响应；中间夹一条超大的（100 行，远超 2000 字节）和一条不匹配规则的
    await get(a, rows(0));
    const oldest = await cache.wait(a, { url: /offset=0&/, afterSeq: 0, timeoutMs: 5000 });
    for (const offset of [1, 2]) await get(a, rows(offset));
    await get(a, rows(0, 100));
    await get(a, '/api/fast-response/data?n=1&seed=1');
    for (const offset of [3, 4, 5]) await get(a, rows(offset));
    await get(b, rows(9));
    await cache.wait(a, { url: /offset=5&/, afterSeq: 0, timeoutMs: 5000 });
    await cache.wait(b, { url: /offset=9&/, afterSeq: 0, timeoutMs: 5000 });

    const listed = cache.list(a);
    assert.deepEqual(
      listed.map((e) => new URL(e.url, env.server.base).searchParams.get('offset')),
      ['3', '4', '5'],
      '只剩最近 3 条，最早的被淘汰；超大的和不匹配的都没进缓存',
    );
    assert.ok(listed.every((e) => e.url.includes('limit=1&')));
    assert.deepEqual(
      (listed[2]?.body as { rows: unknown } | undefined)?.rows,
      rowsAt(1, 5, 1),
      'body 是解析后的 JSON',
    );
    assert.equal(cache.list(b).length, 1, '另一个标签页不受影响');
    assert.equal(cache.get(listed[0]?.id as string)?.url, listed[0]?.url);
    assert.equal(cache.get(oldest.id), undefined, '被淘汰的条目取不到');
  });
});
