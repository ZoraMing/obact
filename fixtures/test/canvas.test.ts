// 夹具：Canvas（PRD 9.3，FR-11、FR-32）。大面积 Canvas 给出告警；按 bbox 换算坐标，click_at 点中指定的柱子。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { observe } from '@obact/core';
import { type FixtureEnv, ok, SKIP, setup } from './helpers.ts';

/** 与页面相同的图表布局（CSS 像素）：四周留白，12 根柱子等分绘图区。 */
const PAD = { l: 64, r: 24, t: 40, b: 48 };
const N = 12;

describe('夹具 canvas（FR-11、FR-32）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('大面积 Canvas 告警；用 bbox 换算坐标点中指定的柱子，点在空隙上不算点中', async () => {
    const pageId = await env.open('/canvas/');
    const ob = await observe(env.session, { pageId });
    assert.equal(ob.canvas_warning, true);
    const chart = ob.elements.find((e) => e.name === '月度销售额柱状图');
    assert.ok(chart, '图表 Canvas 有点击监听，应在元素表中');
    const [x, y, w, h] = chart.bbox as unknown as [number, number, number, number];
    const slot = (w - PAD.l - PAD.r) / N;
    const log = () =>
      env.session.pages
        .get(pageId)
        .evaluate(() => (window as unknown as { chartLog: string[] }).chartLog);
    // 靠近底边的一点：任何高度的柱子都覆盖这里；第 k 根柱子的中心在 (k - 0.5) 个槽宽处，空隙在整数槽宽处
    const clickAt = (slots: number) =>
      ok(env, { op: 'click_at', pageId, x: x + PAD.l + slots * slot, y: y + h - PAD.b - 6 });

    for (const k of [7, 1, 12]) {
      const r = await clickAt(k - 0.5);
      assert.equal(r.locator_used, 'coord');
      assert.equal((await log()).at(-1), `点中柱子 ${k}`);
    }
    await clickAt(3);
    assert.equal((await log()).at(-1), '未点中柱子');
  });
});
