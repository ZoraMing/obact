// 抽取（FR-09、FR-10）：表格翻页、虚拟滚动与接口对账、接口抽取与页面显示值对账。
// 用 Lab 的订单后台（翻页不改 URL）、fixtures 的 virtual-table 与 formatted-numbers。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, currentActionSeq, NetworkCache, ObactError } from '@obact/core';
import type { DomSource } from '@obact/schemas';
import { dataFor, formatValue, parseDisplay } from '../../../fixtures/api/formatted-numbers.ts';
import {
  formatAmount,
  rowsAt,
  STATUS_LABELS,
  type VtRow,
} from '../../../fixtures/api/virtual-table.ts';
import { type FixtureEnv, SKIP, setup } from '../../../fixtures/test/helpers.ts';
import { createLab, type Lab } from '../../../lab/src/app.ts';
import auth from '../../../lab/src/modules/auth.ts';
import type { Order } from '../../../lab/src/modules/orders/data.ts';
import orders from '../../../lab/src/modules/orders.ts';
import { extractFromPage, extractFromResponse, pickPath } from '../src/extract.ts';

describe('抽取（FR-09、FR-10）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  let lab: Lab;
  let cache: NetworkCache;
  before(async () => {
    env = await setup();
    lab = await createLab({ modules: [auth, orders] });
    cache = new NetworkCache(env.session);
    await cache.attach({ rules: [/\/api\/(virtual-table|formatted-numbers)\//], maxPerPage: 200 });
  });
  after(async () => {
    cache?.dispose();
    await lab?.close();
    await env?.close();
  });

  /** 新开标签页：等接口缓存的监听就绪后再导航，页面加载时发出的接口也不会漏。 */
  async function openPage(url: string): Promise<string> {
    const pageId = await env.session.pages.newPage();
    await cache.ready();
    await env.session.pages.get(pageId).goto(url, { waitUntil: 'load' });
    return pageId;
  }

  test('表格翻页：点“下一页”直到不可用，max_pages 限制页数，与接口一致；详情页键值对', async () => {
    const space = 'extract-orders';
    // 登录（HTTP），把会话 cookie 交给浏览器
    const login = await fetch(`${lab.url(space)}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'alice',
        user: 'alice',
        password: 'alice123',
      }).toString(),
      redirect: 'manual',
    });
    const [name, value] = (login.headers.get('set-cookie') ?? '').split(';')[0]?.split('=') ?? [];
    assert.ok(name && value, '登录失败');
    await env.browser.setCookie({
      name,
      value,
      domain: '127.0.0.1',
      path: `/s/${space}/`,
      httpOnly: true,
    });
    const api = (
      (await (
        await fetch(`${lab.url(space)}/api/orders?page_size=500`, {
          headers: { cookie: `${name}=${value}` },
        })
      ).json()) as { items: Order[] }
    ).items;
    assert.equal(api.length, 200);

    const pageId = await openPage(`${lab.url(space)}/orders`);
    const ready = await act(env.session, {
      op: 'wait_for',
      pageId,
      until: [{ text_present: '共 200 条' }],
    });
    assert.equal(ready.status, 'ok');

    const amount = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expected = (list: Order[]) =>
      list.map((o) => ({
        id: o.id,
        link: `${lab.url(space)}/orders/${o.id}`,
        customer: o.customer,
        amount: amount(o.amount),
        status: o.status,
        region: o.region,
        created_at: o.created_at,
      }));
    const turn = (maxPages?: number): DomSource => ({
      type: 'dom',
      kind: 'table',
      root: { css: '#order-table' },
      fields: {
        id: 'td:nth-child(2)',
        link: 'td:nth-child(2) a@href',
        customer: 'td:nth-child(3)',
        amount: 'td:nth-child(4)',
        status: 'td:nth-child(5)',
        region: 'td:nth-child(6)',
        created_at: 'td:nth-child(7)',
      },
      pagination: {
        next: { role: 'button', name: '下一页' },
        ...(maxPages ? { max_pages: maxPages } : {}),
      },
    });

    // 每页 20 条：前 3 页共 60 条，停在第 3 页
    const head = await extractFromPage(env.session, pageId, turn(3));
    assert.deepEqual(head.rows, expected(api.slice(0, 60)));
    assert.equal(head.count, 60);

    // 不限页数：从第 3 页接着翻，到“下一页”被禁用为止（第 3~10 页共 160 条）
    const rest = await extractFromPage(env.session, pageId, turn());
    assert.deepEqual(rest.rows, expected(api.slice(40)));
    assert.equal(rest.count, 160);

    // 不给 fields：表头做字段名（空表头记 colN），当前是最后一页
    const last = await extractFromPage(env.session, pageId, {
      type: 'dom',
      kind: 'table',
      root: { css: '#order-table' },
    });
    assert.equal(last.count, 20);
    assert.deepEqual(
      last.rows.map((r) => [r.订单号, r.客户, r.金额, r.col1]),
      api.slice(180).map((o) => [o.id, o.customer, amount(o.amount), '']),
    );

    // fields 的值写成表头文字：按列取
    const byHeader = await extractFromPage(env.session, pageId, {
      type: 'dom',
      kind: 'table',
      root: { css: '#order-table' },
      fields: { order_no: '订单号', total: '金额' },
    });
    assert.deepEqual(
      byHeader.rows,
      api.slice(180).map((o) => ({ order_no: o.id, total: amount(o.amount) })),
    );

    // 详情页：dt/dd 键值对 → 一行
    const first = api[0] as Order;
    await env.session.pages.get(pageId).goto(`${lab.url(space)}/orders/${first.id}`);
    const kv = await extractFromPage(env.session, pageId, {
      type: 'dom',
      kind: 'kv',
      root: { css: '.o-detail dl' },
    });
    assert.deepEqual(kv.rows, [
      {
        订单号: first.id,
        客户: first.customer,
        金额: `¥${amount(first.amount)}`,
        状态: first.status,
        地区: first.region,
        下单时间: first.created_at,
        审核意见: first.comment || '（无）',
      },
    ]);
  });

  test('虚拟滚动：滚动收集的行不重不漏，与接口数据对账；滚到底自动结束', async () => {
    const seed = 7;
    const pageId = await openPage(`${env.server.base}/virtual-table/?seed=${seed}`);
    const source: DomSource = {
      type: 'dom',
      kind: 'table',
      root: { css: '#grid' },
      scroll: { container: { css: '#viewport' }, max_rounds: 30 },
    };
    /** 接口数据 → 页面上应显示的一行。 */
    const shown = (r: ReturnType<typeof rowsAt>[number]) => ({
      编号: r.id,
      客户: r.customer,
      城市: r.city,
      '金额（元）': formatAmount(r.amount),
      状态: STATUS_LABELS[r.status],
      操作: '查看',
    });

    // 从顶部滚 30 轮：行号连续（相邻两轮的可见范围有重叠，没有漏行；重叠的行只算一次）
    const top = await extractFromPage(env.session, pageId, source, { key: '编号' });
    assert.ok(top.count >= 300, `滚动 30 轮应收集到几百行：${top.count}`);
    assert.deepEqual(top.rows, rowsAt(seed, 0, top.count).map(shown));

    // 页面自己请求的接口数据被缓存了：按“动作之后”取，原值（金额是数值、状态是代码）
    const block = await extractFromResponse(
      cache,
      pageId,
      { type: 'response', url: '/api/virtual-table/rows\\?offset=100&', path: 'rows' },
      currentActionSeq(env.session),
      3000,
    );
    assert.deepEqual(block.rows, rowsAt(seed, 100, 100));
    assert.deepEqual(
      top.rows.slice(100, 200),
      block.rows.map((r) => shown(r as VtRow)),
    );

    // 跳到接近末尾，从当前位置开始：滚到底后连续几轮没有新数据，自己结束（没有靠 max_rounds）
    await env.session.pages
      .get(pageId)
      .evaluate(() => ((document.getElementById('viewport') as HTMLElement).scrollTop = 9900 * 32));
    const tail = await extractFromPage(
      env.session,
      pageId,
      { ...source, scroll: { container: { css: '#viewport' } } },
      { key: '编号', fromCurrent: true },
    );
    assert.equal(tail.rows.at(-1)?.编号, 'R10000');
    assert.ok(tail.count >= 100 && tail.count < 300, `只收集到末尾这一段：${tail.count}`);
    assert.deepEqual(tail.rows, rowsAt(seed, 10000 - tail.count, tail.count).map(shown));
  });

  test('接口抽取：页面抽到的是显示值，接口抽到的是原值；只取动作之后到达的，超时与路径错误报错', async () => {
    const seed = 3;
    const pageId = await openPage('about:blank');
    const nav = await act(env.session, {
      op: 'navigate_page',
      pageId,
      url: `${env.server.base}/formatted-numbers/?seed=${seed}`,
    });
    assert.equal(nav.status, 'ok');
    const afterNav = currentActionSeq(env.session);
    assert.equal(
      (await act(env.session, { op: 'wait_for', pageId, until: [{ text_present: '数据日期' }] }))
        .status,
      'ok',
    );
    // wait_for 也是动作：页面加载时发出的接口响应在它开始之前到达
    const navSeq = afterNav;
    const data = dataFor(seed);

    // 页面：显示值（千分位、万/亿、百分比）
    const kpis = await extractFromPage(env.session, pageId, {
      type: 'dom',
      kind: 'list',
      root: { css: '#kpis' },
      item: '.kpi',
      fields: { key: '@data-key', label: '.label', value: '.value' },
    });
    assert.deepEqual(
      kpis.rows,
      data.kpis.map((k) => ({ key: k.key, label: k.label, value: formatValue(k.value, k.format) })),
    );
    const daily = await extractFromPage(env.session, pageId, {
      type: 'dom',
      kind: 'table',
      root: { css: '#daily' },
    });
    assert.equal(daily.count, 7);
    assert.deepEqual(
      daily.rows.map((r) => r.转化率),
      data.daily.map((d) => formatValue(d.conversion, 'percent')),
    );

    // 接口：原值；页面显示值与原值在显示精度内一致
    const src = (path: string) =>
      ({ type: 'response', url: '/api/formatted-numbers/data', path }) as const;
    const raw = await extractFromResponse(cache, pageId, src('kpis'), navSeq, 3000);
    assert.deepEqual(raw.rows, data.kpis);
    for (const [i, row] of kpis.rows.entries()) {
      const p = parseDisplay(String(row.value));
      assert.ok(p, `认不出显示值 ${row.value}`);
      const k = raw.rows[i] as (typeof data.kpis)[number];
      assert.equal(k.key, row.key);
      assert.ok(
        Math.abs(p.value - k.value) <= p.step / 2 + 1e-9,
        `${k.key}：${row.value} vs ${k.value}`,
      );
    }
    assert.deepEqual(
      (await extractFromResponse(cache, pageId, src('daily'), navSeq, 3000)).rows,
      data.daily,
    );

    // 路径写法与取不到的路径
    const body = { kpis: data.kpis, daily: data.daily };
    assert.equal(pickPath(body, 'kpis[0].key'), 'revenue');
    assert.equal(pickPath(body, 'daily.6.date'), data.daily[6]?.date);
    assert.equal(pickPath(body, ''), body);
    assert.equal(pickPath(body, 'kpis.nope'), undefined);
    await assert.rejects(
      extractFromResponse(cache, pageId, src('nope.list'), navSeq, 500),
      (e) => e instanceof ObactError && e.code === 'not_found',
    );

    // 再做一个动作后，页面加载时的响应就是“动作之前”的了：不再被取到，等不到就超时
    assert.equal(
      (await act(env.session, { op: 'hover', pageId, target: { css: 'h1' } })).status,
      'ok',
    );
    await assert.rejects(
      extractFromResponse(cache, pageId, src('kpis'), currentActionSeq(env.session), 300),
      (e) => e instanceof ObactError && e.code === 'timeout',
    );
  });
});
