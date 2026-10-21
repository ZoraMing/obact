// 夹具：时序（FR-13、FR-14、BW-3）。动画按钮、布局偏移、延迟渲染、骨架屏、进度条。
// 全部只靠位置稳定检查、定位轮询、wait_for 与后置检查完成，测试里没有固定延时。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type ActOptions, act, type ObscuredInfo } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
const btn = (name: string) => ({ role: 'button', name });

describe('夹具 timing（FR-13、FR-14、BW-3）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function run(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await act(env.session, a, opts);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await run(a, opts);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const log = (pageId: string) =>
    env.session.pages.get(pageId).evaluate(() => (window as unknown as { __log: string[] }).__log);
  const close = (pageId: string) => run({ op: 'close_page', pageId });

  test('动画按钮：等位置稳定后再点，点下去时已停止移动', async (t) => {
    const pageId = await env.open('/timing/');
    const page = env.session.pages.get(pageId);
    const x0 = await page.$eval('#anim-target', (e) => e.getBoundingClientRect().left);
    await ok({ op: 'click', pageId, target: btn('开始动画') });
    const r = await ok({ op: 'click', pageId, target: btn('移动目标') });
    t.diagnostic(`点击移动目标耗时 ${r.duration_ms} 毫秒`);
    assert.deepEqual(await log(pageId), ['anim-target:still']);
    const x1 = await page.$eval('#anim-target', (e) => e.getBoundingClientRect().left);
    assert.ok(Math.abs(x1 - x0 - 320) < 1, `按钮已移到终点（${x0} → ${x1}）`);
    await close(pageId);
  });

  test('一直在动的按钮：报 not_actionable（unstable），不会点下去', async () => {
    const pageId = await env.open('/timing/');
    const r = await run({ op: 'click', pageId, target: btn('摇摆按钮'), timeout_ms: 800 });
    assert.equal(r.status, 'error');
    assert.equal(r.error?.code, 'not_actionable', r.error?.message);
    assert.equal(r.error?.details?.reason, 'unstable');
    assert.deepEqual(await log(pageId), []);
    await close(pageId);
  });

  test('布局偏移（悬停触发）：派发前复核发现落点变成“取消订单”，重新取点后点中“确认订单”', async () => {
    const pageId = await env.open('/timing/');
    const infos: ObscuredInfo[] = [];
    await ok(
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
    await ok({ op: 'assert', pageId, checks: [{ text_present: '优惠券已自动使用' }] });
    await close(pageId);
  });

  test('布局偏移（延迟插入）：推荐区长高期间等位置稳定，点中“立即支付”而不是“放弃支付”', async (t) => {
    const pageId = await env.open('/timing/');
    await ok({
      op: 'click',
      pageId,
      target: btn('加载推荐'),
      post: [{ expr: "document.getElementById('reco').dataset.state === 'growing'" }],
    });
    const r = await ok({ op: 'click', pageId, target: btn('立即支付') });
    t.diagnostic(`点击立即支付耗时 ${r.duration_ms} 毫秒`);
    assert.deepEqual(await log(pageId), ['pay:done'], '推荐区长完后才点，且点中的是“立即支付”');
    await close(pageId);
  });

  test('延迟渲染：按钮 800 毫秒后出现；定位在期限内轮询，wait_for 等到出现', async () => {
    const a = await env.open('/timing/');
    const t0 = Date.now();
    await ok({ op: 'click', pageId: a, target: btn('显示延迟按钮') });
    await ok({ op: 'click', pageId: a, target: btn('延迟按钮') });
    assert.ok(Date.now() - t0 >= 750, `等到按钮出现才点（${Date.now() - t0} 毫秒）`);
    assert.deepEqual(await log(a), ['delayed']);
    await close(a);

    const b = await env.open('/timing/');
    await ok({ op: 'click', pageId: b, target: btn('显示延迟按钮') });
    const w = await ok({
      op: 'wait_for',
      pageId: b,
      until: [{ element_present: btn('延迟按钮') }],
      timeout_ms: 3000,
    });
    assert.ok(w.duration_ms >= 300, `wait_for 等了 ${w.duration_ms} 毫秒`);
    assert.equal(w.assertions?.[0]?.pass, true);
    await ok({ op: 'click', pageId: b, target: btn('延迟按钮') });
    assert.deepEqual(await log(b), ['delayed']);
    await close(b);
  });

  test('骨架屏：后置检查等到真实内容出现再继续', async (t) => {
    const pageId = await env.open('/timing/');
    const r = await ok({
      op: 'click',
      pageId,
      target: btn('加载订单'),
      post: [{ element_absent: { css: '[aria-busy="true"]' } }, { text_present: 'SO-31002' }],
    });
    t.diagnostic(`加载订单（含接口 700 毫秒）耗时 ${r.duration_ms} 毫秒`);
    assert.ok(r.duration_ms >= 600, '等到了接口返回');
    assert.ok(r.assertions?.every((x) => x.pass));
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '查看', within: "tr[data-key='SO-31002']" },
    });
    assert.deepEqual(await log(pageId), ['view:SO-31002']);
    await close(pageId);
  });

  test('骨架屏：骨架里禁用的“全部导出”不会被点，等真实按钮替换上来后点它', async (t) => {
    const pageId = await env.open('/timing/');
    await ok({ op: 'click', pageId, target: btn('加载订单') });
    await ok({
      op: 'assert',
      pageId,
      checks: [{ element_present: { css: '[aria-busy="true"]' } }],
    });
    const r = await ok({ op: 'click', pageId, target: btn('全部导出') });
    t.diagnostic(`点击全部导出耗时 ${r.duration_ms} 毫秒`);
    assert.deepEqual(await log(pageId), ['export-all'], '没有点到骨架里的按钮');
    await close(pageId);
  });

  test('进度条：后置检查等到“导出完成”；条件等待到 50% 时停止', async (t) => {
    const a = await env.open('/timing/');
    const r = await ok({
      op: 'click',
      pageId: a,
      target: btn('开始导出'),
      post: [{ text_present: '导出完成' }],
    });
    t.diagnostic(`开始导出到完成耗时 ${r.duration_ms} 毫秒`);
    assert.ok(r.duration_ms >= 1500, '进度条约 2 秒走完');
    await ok({ op: 'click', pageId: a, target: btn('下载报表') });
    assert.deepEqual(await log(a), ['download']);
    await close(a);

    const b = await env.open('/timing/');
    await ok({ op: 'click', pageId: b, target: btn('开始导出') });
    await ok({
      op: 'wait_for',
      pageId: b,
      until: [{ expr: "document.getElementById('progress').value >= 50" }],
    });
    await ok({ op: 'click', pageId: b, target: btn('停止') });
    const stopped = Number(/^stopped:(\d+)$/.exec((await log(b))[0] ?? '')?.[1]);
    t.diagnostic(`停在 ${stopped}%`);
    assert.ok(stopped >= 50 && stopped < 90, `停在 ${stopped}%`);
    await close(b);
  });

  test('进度条：停止后“开始导出”接着走，走完后再点从头再来（旧的“下载报表”被清掉）', async () => {
    const pageId = await env.open('/timing/');
    const value = "Number(document.getElementById('progress').value)";
    await ok({ op: 'click', pageId, target: btn('开始导出') });
    await ok({ op: 'wait_for', pageId, until: [{ expr: `${value} >= 15` }] });
    await ok({ op: 'click', pageId, target: btn('停止') });
    const stopped = Number(/^stopped:(\d+)$/.exec((await log(pageId))[0] ?? '')?.[1]);
    // 之前停止后 timer 没清，再点“开始导出”被静默忽略，进度停在原地
    await ok({
      op: 'click',
      pageId,
      target: btn('开始导出'),
      post: [{ text_present: '导出完成' }],
    });
    assert.ok(stopped < 100);

    // 走完之后再点：进度回到 0 重新走，“导出完成”和“下载报表”都先清掉
    await ok({ op: 'click', pageId, target: btn('开始导出') });
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ expr: `${value} < 100 && !document.getElementById('export-result').textContent` }],
    });
    await ok({ op: 'click', pageId, target: btn('停止') });
    const again = await env.session.pages
      .get(pageId)
      .evaluate(
        () =>
          [...document.querySelectorAll('button')].filter((b) => b.textContent === '下载报表')
            .length,
      );
    assert.equal(again, 0, '重新开始后不留旧的“下载报表”');
    await close(pageId);
  });
});
