// Lab 模块：干扰层（PRD 9.3；FR-13、FR-23；BW-7 的 Entry Ad；TS-07 的随机弹窗）。
// 协议层测 popup_rate 的随机序列；浏览器层测广告层遮挡（obscured）与弹窗规则（onObscured）。
// 等待都是条件等待（act 的 wait_for），没有固定延时。
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { ActOptions } from '@obact/core';
import { createLab, type Lab } from '../src/app.ts';
import noise, { type NoiseData } from '../src/modules/noise.ts';
import { control, type LabEnv, SKIP, setup } from './helpers.ts';

describe('干扰层：popup_rate 的随机序列', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [noise] });
  });
  after(async () => {
    await lab?.close();
  });

  test('由空间的随机序列决定，同种子可复现；popup_rate 为 0 或已关闭时不消耗随机数；任意页面都带广告层', async () => {
    const c = control(lab, 'n-rng');
    const seq = async (n: number) => {
      const out: boolean[] = [];
      for (let i = 0; i < n; i++) {
        out.push((await (await fetch(`${lab.url('n-rng')}/`)).text()).includes('id="noise-ad"'));
      }
      return out;
    };
    await c.faults({ popup_rate: 0.5 });
    const a = await seq(40);
    assert.ok(a.includes(true) && a.includes(false), `一半的概率应当有弹有不弹：${a.join()}`);

    await c.reset();
    for (let i = 0; i < 5; i++) await seq(1); // popup_rate 为 0：不消耗随机数
    await c.faults({ popup_rate: 0.5 });
    assert.deepEqual(await seq(40), a, '同一个种子，序列相同');

    await c.reset();
    await c.faults({ popup_rate: 0.5 });
    await fetch(`${lab.url('n-rng')}/noise/ad-close`, { method: 'POST' });
    await seq(5); // 已关闭：同样不消耗，也不再输出广告层
    assert.equal(((await c.state()).modules.noise as NoiseData).ad_shown, 0);
  });
});

describe('干扰层：广告弹窗（浏览器 + observe/act）', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [noise] });
  });
  after(async () => {
    await env?.close();
  });
  afterEach(() => env.closePages());

  const state = async (space: string) =>
    (await control(env.lab, space).state()).modules.noise as NoiseData;
  const btn = (name: string) => ({ role: 'button', name });
  const AD = { role: 'dialog', name: '特别优惠' };
  const waitAd = (pageId: string) =>
    env.ok({ op: 'wait_for', pageId, until: [{ element_present: AD }], timeout_ms: 5000 });
  const goOn = (pageId: string, opts?: ActOptions) =>
    env.ok(
      { op: 'click', pageId, target: btn('继续阅读'), post: [{ text_present: '已继续阅读' }] },
      opts,
    );
  /** 弹窗规则（模拟 FR-23 的规则文件）：被广告层挡住就点“关闭”；calls 记录触发次数。 */
  const closeAd =
    (pageId: string, calls: string[]): NonNullable<ActOptions['onObscured']> =>
    async (info) => {
      if (!/noise-ad/.test(info.hit)) return false;
      calls.push(info.hit);
      return (await env.run({ op: 'click', pageId, target: btn('关闭') })).status === 'ok';
    };

  test('Entry Ad（BW-7）：广告没关时点页面按钮报 obscured；规则点“关闭”后重试成功；每次加载都再弹', async () => {
    const space = 'b-entry';
    const pageId = await env.open(space, '/noise/entry-ad');
    await waitAd(pageId);
    const ob = await env.look(pageId);
    const find = (name: string) => ob.elements.find((e) => e.role === 'button' && e.name === name);
    assert.equal(find('关闭')?.clickable, true, 'observe 把广告里的“关闭”识别为可点击按钮');
    assert.equal(find('继续阅读')?.clickable, false, '页面按钮被广告层盖住');

    const blocked = await env.run({
      op: 'click',
      pageId,
      target: btn('继续阅读'),
      timeout_ms: 1500,
    });
    assert.equal(blocked.error?.code, 'obscured', blocked.error?.message);
    assert.match(String(blocked.error?.details?.hit), /noise-ad/, '落点上是广告层，没有点穿');

    const calls: string[] = [];
    await goOn(pageId, { onObscured: closeAd(pageId, calls) });
    assert.equal(calls.length, 1);
    let s = await state(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.entry_ad_loads, s.ad_dismissed], [1, 1, 1, true]);

    // 第二次加载：Entry Ad 仍然弹出（不受“已关闭”影响）
    await waitAd(await env.open(space, '/noise/entry-ad'));
    s = await state(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.entry_ad_loads], [2, 1, 2]);
  });

  test('popup_rate=1：普通页面也弹广告，规则关闭后继续完成动作，关闭记入空间状态', async () => {
    const space = 'b-popup';
    await control(env.lab, space).faults({ popup_rate: 1 });
    const pageId = await env.open(space, '/noise');
    await waitAd(pageId);
    const calls: string[] = [];
    await goOn(pageId, { onObscured: closeAd(pageId, calls) });
    assert.equal(calls.length, 1);

    const s = await state(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.ad_dismissed], [1, 1, true]);
  });
});
