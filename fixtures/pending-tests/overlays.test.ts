// 夹具：遮挡与弹窗（FR-13、FR-23）。透明层、透明引导层、底部 Cookie 提示条、按 seed 弹出的广告层。
// 被挡时报 obscured 且不点到遮挡物；onObscured（模拟 FR-23 的弹窗规则）处理后重试成功。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type ActOptions, act, observe } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from '../test/helpers.ts';

const contracts = new Contracts();
/** 遮挡物的 data-log：点击记录里出现它们就是点到了遮挡物。 */
const OVERLAYS = ['layer', 'tour-mask', 'cookie-banner', 'ad-backdrop', 'ad-dialog', 'ad-cta'];
type PageState = {
  log: string[];
  adShown: number;
  adPlan: { mode: string; delay: number; after: number };
};

describe('夹具 overlays（FR-13、FR-23）', { skip: SKIP }, () => {
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
  async function obscured(a: Action, hit: RegExp): Promise<ActResult> {
    const r = await run({ ...a, timeout_ms: 1500 } as Action);
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
        __adPlan: PageState['adPlan'];
      };
      return { log: [...w.__log], adShown: w.__adShown, adPlan: w.__adPlan } as PageState;
    });
  /** 点击记录里不能出现任何遮挡物。 */
  const noOverlayHits = (log: string[]) =>
    assert.deepEqual(
      log.filter((x) => OVERLAYS.includes(x)),
      [],
      `点到了遮挡物：${log.join(', ')}`,
    );
  const btn = (name: string) => ({ role: 'button', name });

  /**
   * 弹窗规则（模拟 FR-23 的规则文件）：按命中元素决定处理动作，用 act 执行；没有命中返回 false。
   * calls 记录每次触发的规则名。
   */
  function rules(pageId: string, calls: string[]): ActOptions['onObscured'] {
    return async (info) => {
      assert.equal(info.pageId, pageId);
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
      return (await run(action)).status === 'ok';
    };
  }

  test('透明层（Hidden Layers）：被盖住后报 obscured，不点到透明层，也不点穿到下面的按钮', async () => {
    const pageId = await env.open('/overlays/');
    await ok({
      op: 'click',
      pageId,
      target: btn('绿色按钮'),
      post: [{ text_present: '绿色按钮已点击' }],
    });
    assert.deepEqual((await state(pageId)).log, ['green']);
    await obscured({ op: 'click', pageId, target: btn('绿色按钮') }, /layer/);
    assert.deepEqual((await state(pageId)).log, ['green'], '第二次点击没有派发');
    const ob = await observe(env.session, { pageId });
    assert.equal(ob.elements.find((e) => e.name === '绿色按钮')?.clickable, false);
    await run({ op: 'close_page', pageId });
  });

  test('透明引导层：报 obscured；规则按 Esc 关闭后重试成功', async () => {
    const pageId = await env.open('/overlays/');
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '张三' });
    await ok({
      op: 'fill',
      pageId,
      target: { role: 'textbox', name: '电话' },
      value: '13800000000',
    });
    await obscured({ op: 'click', pageId, target: btn('提交申请') }, /tour-mask/);
    assert.deepEqual((await state(pageId)).log, [], '没有点到遮罩，也没有点到按钮');

    const calls: string[] = [];
    await ok(
      {
        op: 'click',
        pageId,
        target: btn('提交申请'),
        post: [{ text_present: '申请已提交：张三 13800000000' }],
      },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['tour']);
    const s = await state(pageId);
    assert.deepEqual(s.log, ['tour-closed', 'submit']);
    await run({ op: 'close_page', pageId });
  });

  test('Cookie 提示条：完全盖住的按钮报 obscured，部分盖住的点可见部分；规则接受后重试成功', async () => {
    const pageId = await env.open('/overlays/');
    const ob = await observe(env.session, { pageId });
    assert.equal(ob.elements.find((e) => e.name === '下一步')?.clickable, false, '下一步被挡住');
    const blocked = await obscured({ op: 'click', pageId, target: btn('下一步') }, /cookie-banner/);
    const [x, y] = blocked.error?.details?.point as [number, number];
    assert.ok(x > 0 && y > 0 && y < ob.viewport.height, '报出被挡的点');
    assert.deepEqual((await state(pageId)).log, []);

    await ok({
      op: 'click',
      pageId,
      target: btn('保存草稿'),
      post: [{ text_present: '草稿已保存' }],
    });
    assert.deepEqual((await state(pageId)).log, ['draft'], '点在“保存草稿”露出来的上半部分');

    const calls: string[] = [];
    const infos: unknown[] = [];
    const handler = rules(pageId, calls);
    await ok(
      { op: 'click', pageId, target: btn('下一步'), post: [{ text_present: '已进入第 2 步' }] },
      {
        onObscured: async (info) => {
          infos.push(info);
          return (await handler?.(info)) ?? false;
        },
      },
    );
    assert.deepEqual(calls, ['cookie']);
    assert.equal(infos.length, 1);
    assert.deepEqual(
      { op: (infos[0] as { op: string }).op, attempt: (infos[0] as { attempt: number }).attempt },
      { op: 'click', attempt: 1 },
    );
    await ok({
      op: 'assert',
      pageId,
      checks: [{ element_absent: { role: 'region', name: 'Cookie 提示' } }],
    });
    assert.deepEqual((await state(pageId)).log, ['draft', 'cookie-accept', 'next']);
    await run({ op: 'close_page', pageId });
  });

  test('定时广告：延时由 seed 决定；弹出后挡住操作，规则关闭后重试成功', async () => {
    const a = await env.open('/overlays/?ad=timer&seed=4');
    const b = await env.open('/overlays/?ad=timer&seed=4');
    const c = await env.open('/overlays/?ad=timer&seed=1');
    const pa = (await state(a)).adPlan;
    assert.deepEqual((await state(b)).adPlan, pa, '同一 seed 延时相同');
    assert.notEqual((await state(c)).adPlan.delay, pa.delay, '换 seed 延时不同');
    assert.ok(pa.delay >= 300 && pa.delay < 1200);
    for (const id of [b, c]) await run({ op: 'close_page', pageId: id });

    await ok({
      op: 'wait_for',
      pageId: a,
      until: [{ element_present: { role: 'dialog', name: '限时优惠' } }],
      timeout_ms: 3000,
    });
    await obscured({ op: 'click', pageId: a, target: btn('绿色按钮') }, /ad-backdrop/);
    assert.deepEqual((await state(a)).log, [], '没有点到广告背景或广告链接');

    const calls: string[] = [];
    await ok(
      {
        op: 'click',
        pageId: a,
        target: btn('绿色按钮'),
        post: [{ text_present: '绿色按钮已点击' }],
      },
      { onObscured: rules(a, calls) },
    );
    assert.deepEqual(calls, ['ad']);
    const s = await state(a);
    assert.deepEqual(s.log, ['ad-close', 'green']);
    assert.equal(s.adShown, 1);
    await run({ op: 'close_page', pageId: a });
  });

  // 规则触发顺序说明广告在哪一步弹出：k=2 时在“接受全部”之后、外层“下一步”重试前；
  // k=3 时在“下一步”之后、填写电话时；k=4 时在“提交申请”之后、点绿色按钮时。
  for (const [seed, k, order] of [
    ['1', 2, ['cookie', 'ad', 'tour']],
    ['2', 3, ['cookie', 'ad', 'tour']],
    ['5', 4, ['cookie', 'tour', 'ad']],
  ] as const) {
    test(`广告在流程中途弹出（seed=${seed}：第 ${k} 次点击后）：规则逐个处理，流程完成且没点到遮挡物`, async () => {
      const pageId = await env.open(`/overlays/?ad=click&seed=${seed}`);
      assert.equal((await state(pageId)).adPlan.after, k);
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
        {
          op: 'click',
          pageId,
          target: btn('绿色按钮'),
          post: [{ text_present: '绿色按钮已点击' }],
        },
      ];
      for (const step of steps) await ok(step, opts);
      const s = await state(pageId);
      assert.equal(s.adShown, 1, '广告弹出过一次');
      assert.deepEqual(calls, order, '每个遮挡物的规则各触发一次，顺序符合弹出时机');
      noOverlayHits(s.log);
      assert.deepEqual(
        s.log.filter((x) => ['draft', 'next', 'submit', 'green'].includes(x)),
        ['draft', 'next', 'submit', 'green'],
        '每个业务按钮各点一次',
      );
      await ok({
        op: 'assert',
        pageId,
        checks: [{ element_absent: { role: 'dialog', name: '限时优惠' } }],
      });
      await run({ op: 'close_page', pageId });
    });
  }

  test('规则里用 act 处理弹窗后，外层动作的效果不误报导航', async () => {
    const pageId = await env.open('/overlays/');
    const calls: string[] = [];
    const r = await ok(
      { op: 'click', pageId, target: btn('下一步'), post: [{ text_present: '已进入第 2 步' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['cookie']);
    assert.equal(env.session.pages.get(pageId).url(), `${env.server.base}/overlays/`);
    assert.equal(r.effects.changed, true);
    assert.equal(r.effects.navigated, false, '页面没有导航，effects.navigated 应为 false');
    await run({ op: 'close_page', pageId });
  });
});
