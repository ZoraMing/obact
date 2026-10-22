// 常驻请求夹具（PRD 9.3，FR-14）：每秒轮询 + WebSocket 定时推送下（网络永不空闲），动作不等网络空闲、很快返回。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type FixtureEnv, ok, SKIP, setup } from './helpers.ts';

type PageState = { inflight: number; pushes: number; wsOpen: boolean };

describe('常驻请求夹具（FR-14）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('请求一直挂着、WebSocket 持续推送时，带后置检查的点击仍在远小于 5 秒内返回', async () => {
    // hold=2500：每次轮询 2.5 秒才返回，每秒发一次 → 任何时刻都有请求在进行
    const pageId = await env.open('/polling/?hold=2500');
    const page = env.session.pages.get(pageId);
    const state = () =>
      page.evaluate(() => ({ ...(window as unknown as { fixtureState: PageState }).fixtureState }));
    await page.waitForFunction(
      () => {
        const st = (window as unknown as { fixtureState: PageState }).fixtureState;
        return st.wsOpen && st.pushes >= 3 && st.inflight >= 2;
      },
      { timeout: 5000 },
    );
    const before = await state();

    const r = await ok(env, {
      op: 'click',
      pageId,
      target: { role: 'button', name: '保存草稿' },
      post: [{ text_present: '已保存 1 次' }],
    });
    assert.equal(r.assertions?.[0]?.pass, true);
    assert.ok(r.duration_ms < 1500, `点击耗时 ${r.duration_ms} 毫秒，应远小于 5 秒上限`);

    const after = await state();
    assert.ok(after.inflight >= 1, '动作结束时仍有轮询请求挂着：没有等网络空闲');
    assert.ok(
      after.pushes > before.pushes,
      `动作期间推送仍在继续：${before.pushes} → ${after.pushes}`,
    );
    await page.close();
  });
});
