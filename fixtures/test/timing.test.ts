// 夹具：时序（PRD 9.3，FR-13、FR-14、BW-3）。动画按钮、布局偏移、延迟渲染、骨架屏、进度条。
// 全部只靠位置稳定检查、定位轮询、wait_for 与后置检查完成，测试里没有固定延时。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ObscuredInfo } from '@obact/core';
import { type FixtureEnv, ok, run, SKIP, setup } from './helpers.ts';

const btn = (name: string) => ({ role: 'button', name });

describe('夹具 timing（FR-13、FR-14、BW-3）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  const log = (pageId: string) =>
    env.session.pages.get(pageId).evaluate(() => (window as unknown as { __log: string[] }).__log);

  test('动画按钮：等位置稳定后再点；一直在动的按钮报 not_actionable（unstable），不会点下去', async () => {
    const pageId = await env.open('/timing/');
    await ok(env, { op: 'click', pageId, target: btn('开始动画') });
    await ok(env, { op: 'click', pageId, target: btn('移动目标') });
    assert.deepEqual(await log(pageId), ['anim-target:still'], '点下去时已停止移动');

    const r = await run(env, { op: 'click', pageId, target: btn('摇摆按钮'), timeout_ms: 800 });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'not_actionable', r.error?.message);
    assert.equal(r.error?.details?.reason, 'unstable');
    assert.deepEqual(await log(pageId), ['anim-target:still']);
  });

  test('布局偏移（悬停触发）：派发前复核发现落点变成“取消订单”，重新取点后点中“确认订单”', async () => {
    const pageId = await env.open('/timing/');
    const infos: ObscuredInfo[] = [];
    await ok(
      env,
      { op: 'click', pageId, target: btn('确认订单') },
      {
        onObscured: (info) => {
          infos.push(info);
          return false;
        },
      },
    );
    assert.deepEqual(await log(pageId), ['confirm-order'], '没有点到“取消订单”');
    assert.equal(infos.length, 1, '复核发现了一次落点不符');
    assert.match(infos[0]?.hit ?? '', /取消订单/);
  });

  test('布局偏移（延迟插入）：推荐区长高期间等位置稳定，点中“立即支付”而不是“放弃支付”', async () => {
    const pageId = await env.open('/timing/');
    await ok(env, {
      op: 'click',
      pageId,
      target: btn('加载推荐'),
      post: [{ expr: "document.getElementById('reco').dataset.state === 'growing'" }],
    });
    await ok(env, { op: 'click', pageId, target: btn('立即支付') });
    assert.deepEqual(await log(pageId), ['pay:done'], '推荐区长完后才点');
  });

  test('延迟渲染：按钮 800 毫秒后出现；定位在期限内轮询，wait_for 等到出现', async () => {
    const a = await env.open('/timing/');
    const t0 = Date.now();
    await ok(env, { op: 'click', pageId: a, target: btn('显示延迟按钮') });
    await ok(env, { op: 'click', pageId: a, target: btn('延迟按钮') });
    assert.ok(Date.now() - t0 >= 750, `等到按钮出现才点（${Date.now() - t0} 毫秒）`);
    assert.deepEqual(await log(a), ['delayed']);

    const b = await env.open('/timing/');
    await ok(env, { op: 'click', pageId: b, target: btn('显示延迟按钮') });
    const w = await ok(env, {
      op: 'wait_for',
      pageId: b,
      until: [{ element_present: btn('延迟按钮') }],
      timeout_ms: 3000,
    });
    assert.ok(w.duration_ms >= 300, `wait_for 等了 ${w.duration_ms} 毫秒`);
  });

  test('骨架屏：后置检查等到真实内容出现再继续；骨架里禁用的“全部导出”不会被点', async () => {
    const a = await env.open('/timing/');
    const r = await ok(env, {
      op: 'click',
      pageId: a,
      target: btn('加载订单'),
      post: [{ element_absent: { css: '[aria-busy="true"]' } }, { text_present: 'SO-31002' }],
    });
    assert.ok(r.duration_ms >= 600, '等到了接口返回');
    await ok(env, {
      op: 'click',
      pageId: a,
      target: { role: 'button', name: '查看', within: "tr[data-key='SO-31002']" },
    });
    assert.deepEqual(await log(a), ['view:SO-31002']);

    const b = await env.open('/timing/');
    await ok(env, { op: 'click', pageId: b, target: btn('加载订单') });
    await ok(env, {
      op: 'assert',
      pageId: b,
      checks: [{ element_present: { css: '[aria-busy="true"]' } }],
    });
    await ok(env, { op: 'click', pageId: b, target: btn('全部导出') });
    assert.deepEqual(await log(b), ['export-all'], '没有点到骨架里的按钮');
  });

  test('进度条：后置检查等到“导出完成”；停止后“开始导出”接着走，走完再点从头再来（fx-4）', async () => {
    const a = await env.open('/timing/');
    const r = await ok(env, {
      op: 'click',
      pageId: a,
      target: btn('开始导出'),
      post: [{ text_present: '导出完成' }],
    });
    assert.ok(r.duration_ms >= 1500, '进度条约 2 秒走完');
    await ok(env, { op: 'click', pageId: a, target: btn('下载报表') });
    assert.deepEqual(await log(a), ['download']);

    // 之前停止后 timer 没清，再点“开始导出”被静默忽略，进度停在原地
    const b = await env.open('/timing/');
    await ok(env, { op: 'click', pageId: b, target: btn('开始导出') });
    await ok(env, {
      op: 'wait_for',
      pageId: b,
      until: [{ expr: "document.getElementById('progress').value >= 15" }],
    });
    await ok(env, { op: 'click', pageId: b, target: btn('停止') });
    await ok(env, {
      op: 'click',
      pageId: b,
      target: btn('开始导出'),
      post: [{ text_present: '导出完成' }],
    });
    // 走完之后再点：进度回到 0 重新走，“导出完成”和旧的“下载报表”都先清掉
    await ok(env, { op: 'click', pageId: b, target: btn('开始导出') });
    await ok(env, {
      op: 'wait_for',
      pageId: b,
      until: [
        {
          expr: "document.getElementById('progress').value < 100 && !document.getElementById('export-result').textContent",
        },
        { element_absent: { css: '#download-report' } },
      ],
    });
  });
});
