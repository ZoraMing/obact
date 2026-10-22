// 夹具：遮挡与弹窗（PRD 9.3，FR-13、FR-23）。透明层、透明引导层、底部 Cookie 提示条、按 seed 弹出的广告层。
// 被挡时报 obscured 且不点到遮挡物；onObscured（模拟 FR-23 的弹窗规则）处理后重试成功。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type ActOptions, observe } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { type FixtureEnv, ok, run, SKIP, setup } from './helpers.ts';

/** 遮挡物的 data-log：点击记录里出现它们就是点到了遮挡物。 */
const OVERLAYS = ['layer', 'tour-mask', 'cookie-banner', 'ad-backdrop', 'ad-dialog', 'ad-cta'];
const btn = (name: string) => ({ role: 'button', name });

describe('夹具 overlays（FR-13、FR-23）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function obscured(a: Action, hit: RegExp): Promise<ActResult> {
    const r = await run(env, { ...a, timeout_ms: 1500 } as Action);
    assert.equal(r.status, 'error', `${a.op} 应被遮挡`);
    assert.equal(r.error?.code, 'obscured', r.error?.message);
    assert.match(String(r.error?.details?.hit), hit);
    return r;
  }
  const state = (pageId: string) =>
    env.session.pages.get(pageId).evaluate(() => {
      const w = window as unknown as {
        __log: string[];
        __adShown: number;
        __adPlan: { after: number };
      };
      return { log: [...w.__log], adShown: w.__adShown, adPlan: w.__adPlan };
    });

  /**
   * 弹窗规则（模拟 FR-23 的规则文件）：按命中元素决定处理动作，用 act 执行；没有命中返回 false。
   * calls 记录每次触发的规则名。
   */
  function rules(pageId: string, calls: string[]): ActOptions['onObscured'] {
    return async (info) => {
      let name: string;
      let action: Action;
      if (/cookie-banner/.test(info.hit)) {
        name = 'cookie';
        action = { op: 'click', pageId, target: btn('接受全部') };
      } else if (/ad-backdrop|ad-dialog/.test(info.hit)) {
        name = 'ad';
        action = { op: 'click', pageId, target: btn('关闭广告') };
      } else if (/tour-mask/.test(info.hit)) {
        name = 'tour';
        action = { op: 'press_key', pageId, key: 'Escape' };
      } else return false;
      calls.push(name);
      return (await run(env, action)).status === 'ok';
    };
  }

  test('透明层（Hidden Layers）：被盖住后报 obscured，不点到透明层，也不点穿到下面的按钮', async () => {
    const pageId = await env.open('/overlays/');
    await ok(env, {
      op: 'click',
      pageId,
      target: btn('绿色按钮'),
      post: [{ text_present: '绿色按钮已点击' }],
    });
    await obscured({ op: 'click', pageId, target: btn('绿色按钮') }, /layer/);
    assert.deepEqual((await state(pageId)).log, ['green'], '第二次点击没有派发');
    const ob = await observe(env.session, { pageId });
    assert.equal(ob.elements.find((e) => e.name === '绿色按钮')?.clickable, false);
  });

  test('透明引导层：报 obscured；规则按 Esc 关闭后重试成功', async () => {
    const pageId = await env.open('/overlays/');
    await ok(env, { op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '张三' });
    await obscured({ op: 'click', pageId, target: btn('提交申请') }, /tour-mask/);
    assert.deepEqual((await state(pageId)).log, [], '没有点到遮罩，也没有点到按钮');

    const calls: string[] = [];
    await ok(
      env,
      {
        op: 'click',
        pageId,
        target: btn('提交申请'),
        post: [{ text_present: '申请已提交：张三' }],
      },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['tour']);
    assert.deepEqual((await state(pageId)).log, ['tour-closed', 'submit']);
  });

  test('Cookie 提示条：完全盖住的按钮报 obscured，部分盖住的点可见部分；规则接受后重试成功', async () => {
    const pageId = await env.open('/overlays/');
    const ob = await observe(env.session, { pageId });
    assert.equal(ob.elements.find((e) => e.name === '下一步')?.clickable, false, '下一步被挡住');
    const blocked = await obscured({ op: 'click', pageId, target: btn('下一步') }, /cookie-banner/);
    assert.ok(blocked.error?.details?.point, '报出被挡的点');
    await ok(env, {
      op: 'click',
      pageId,
      target: btn('保存草稿'),
      post: [{ text_present: '草稿已保存' }],
    });
    assert.deepEqual((await state(pageId)).log, ['draft'], '点在“保存草稿”露出来的上半部分');

    const calls: string[] = [];
    const r = await ok(
      env,
      { op: 'click', pageId, target: btn('下一步'), post: [{ text_present: '已进入第 2 步' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['cookie']);
    assert.deepEqual((await state(pageId)).log, ['draft', 'cookie-accept', 'next']);
    // 规则里用 act 处理弹窗后，外层动作的效果不误报导航
    assert.equal(r.effects.changed, true);
    assert.equal(r.effects.navigated, false);
  });

  test('定时广告：弹出后挡住操作，规则关闭后重试成功', async () => {
    const pageId = await env.open('/overlays/?ad=timer&seed=4');
    await ok(env, {
      op: 'wait_for',
      pageId,
      until: [{ element_present: { role: 'dialog', name: '限时优惠' } }],
      timeout_ms: 3000,
    });
    await obscured({ op: 'click', pageId, target: btn('绿色按钮') }, /ad-backdrop/);
    assert.deepEqual((await state(pageId)).log, [], '没有点到广告背景或广告链接');

    const calls: string[] = [];
    await ok(
      env,
      { op: 'click', pageId, target: btn('绿色按钮'), post: [{ text_present: '绿色按钮已点击' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['ad']);
    const s = await state(pageId);
    assert.deepEqual(s.log, ['ad-close', 'green']);
    assert.equal(s.adShown, 1);
  });

  test('广告在流程中途弹出（seed=2：第 3 次点击后）：规则逐个处理，流程完成且没点到遮挡物', async () => {
    const pageId = await env.open('/overlays/?ad=click&seed=2');
    assert.equal((await state(pageId)).adPlan.after, 3);
    const calls: string[] = [];
    const opts = { onObscured: rules(pageId, calls) };
    const steps: Action[] = [
      { op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '李四' },
      { op: 'click', pageId, target: btn('保存草稿'), post: [{ text_present: '草稿已保存' }] },
      { op: 'click', pageId, target: btn('下一步'), post: [{ text_present: '已进入第 2 步' }] },
      { op: 'fill', pageId, target: { role: 'textbox', name: '电话' }, value: '13900000000' },
      {
        op: 'click',
        pageId,
        target: btn('提交申请'),
        post: [{ text_present: '申请已提交：李四 13900000000' }],
      },
      { op: 'click', pageId, target: btn('绿色按钮'), post: [{ text_present: '绿色按钮已点击' }] },
    ];
    for (const step of steps) await ok(env, step, opts);
    const s = await state(pageId);
    assert.equal(s.adShown, 1, '广告弹出过一次');
    assert.deepEqual(calls, ['cookie', 'ad', 'tour'], '每个遮挡物的规则各触发一次');
    assert.deepEqual(
      s.log.filter((x) => OVERLAYS.includes(x)),
      [],
      `点到了遮挡物：${s.log.join(', ')}`,
    );
    assert.deepEqual(
      s.log.filter((x) => ['draft', 'next', 'submit', 'green'].includes(x)),
      ['draft', 'next', 'submit', 'green'],
      '每个业务按钮各点一次',
    );
  });
});
