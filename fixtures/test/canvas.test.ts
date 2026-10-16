// Canvas 夹具（PRD 9.3，FR-11、FR-31、FR-32、BW-12）：大面积 Canvas 告警；按 bbox 换算坐标点中指定柱子；
// 坐标换算定位器：Canvas 上的点保留为坐标步骤，普通按钮换算成定位器。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { act, locatorAtPoint, observe, resolveLocator } from '@obact/core';
import type { Action, ActResult, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
/** 与页面相同的图表布局（CSS 像素）：四周留白，12 根柱子等分绘图区，柱宽占槽宽的 60%。 */
const PAD = { l: 64, r: 24, t: 40, b: 48 };
const N = 12;

type Box = [number, number, number, number];
/** 元素的 bbox（视口像素 [x, y, 宽, 高]）。 */
const boxOf = (e: ObservedElement): Box => e.bbox as unknown as Box;

/** 第 k 根柱子（1 起）上靠近底边的一点：任何高度的柱子都覆盖这里。 */
function barPoint(bbox: Box, k: number): [number, number] {
  const [x, y, w, h] = bbox;
  const slot = (w - PAD.l - PAD.r) / N;
  return [x + PAD.l + (k - 0.5) * slot, y + h - PAD.b - 6];
}
/** 第 k 根与第 k+1 根柱子之间的空隙。 */
function gapPoint(bbox: Box, k: number): [number, number] {
  const [x, y, w, h] = bbox;
  const slot = (w - PAD.l - PAD.r) / N;
  return [x + PAD.l + k * slot, y + h - PAD.b - 6];
}

/**
 * 录制固化时一个坐标点击该写成什么步骤（FR-32）：能换算成指向具体 DOM 元素的唯一定位器就写定位器；
 * 换算不了，或换算出来的是 Canvas 本身（点 Canvas 中心不等于点中原来的位置），就保留坐标并标记易失效。
 */
async function stepFor(
  env: FixtureEnv,
  pageId: string,
  x: number,
  y: number,
): Promise<Action & { volatile?: boolean }> {
  const at = await locatorAtPoint(env.session, pageId, x, y);
  if (at?.unique) {
    const r = await resolveLocator(env.session, pageId, at.locator);
    const tag = await r.handle.evaluate((e) => e.tagName);
    await r.handle.dispose();
    if (tag !== 'CANVAS') return { op: 'click', pageId, target: at.locator };
  }
  return { op: 'click_at', pageId, x, y, volatile: true };
}

describe('Canvas 夹具（FR-11、FR-31、FR-32、BW-12）', { skip: SKIP }, () => {
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
  const chartLog = (pageId: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(() => [...(window as unknown as { chartLog: string[] }).chartLog]);
  const chartOf = (ob: ObserveResult): ObservedElement => {
    const c = ob.elements.find((e) => e.name === '月度销售额柱状图');
    assert.ok(c, '图表 Canvas 应在元素表中（有点击监听）');
    return c;
  };

  test('大面积 Canvas 告警，小 Canvas 不告警；编号框截图照常生成', async () => {
    const pageId = await env.open('/canvas/?seed=3');
    const ob = await observe(env.session, { pageId, views: ['text', 'som'] });
    contracts.assert('observe.Result', ob);
    assert.equal(ob.canvas_warning, true);
    assert.ok(ob.som_path && existsSync(ob.som_path), '编号框截图已生成');
    const [, , w, h] = boxOf(chartOf(ob));
    assert.ok((w * h) / (ob.viewport.width * ob.viewport.height) > 0.4, '图表占视口四成以上');
    for (const name of ['刷新', '导出图片', '清空日志']) {
      assert.ok(
        ob.elements.some((e) => e.role === 'button' && e.name === name),
        `Canvas 外的按钮 ${name}`,
      );
    }

    const small = await env.open('/canvas/?seed=3&size=small');
    assert.equal((await observe(env.session, { pageId: small })).canvas_warning, false);
  });

  test('用 bbox 换算坐标，click_at 点中指定的柱子；点在空隙上不算点中', async () => {
    const pageId = await env.open('/canvas/?seed=3');
    const ob = await observe(env.session, { pageId });
    const bbox = boxOf(chartOf(ob));
    const values = await env.session.pages
      .get(pageId)
      .evaluate(() => [...(window as unknown as { chartValues: number[] }).chartValues]);

    for (const k of [7, 1, 12]) {
      const [x, y] = barPoint(bbox, k);
      const r = await ok({ op: 'click_at', pageId, x, y });
      assert.equal(r.locator_used, 'coord');
      assert.equal(r.effects.changed, true);
      assert.equal(
        (await chartLog(pageId)).at(-1),
        `点中柱子 ${k}（${k}月，${values[k - 1]} 万元）`,
      );
    }
    const [gx, gy] = gapPoint(bbox, 3);
    await ok({ op: 'click_at', pageId, x: gx, y: gy });
    assert.match((await chartLog(pageId)).at(-1) ?? '', /^未点中柱子/);

    // 日志是普通 DOM 文本，observe 看得到
    const after = await observe(env.session, { pageId });
    assert.ok(after.text_md.includes('点中柱子 7（7月'), after.text_md);
  });

  test('坐标换算定位器：Canvas 上的点保留坐标并标记易失效，普通按钮换算成定位器', async () => {
    const pageId = await env.open('/canvas/?seed=3');
    const ob = await observe(env.session, { pageId });
    const bbox = boxOf(chartOf(ob));

    // Canvas 上的点：不能给出指向柱子的 DOM 定位器
    const [x, y] = barPoint(bbox, 5);
    const at = await locatorAtPoint(env.session, pageId, x, y);
    if (at) {
      const r = await resolveLocator(env.session, pageId, at.locator);
      const tag = await r.handle.evaluate((e) => e.tagName);
      await r.handle.dispose();
      assert.equal(tag, 'CANVAS', `Canvas 上的点只能换算到 Canvas 本身：${JSON.stringify(at)}`);
    }
    const canvasStep = await stepFor(env, pageId, x, y);
    assert.equal(canvasStep.op, 'click_at');
    assert.equal(canvasStep.volatile, true, 'Canvas 上的点击保留坐标并标记为易失效');
    // 固化后的坐标步骤回放：仍点中同一根柱子
    const { volatile: _v, ...replay } = canvasStep;
    await ok(replay as Action);
    assert.match((await chartLog(pageId)).at(-1) ?? '', /^点中柱子 5（5月/);

    // 普通按钮：坐标换算成唯一定位器，回放命中同一个按钮
    const btn = ob.elements.find((e) => e.name === '导出图片') as ObservedElement;
    const [bx, by, bw, bh] = boxOf(btn);
    const btnAt = await locatorAtPoint(env.session, pageId, bx + bw / 2, by + bh / 2);
    assert.ok(btnAt?.unique, '按钮坐标能换算成唯一定位器');
    assert.equal(btnAt.role, 'button');
    assert.equal(btnAt.name, '导出图片');
    const btnStep = await stepFor(env, pageId, bx + bw / 2, by + bh / 2);
    assert.equal(btnStep.op, 'click');
    assert.equal(btnStep.volatile, undefined);
    await ok(btnStep);
    assert.equal((await chartLog(pageId)).at(-1), '按钮：导出图片');
  });
});
