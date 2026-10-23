// 快速响应夹具（PRD 9.3，FR-10、FR-14）：接口约 20 毫秒返回；带后置检查的点击结果一出现就返回，
// 没有后置检查时短时稳定等待结束时结果已经渲染。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resultFor } from '../api/fast-response.ts';
import { type FixtureEnv, ok, SKIP, setup } from './helpers.ts';

const fmt = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const shown = (seed: number, n: number) => {
  const r = resultFor(seed, n);
  return `第 ${r.n} 次查询：订单 ${r.order_id}，金额 ${fmt(r.amount)} 元`;
};

describe('快速响应夹具（FR-10、FR-14）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  const query = { role: 'button', name: '查询订单' };

  test('后置检查一通过就继续：接口 20 毫秒时很快返回，300 毫秒时耗时跟随接口', async () => {
    const fast = await env.open('/fast-response/?seed=4');
    for (const n of [1, 2, 3]) {
      const r = await ok(env, {
        op: 'click',
        pageId: fast,
        target: query,
        post: [{ text_present: shown(4, n) }],
      });
      assert.ok(r.duration_ms < 1000, `结果出现即返回，实际 ${r.duration_ms} 毫秒`);
    }
    const slow = await env.open('/fast-response/?seed=4&delay=300');
    const r = await ok(env, {
      op: 'click',
      pageId: slow,
      target: query,
      post: [{ text_present: shown(4, 1) }],
    });
    assert.ok(r.duration_ms >= 300, `结果出现前不应返回：${r.duration_ms}`);
    assert.ok(r.duration_ms < 1300, `结果出现后应很快返回：${r.duration_ms}`);
  });

  test('没有后置检查：短时稳定等待结束时约 20 毫秒的结果已经渲染', async () => {
    const pageId = await env.open('/fast-response/?seed=9');
    for (const n of [1, 2, 3]) {
      const r = await ok(env, { op: 'click', pageId, target: { css: '#query' } });
      assert.equal(r.effects.changed, true);
      const text = await env.session.pages.get(pageId).$eval('#result', (e) => e.textContent);
      assert.equal(text, shown(9, n), `第 ${n} 次`);
    }
  });
});
