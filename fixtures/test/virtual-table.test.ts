// 虚拟滚动大表夹具（PRD 9.3，FR-09、FR-10）：1 万行只渲染可见行；observe 只看到已渲染的行；接口与页面一致。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, observe } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import {
  formatAmount,
  MAX_LIMIT,
  rowAt,
  STATUS_LABELS,
  TOTAL,
  type VtRow,
} from '../api/virtual-table.ts';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
const ROW_H = 32;
const SEED = 7;

type Api = { total: number; offset: number; limit: number; seed: number; rows: VtRow[] };
type DomRow = { id: string; index: number; cells: string[]; visible: boolean };

/** 页面上一行应显示的五列文字。 */
const displayed = (r: VtRow): string[] => [
  r.id,
  r.customer,
  r.city,
  formatAmount(r.amount),
  STATUS_LABELS[r.status],
];
const idsIn = (text: string): Set<string> => new Set(text.match(/R\d{5}/g) ?? []);
/** 渲染完成：当前滚动位置的首行已有数据，且没有“加载中”的行。 */
const RENDERED_EXPR =
  "(() => { const vp = document.getElementById('viewport'); const i = Math.floor(vp.scrollTop / 32);" +
  " return !document.querySelector('#body .loading') &&" +
  ' !!document.querySelector(`#body [aria-rowindex="${i + 2}"][data-id]`); })()';

describe('虚拟滚动大表夹具（FR-09、FR-10）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function ok(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  async function api(query: string): Promise<{ status: number; body: Api }> {
    const r = await fetch(`${env.server.base}/api/virtual-table/rows?${query}`);
    return { status: r.status, body: (await r.json()) as Api };
  }
  async function openTable(seed = SEED): Promise<string> {
    const pageId = await env.open(`/virtual-table/?seed=${seed}`);
    await env.session.pages.get(pageId).waitForFunction(RENDERED_EXPR, { timeout: 5000 });
    return pageId;
  }
  /** DOM 中已渲染的数据行（含上下预渲染的行），visible 表示与滚动区可见范围相交。 */
  const domRows = (pageId: string): Promise<DomRow[]> =>
    env.session.pages.get(pageId).$$eval('#body [role=row][data-id]', (els) => {
      const vp = (document.getElementById('viewport') as HTMLElement).getBoundingClientRect();
      return els.map((e) => {
        const r = e.getBoundingClientRect();
        return {
          id: e.getAttribute('data-id') ?? '',
          index: Number(e.getAttribute('aria-rowindex')) - 2,
          cells: [...e.querySelectorAll('[role=cell]')].map((c) => (c.textContent ?? '').trim()),
          visible: r.bottom > vp.top + 1 && r.top < vp.bottom - 1,
        };
      });
    });

  /** text_md 里只出现已渲染的行，且可见行都在；每个可见行的各列显示值都在同一行 Markdown 里。 */
  function checkText(text_md: string, rows: DomRow[]): Set<string> {
    const domIds = new Set(rows.map((r) => r.id));
    const seen = idsIn(text_md);
    for (const id of seen) assert.ok(domIds.has(id), `text_md 出现了未渲染的行 ${id}`);
    const lines = text_md.split('\n');
    for (const r of rows.filter((x) => x.visible)) {
      const line = lines.find((l) => l.includes(`| ${r.id} |`));
      assert.ok(line, `可见行 ${r.id} 不在 text_md 中`);
      for (const c of r.cells.slice(0, 5))
        assert.ok(line.includes(c), `${r.id} 缺少 ${c}：${line}`);
    }
    return seen;
  }

  test('首屏：observe 只看到已渲染的行，元素与文本一致', async () => {
    const pageId = await openTable();
    const rows = await domRows(pageId);
    assert.ok(rows.length >= 15 && rows.length <= 40, `只渲染可见行（含预渲染）：${rows.length}`);
    assert.equal(rows[0]?.id, 'R00001');

    const ob = await observe(env.session, { pageId });
    contracts.assert('observe.Result', ob);
    const seen = checkText(ob.text_md, rows);
    assert.ok(seen.has('R00001'));
    assert.ok(!seen.has('R00100') && !seen.has('R10000'), '没有渲染的行不出现');
    assert.match(ob.text_md, /10001/, '表格的总行数（aria-rowcount）在文本中给出');

    // 每个已渲染行的“查看”按钮都在元素表中，within 指向所在行
    const views = ob.elements.filter((e) => e.name === '查看');
    assert.deepEqual(
      views.map((e) => e.within?.match(/R\d{5}/)?.[0]).sort(),
      rows.map((r) => r.id).sort(),
    );
    const scroller = ob.elements.find((e) => e.name === '订单滚动区');
    assert.ok(scroller?.actions.includes('scroll'), '滚动区可滚动');
  });

  test('在滚动区滚动后看到后面的行，前面的行不再出现', async () => {
    const pageId = await openTable();
    const page = env.session.pages.get(pageId);
    const r = await ok({
      op: 'scroll',
      pageId,
      target: { css: '#viewport' },
      dy: 100 * ROW_H,
      post: [{ expr: RENDERED_EXPR }],
    });
    assert.equal(r.assertions?.[0]?.pass, true);
    const top = await page.$eval('#viewport', (e) => e.scrollTop);
    const first = Math.floor(top / ROW_H);
    assert.ok(first >= 50, `滚动到了后面：scrollTop=${top}`);
    const firstId = `R${String(first + 1).padStart(5, '0')}`;

    const rows = await domRows(pageId);
    assert.ok(rows.length <= 40, `仍只渲染可见行：${rows.length}`);
    const ob = await observe(env.session, { pageId });
    const seen = checkText(ob.text_md, rows);
    assert.ok(seen.has(firstId), `滚动后首个可见行 ${firstId} 应出现`);
    assert.ok(!seen.has('R00001'), '滚出去的行不再出现');

    // 再滚回顶部
    await ok({
      op: 'scroll',
      pageId,
      target: { css: '#viewport' },
      dy: -200 * ROW_H,
      post: [{ expr: RENDERED_EXPR }],
    });
    assert.equal(await page.$eval('#viewport', (e) => e.scrollTop), 0);
    assert.ok(idsIn((await observe(env.session, { pageId })).text_md).has('R00001'));
  });

  test('跳到第 5000 行：页面显示与接口原始数据一致', async () => {
    const pageId = await openTable();
    await ok({
      op: 'fill',
      pageId,
      target: { role: 'spinbutton', name: '跳到行号' },
      value: '5000',
    });
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '跳转' },
      post: [{ expr: RENDERED_EXPR }, { element_present: { css: "[data-id='R05000']" } }],
    });
    const rows = await domRows(pageId);
    const lo = Math.min(...rows.map((r) => r.index));
    const { status, body } = await api(`offset=${lo}&limit=${rows.length}&seed=${SEED}`);
    assert.equal(status, 200);
    assert.equal(body.rows.length, rows.length);
    for (const raw of body.rows) {
      const dom = rows.find((r) => r.id === raw.id);
      assert.ok(dom, `接口行 ${raw.id} 应已渲染`);
      assert.deepEqual(dom.cells.slice(0, 5), displayed(raw), `${raw.id} 页面与接口一致`);
    }
    const ob = await observe(env.session, { pageId });
    assert.ok(checkText(ob.text_md, rows).has('R05000'));

    // 按行内“查看”按钮（within 定位）打开详情，详情与接口一致
    const r5000 = body.rows.find((x) => x.id === 'R05000') as VtRow;
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '查看', within: "div[data-id='R05000']" },
      post: [{ text_present: `当前查看：R05000 ${r5000.customer} ${r5000.city}` }],
    });
  });

  test('接口：确定性生成、分页边界与参数校验', async () => {
    const a = await api(`offset=0&limit=5&seed=${SEED}`);
    const b = await api(`offset=0&limit=5&seed=${SEED}`);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body, '同一 seed 结果相同');
    assert.equal(a.body.total, TOTAL);
    assert.deepEqual(a.body.rows[0], rowAt(SEED, 0));
    const other = await api('offset=0&limit=5&seed=8');
    assert.notDeepEqual(other.body.rows, a.body.rows, '不同 seed 数据不同');
    // 原始数据：金额是最多两位小数的数值，状态是代码
    for (const r of a.body.rows) {
      assert.equal(typeof r.amount, 'number');
      assert.equal(Math.round(r.amount * 100) / 100, r.amount);
      assert.ok(r.status in STATUS_LABELS);
    }
    // 任意区间可直接取，与从头取的结果一致
    const mid = await api(`offset=4998&limit=4&seed=${SEED}`);
    assert.deepEqual(
      mid.body.rows.map((r) => r.id),
      ['R04999', 'R05000', 'R05001', 'R05002'],
    );
    const big = await api(`offset=0&limit=5000&seed=${SEED}`);
    assert.equal(big.body.limit, MAX_LIMIT);
    assert.equal(big.body.rows.length, MAX_LIMIT);
    const tail = await api(`offset=9990&limit=100&seed=${SEED}`);
    assert.equal(tail.body.rows.length, 10);
    assert.equal(tail.body.rows.at(-1)?.id, 'R10000');
    assert.deepEqual((await api(`offset=20000&limit=10&seed=${SEED}`)).body.rows, []);
    assert.equal((await api('offset=-1&limit=10')).status, 400);
    assert.equal((await api('offset=0&limit=abc')).status, 400);

    // 页面按 URL 的 seed 取数
    const pageId = await openTable(8);
    const first = (await domRows(pageId))[0];
    assert.deepEqual(first?.cells.slice(0, 5), displayed(other.body.rows[0] as VtRow));
  });
});
