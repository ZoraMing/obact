// 夹具：动态属性（FR-06、FR-07）。id 与哈希类名每次加载都变，同名按钮靠业务主键（订单号）消歧。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, observe } from '@obact/core';
import type { Action, ActResult, Locator } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
type LogEntry = { op: string; order: string | null };

describe('夹具 dynamic-attrs（FR-06、FR-07）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function run(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const page = (pageId: string) => env.session.pages.get(pageId);
  /** 页面上所有 id 与类名（除挂载点 #root 外全部是动态生成的）。 */
  const tokens = (pageId: string) =>
    page(pageId).evaluate(() => {
      const out = new Set<string>();
      for (const el of document.querySelectorAll('*')) {
        if (el.id && el.id !== 'root') out.add(el.id);
        for (const c of el.classList) out.add(c);
      }
      return [...out].sort();
    });
  const rowOrder = (pageId: string) =>
    page(pageId).$$eval('tr[data-row-key]', (rows) =>
      rows.map((r) => (r as HTMLElement).dataset.rowKey as string),
    );
  const log = (pageId: string) =>
    page(pageId).evaluate(() => (window as unknown as { __log: LogEntry[] }).__log);

  test('同一 seed 结果相同；换 seed 或不带 seed 时 id、类名、行顺序都变', async () => {
    const a = await env.open('/dynamic-attrs/?seed=11');
    const b = await env.open('/dynamic-attrs/?seed=11');
    const c = await env.open('/dynamic-attrs/?seed=12');
    const ta = await tokens(a);
    assert.ok(ta.length > 40, `动态属性数量 ${ta.length}`);
    assert.deepEqual(await tokens(b), ta, '同一 seed 的 id 与类名相同');
    assert.deepEqual(await rowOrder(b), await rowOrder(a), '同一 seed 的行顺序相同');
    const tc = await tokens(c);
    assert.deepEqual(
      tc.filter((t) => ta.includes(t)),
      [],
      '换 seed 后没有沿用的 id 与类名',
    );
    assert.notDeepEqual(await rowOrder(c), await rowOrder(a), '换 seed 后行顺序变化');

    const r1 = await env.open('/dynamic-attrs/');
    const r2 = await env.open('/dynamic-attrs/');
    const t1 = await tokens(r1);
    const t2 = await tokens(r2);
    const shared = t1.filter((t) => t2.includes(t)).length;
    assert.ok(shared / t1.length < 0.2, `不带 seed 时每次不同（重合 ${shared}/${t1.length}）`);
    for (const id of [a, b, c, r1, r2]) await run({ op: 'close_page', pageId: id });
  });

  test('定位器不含动态 id 与哈希类名，同名按钮带业务主键 within', async () => {
    const pageId = await env.open('/dynamic-attrs/?seed=11');
    const dynamic = await tokens(pageId);
    const ob = await observe(env.session, { pageId });
    const rowButtons = ob.elements.filter((e) => ['编辑', '删除', '详情'].includes(e.name));
    assert.equal(rowButtons.length, 18, '6 行 × 3 个操作');
    for (const e of ob.elements) {
      const { locator, unique } = await generateLocator(env.session, pageId, e.ref);
      const text = JSON.stringify(locator);
      assert.ok(unique, `${e.name} 应唯一：${text}`);
      const leaked = dynamic.filter((t) => text.includes(t));
      assert.deepEqual(leaked, [], `${e.name} 的定位器含动态值：${text}`);
      assert.doesNotMatch(text, /css-|sc-|__|ember|:r/, `${e.name}：${text}`);
      if (['编辑', '删除', '详情'].includes(e.name)) {
        assert.match(locator.within ?? '', /^tr\[data-row-key='SO-2400\d'\]$/, text);
        assert.equal(e.within, locator.within, 'observe 给出的 within 与定位器一致');
        assert.equal(locator.css, undefined, `行内按钮只有动态属性，不给 CSS：${text}`);
      }
    }
    await run({ op: 'close_page', pageId });
  });

  test('换 seed 重新加载后，用同一个定位器点中的是同一订单行', async () => {
    const pageId = await env.open('/dynamic-attrs/?seed=11');
    const ob = await observe(env.session, { pageId });
    const saved = new Map<string, Locator>();
    for (const e of ob.elements) {
      const { locator } = await generateLocator(env.session, pageId, e.ref);
      const order = /SO-\d+/.exec(e.within ?? '')?.[0];
      saved.set(order ? `${e.name}:${order}` : e.name, locator);
    }
    const before = { tokens: await tokens(pageId), order: await rowOrder(pageId) };

    const plan: [string, string][] = [
      ['编辑', 'SO-24003'],
      ['删除', 'SO-24005'],
      ['编辑', 'SO-24001'],
      ['删除', 'SO-24006'],
      ['查看', 'SO-24002'],
      ['编辑', 'SO-24004'],
    ];
    for (const seed of ['12', '31337', '']) {
      const url = `${env.server.base}/dynamic-attrs/${seed ? `?seed=${seed}` : ''}`;
      const nav = await ok({ op: 'navigate_page', pageId, url });
      assert.equal(nav.effects.navigated, true);
      const now = await tokens(pageId);
      const kept = now.filter((t) => before.tokens.includes(t)).length;
      assert.ok(kept < 10, `seed=${seed || '随机'} 后 id 与类名已变（沿用 ${kept} 个）`);
      if (seed) assert.notDeepEqual(await rowOrder(pageId), before.order, '行顺序已变');

      for (const [op, order] of plan) {
        const name = op === '查看' ? '详情' : op;
        const target = saved.get(`${name}:${order}`);
        assert.ok(target, `${name}:${order}`);
        const r = await ok({
          op: 'click',
          pageId,
          target,
          post: [
            {
              expr: `(() => { const l = window.__log.at(-1); return l && l.op === '${op}' && l.order === '${order}'; })()`,
            },
          ],
        });
        assert.equal(r.locator_used, 'role');
      }
      const search = saved.get('按订单号或客户搜索') as Locator;
      const query = saved.get('查询') as Locator;
      await ok({ op: 'fill', pageId, target: search, value: 'SO-24003' });
      await ok({
        op: 'click',
        pageId,
        target: query,
        post: [{ text_present: '已查询“SO-24003”' }],
      });
      assert.deepEqual(await log(pageId), [
        ...plan.map(([op, order]) => ({ op, order })),
        { op: '查询“SO-24003”', order: null },
      ]);
    }
    await run({ op: 'close_page', pageId });
  });

  test('刷新后旧编号报 stale_ref，即使新页面一模一样也不会点到新节点', async () => {
    const pageId = await env.open('/dynamic-attrs/?seed=11');
    const ob = await observe(env.session, { pageId });
    const edit = ob.elements.find(
      (e) => e.name === '编辑' && e.within === "tr[data-row-key='SO-24001']",
    );
    assert.ok(edit);
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    const r = await run({ op: 'click', pageId, target: { ref: edit.ref } });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'stale_ref', r.error?.message);
    assert.deepEqual(await log(pageId), [], '没有任何点击');

    const again = await observe(env.session, { pageId });
    const fresh = again.elements.find(
      (e) => e.name === '编辑' && e.within === "tr[data-row-key='SO-24001']",
    );
    assert.ok(fresh);
    assert.ok(fresh.ref > Math.max(...ob.elements.map((e) => e.ref)), '编号不复用');
    await ok({ op: 'click', pageId, target: { ref: fresh.ref } });
    assert.deepEqual(await log(pageId), [{ op: '编辑', order: 'SO-24001' }]);
    await run({ op: 'close_page', pageId });
  });
});
