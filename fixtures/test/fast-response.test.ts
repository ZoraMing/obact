// 快速响应夹具（PRD 9.3，FR-10、FR-14）：接口约 20 毫秒返回；带后置检查的点击结果一出现就返回，不会错过响应。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { DEFAULT_DELAY_MS, type FastResult, resultFor } from '../api/fast-response.ts';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
const fmt = (n: number) => {
  const [int, frac] = n.toFixed(2).split('.') as [string, string];
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
};
const shown = (r: Omit<FastResult, 'delay_ms'>) =>
  `第 ${r.n} 次查询：订单 ${r.order_id}，金额 ${fmt(r.amount)} 元`;

describe('快速响应夹具（FR-10、FR-14）', { skip: SKIP }, () => {
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
  const resultText = (pageId: string) =>
    env.session.pages.get(pageId).$eval('#result', (e) => e.textContent ?? '');

  test('点击带后置检查：结果一出现就返回；页面请求的响应被完整截获', async () => {
    const pageId = await env.open('/fast-response/?seed=4');
    const page = env.session.pages.get(pageId);
    const bodies: Promise<FastResult>[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/fast-response/data')) bodies.push(r.json() as Promise<FastResult>);
    });
    const durations: number[] = [];
    for (const n of [1, 2, 3]) {
      const want = resultFor(4, n);
      const r = await ok({
        op: 'click',
        pageId,
        target: { role: 'button', name: '查询订单' },
        post: [{ text_present: shown(want) }],
      });
      assert.equal(r.assertions?.[0]?.pass, true);
      durations.push(r.duration_ms);
      assert.equal(await resultText(pageId), shown(want));
    }
    console.log(
      `快速响应（约 ${DEFAULT_DELAY_MS} 毫秒）：带后置检查的点击耗时 ${durations.join('、')} 毫秒`,
    );
    for (const ms of durations) assert.ok(ms < 1000, `结果出现即返回，实际 ${ms} 毫秒`);

    const captured = await Promise.all(bodies);
    assert.deepEqual(
      captured,
      [1, 2, 3].map((n) => ({ ...resultFor(4, n), delay_ms: DEFAULT_DELAY_MS })),
      '每次点击的接口响应都在，且与页面显示一致',
    );
  });

  test('没有后置检查：短时稳定等待结束时约 20 毫秒的结果已经渲染', async () => {
    const pageId = await env.open('/fast-response/?seed=9');
    const durations: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await ok({ op: 'click', pageId, target: { css: '#query' } });
      durations.push(r.duration_ms);
      assert.equal(r.effects.changed, true);
      assert.equal(await resultText(pageId), shown(resultFor(9, n)), `第 ${n} 次`);
    }
    console.log(`快速响应：无后置检查的点击耗时 ${durations.join('、')} 毫秒`);
    for (const ms of durations) assert.ok(ms < 1500, `耗时 ${ms}`);
  });

  test('后置检查一通过就继续：接口 300 毫秒时耗时跟随接口', async () => {
    const pageId = await env.open('/fast-response/?seed=4&delay=300');
    const r = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '查询订单' },
      post: [{ text_present: shown(resultFor(4, 1)) }],
    });
    console.log(`接口 300 毫秒：带后置检查的点击耗时 ${r.duration_ms} 毫秒`);
    assert.ok(r.duration_ms >= 300, `结果出现前不应返回：${r.duration_ms}`);
    assert.ok(r.duration_ms < 1300, `结果出现后应很快返回：${r.duration_ms}`);
  });

  test('接口：约 20 毫秒返回，内容由 seed 与 n 决定', async () => {
    const get = async (q: string) => {
      const t = performance.now();
      const r = await fetch(`${env.server.base}/api/fast-response/data?${q}`);
      const body = (await r.json()) as FastResult;
      return { status: r.status, body, ms: performance.now() - t };
    };
    const a = await get('n=1&seed=4');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, { ...resultFor(4, 1), delay_ms: DEFAULT_DELAY_MS });
    assert.ok(a.ms >= 15 && a.ms < 1000, `接口耗时 ${a.ms.toFixed(1)} 毫秒`);
    assert.deepEqual((await get('n=1&seed=4')).body, a.body);
    assert.notEqual((await get('n=2&seed=4')).body.order_id, a.body.order_id);
    const instant = await get('n=1&seed=4&delay=0');
    assert.equal(instant.body.delay_ms, 0);
    assert.equal((await get('n=x')).status, 400);
  });
});
