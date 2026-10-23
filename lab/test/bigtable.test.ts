// Lab 大表与数据（FR-09、FR-10；BW-1、BW-2、BW-10 的前提）：reset 行数与确定性、分页接口、分页表格、虚拟滚动、无限滚动。
// 只装配 auth 与 bigtable 两个模块。
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Page } from 'puppeteer-core';
import auth from '../src/modules/auth.ts';
import bigtable, { type Row } from '../src/modules/bigtable.ts';
import { control, type LabEnv, loginCookie, SKIP, setup } from './helpers.ts';

describe('大表与数据', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [auth, bigtable] });
  });
  after(async () => {
    await env?.close();
  });
  afterEach(() => env.closePages());

  /** 登录后调 /api/rows（reset 会清掉会话，所以每次重新登录）。 */
  async function rowsOf(space: string, query: string) {
    const headers = { cookie: await loginCookie(env.lab, space) };
    const r = await fetch(`${env.lab.url(space)}/api/rows?${query}`, { headers });
    return { status: r.status, ...((await r.json()) as { rows: Row[]; total: number }) };
  }

  test('接口两种分页一致、参数不合法回 400；reset 的 rows 决定行数，数据只由种子决定', async () => {
    const space = 'bt-api';
    const c = control(env.lab, space);
    const all = await rowsOf(space, 'limit=1000');
    assert.equal(all.total, 1000, '默认 1000 行');
    for (const q of ['page=3&size=20', 'offset=40&limit=20']) {
      assert.deepEqual((await rowsOf(space, q)).rows, all.rows.slice(40, 60), q);
    }
    for (const q of ['limit=0', 'limit=1001', 'offset=-1', 'page=0', 'size=abc']) {
      assert.equal((await rowsOf(space, q)).status, 400, q);
    }
    assert.equal((await fetch(`${env.lab.url(space)}/api/rows`)).status, 401);

    await c.reset({ rows: 30 });
    const small = await rowsOf(space, 'limit=100');
    assert.deepEqual(small.rows, all.rows.slice(0, 30), '行数不同时，小的是大的前缀');
    assert.equal(small.total, 30);
    await c.reset();
    assert.deepEqual((await rowsOf(space, 'limit=1000')).rows, all.rows, '重置后数据相同');
    for (const bad of [{ rows: 0 }, { rows: 20001 }, { row: 5 }] as Record<string, number>[]) {
      assert.equal((await c.reset(bad)).error, 'bad_request', JSON.stringify(bad));
    }
  });

  test('分页表格：1000 行 50 页、每页 20 行，详情链接是主键，最后一页没有“下一页”，详情页显示该行内容', async () => {
    const space = 'bt-paged';
    const headers = { cookie: await loginCookie(env.lab, space) };
    const html = async (path: string) =>
      (await fetch(`${env.lab.url(space)}${path}`, { headers })).text();
    const want = (await rowsOf(space, 'limit=1000')).rows;
    const hrefs: string[] = [];
    let path: string | undefined = '/table/paged';
    let pages = 0;
    for (; path; pages++) {
      const text = await html(path);
      const links = [...text.matchAll(/<tr data-id="(R\d+)"><td>\1<\/td><td><a href="([^"]+)">/g)];
      assert.equal(links.length, 20, `第 ${pages + 1} 页`);
      hrefs.push(...links.map((m) => m[2] as string));
      path = text.match(/<a id="next" rel="next" href="([^"]+)"/)?.[1]?.replace(`/s/${space}`, '');
    }
    assert.equal(pages, 50);
    assert.deepEqual(
      hrefs,
      want.map((x) => `/s/${space}/table/item/${x.id}`),
    );
    const detail = await html(`/table/item/${want[41]?.id}`);
    assert.ok([want[41]?.name, want[41]?.updated].every((v) => detail.includes(`<dd>${v}</dd>`)));
  });

  /** 页面上当前的行（列名 → 文本；价格转成数字，便于和接口比较）。 */
  const shown = (page: Page, selector: string) =>
    page.$$eval(selector, (els) =>
      els.map((e) => {
        const c = Object.fromEntries(
          [...e.querySelectorAll('span')].map((s) => [s.className, s.textContent]),
        );
        return { ...c, price: Number(c.price) } as Record<string, string | number | null>;
      }),
    );

  test('虚拟滚动：只渲染可见行，滚动后换成别的行，内容与接口一致', async () => {
    const space = 'bt-virtual';
    await env.login(space);
    const pageId = await env.open(space, '/table/virtual');
    const page = env.session.pages.get(pageId);
    const sel = '#viewport .row[data-id]';
    await page.waitForSelector(sel);
    const top = await shown(page, sel);
    assert.ok(
      top.length >= 15 && top.length < 30 && top[0]?.id === 'R00001',
      `顶部 ${top.length} 行`,
    );

    await env.ok({ op: 'scroll', pageId, target: { css: '#viewport' }, dy: 32 * 500 });
    await page.waitForSelector('#viewport .row[data-id="R00511"]');
    const middle = await shown(page, sel);
    assert.ok(
      middle.length < 30 && !middle.some((r) => r.id === 'R00001'),
      `滚动后 ${middle.length} 行`,
    );
    const want = (await rowsOf(space, 'limit=1000')).rows;
    assert.deepEqual(
      middle,
      middle.map((r) => want[Number(String(r.id).slice(1)) - 1]),
    );
  });

  test('无限滚动：初始 10 行，滚到底部每次追加 10 行，取完显示“已加载全部”，内容与接口一致', async () => {
    const space = 'bt-scroll';
    await control(env.lab, space).reset({ rows: 25 });
    await env.login(space);
    const pageId = await env.open(space, '/table/scroll');
    const page = env.session.pages.get(pageId);
    const count = (n: number) =>
      page.waitForFunction((n) => document.querySelectorAll('#list .row').length === n, {}, n);
    await count(10);
    for (const n of [20, 25]) {
      await env.ok({ op: 'scroll', pageId, target: { css: '#list' }, dy: 10_000 });
      await count(n);
    }
    await env.ok({ op: 'wait_for', pageId, until: [{ text_present: '已加载全部 25 条' }] });
    assert.deepEqual(await shown(page, '#list .row'), (await rowsOf(space, 'limit=100')).rows);
  });
});
