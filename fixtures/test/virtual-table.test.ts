// 虚拟滚动大表夹具（PRD 9.3，FR-09、FR-10）：1 万行只渲染可见行；observe 只看到已渲染的行；页面与接口数据一致。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { observe } from '@obact/core';
import {
  formatAmount,
  MAX_LIMIT,
  rowAt,
  STATUS_LABELS,
  TOTAL,
  type VtRow,
} from '../api/virtual-table.ts';
import { type FixtureEnv, ok, SKIP, setup } from './helpers.ts';

const ROW_H = 32;
const SEED = 7;
type Api = { total: number; limit: number; rows: VtRow[] };

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

  async function api(query: string): Promise<{ status: number; body: Api }> {
    const r = await fetch(`${env.server.base}/api/virtual-table/rows?${query}`);
    return { status: r.status, body: (await r.json()) as Api };
  }

  test('observe 只看到已渲染的行；滚动后看到后面的行、前面的不再出现；页面显示与接口原始数据一致', async () => {
    const pageId = await env.open(`/virtual-table/?seed=${SEED}`);
    const page = env.session.pages.get(pageId);
    await page.waitForFunction(RENDERED_EXPR, { timeout: 5000 });
    const idsIn = (text: string) => new Set(text.match(/R\d{5}/g) ?? []);
    const rendered = () => page.$$eval('#body [data-id]', (els) => els.length);

    const first = await observe(env.session, { pageId });
    const seen = idsIn(first.text_md);
    assert.ok(seen.has('R00001') && !seen.has('R00100') && !seen.has('R10000'), '只有渲染的行');
    assert.match(first.text_md, /10001/, '表格的总行数（aria-rowcount）在文本中给出');
    const rows = await rendered();
    assert.ok(rows >= 15 && rows <= 40, `只渲染可见行（含预渲染）：${rows}`);
    assert.equal(
      first.elements.filter((e) => e.name === '查看').length,
      rows,
      '每个已渲染行一个按钮',
    );

    await ok(env, {
      op: 'scroll',
      pageId,
      target: { css: '#viewport' },
      dy: 100 * ROW_H,
      post: [{ expr: RENDERED_EXPR }],
    });
    const top = await page.$eval('#viewport', (e) => e.scrollTop);
    const index = Math.floor(top / ROW_H);
    assert.ok(index >= 50, `滚动到了后面：scrollTop=${top}`);
    const later = idsIn((await observe(env.session, { pageId })).text_md);
    assert.ok(later.has(`R${String(index + 1).padStart(5, '0')}`), '滚动后首个可见行出现');
    assert.ok(!later.has('R00001'), '滚出去的行不再出现');

    // 页面上的显示值（千分位、中文状态）与接口原始数据逐行对应
    const dom = await page.$$eval('#body [data-id]', (els) =>
      els.map((e) => [...e.querySelectorAll('[role=cell]')].slice(0, 5).map((c) => c.textContent)),
    );
    const { body } = await api(`offset=${index - 5}&limit=${dom.length}&seed=${SEED}`);
    const display = (r: VtRow) => [
      r.id,
      r.customer,
      r.city,
      formatAmount(r.amount),
      STATUS_LABELS[r.status],
    ];
    assert.deepEqual(dom, body.rows.map(display));
  });

  test('接口：确定性生成、任意区间、分页边界与参数校验', async () => {
    const a = await api(`offset=0&limit=5&seed=${SEED}`);
    assert.equal(a.status, 200);
    assert.deepEqual(
      (await api(`offset=0&limit=5&seed=${SEED}`)).body,
      a.body,
      '同一 seed 结果相同',
    );
    assert.notDeepEqual((await api('offset=0&limit=5&seed=8')).body.rows, a.body.rows);
    assert.equal(a.body.total, TOTAL);
    assert.deepEqual(a.body.rows[0], rowAt(SEED, 0));
    // 原始数据：金额是数值，状态是代码
    for (const r of a.body.rows) {
      assert.equal(typeof r.amount, 'number');
      assert.ok(r.status in STATUS_LABELS);
    }
    const mid = await api(`offset=4998&limit=3&seed=${SEED}`);
    assert.deepEqual(
      mid.body.rows.map((r) => r.id),
      ['R04999', 'R05000', 'R05001'],
    );
    assert.equal((await api(`offset=0&limit=5000&seed=${SEED}`)).body.limit, MAX_LIMIT);
    const tail = await api(`offset=9990&limit=100&seed=${SEED}`);
    assert.equal(tail.body.rows.at(-1)?.id, 'R10000');
    assert.equal(tail.body.rows.length, 10);
    assert.deepEqual((await api(`offset=20000&limit=10&seed=${SEED}`)).body.rows, []);
    assert.equal((await api('offset=-1&limit=10')).status, 400);
    assert.equal((await api('offset=0&limit=abc')).status, 400);
  });
});
