// 夹具：页面结构（FR-04、FR-05）。Shadow DOM（开放、嵌套、封闭）、同源 / 跨域 / 嵌套 iframe、
// Shadow Root 里的 iframe、target=_blank 与 window.open 新标签页。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, observe } from '@obact/core';
import type { Action, ActResult, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
/** 各 iframe 的 who 参数与 observe 给出的 frame 链特征。 */
const FRAMES = {
  same: /^iframe(#same-frame|\[id="same-frame"\])$/,
  cross: /^iframe(#cross-frame|\[id="cross-frame"\])$/,
  shadow: /^iframe\[title="组件内框架"\]$/,
} as const;

describe('夹具 structure（FR-04、FR-05）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function run(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }

  /** 打开主页面并等到四个 iframe 都加载出“提交”按钮（条件等待）。 */
  async function openMain(): Promise<string> {
    const pageId = await env.open('/structure/');
    const page = env.session.pages.get(pageId);
    for (const who of ['same', 'cross', 'nested', 'shadow']) {
      const f = await page.waitForFrame((fr) => fr.url().includes(`who=${who}`));
      await f.waitForSelector('#submit');
    }
    return pageId;
  }
  /** 按名称与 frame 链找元素；frame 为 null 表示顶层文档。 */
  function find(ob: ObserveResult, name: string, frame: RegExp[] | null): ObservedElement {
    const e = ob.elements.find((x) => {
      if (x.name !== name) return false;
      const chain = x.frame ?? [];
      if (!frame) return chain.length === 0;
      return chain.length === frame.length && frame.every((re, i) => re.test(chain[i] as string));
    });
    assert.ok(e, `找不到 ${name}（frame ${frame?.map(String).join(' > ') ?? '顶层'}）`);
    return e;
  }
  const NESTED = [
    /^iframe(#nested-frame|\[id="nested-frame"\])$/,
    /^iframe(#inner-frame|\[id="inner-frame"\])$/,
  ];

  test('observe 看到开放、嵌套、封闭 Shadow DOM 与各级 frame 里的元素', async () => {
    const pageId = await openMain();
    const ob = await observe(env.session, { pageId });
    contracts.assert('observe.Result', ob);
    for (const name of ['关注', '收藏', '金额', '支付']) find(ob, name, null);
    find(ob, '外层按钮', [NESTED[0] as RegExp]);
    for (const chain of [[FRAMES.same], [FRAMES.cross], [FRAMES.shadow], NESTED]) {
      const submit = find(ob, '提交', chain);
      const email = find(ob, '邮箱', chain);
      assert.equal(email.input_type, 'email');
      assert.ok(submit.clickable, `${chain.map(String)} 内的提交按钮可点击`);
      assert.ok(ob.snapshot_text?.includes(`[${submit.ref}] button "提交"`));
    }
    const submits = ob.elements.filter((e) => e.name === '提交').map((e) => e.ref);
    assert.equal(new Set(submits).size, 4, '四个 frame 里的同名按钮编号各不相同');
    await run({ op: 'close_page', pageId });
  });

  test('跨域与嵌套 iframe：按编号和按定位器操作，效果在顶层可见', async () => {
    const pageId = await openMain();
    const page = env.session.pages.get(pageId);
    const ob = await observe(env.session, { pageId });

    // 跨域：按编号填写与点击
    await ok({
      op: 'fill',
      pageId,
      target: { ref: find(ob, '邮箱', [FRAMES.cross]).ref },
      value: 'a@x.cn',
    });
    const crossSubmit = find(ob, '提交', [FRAMES.cross]);
    await ok({
      op: 'click',
      pageId,
      target: { ref: crossSubmit.ref },
      post: [{ text_present: '跨域框架提交 1 次（a@x.cn）' }],
    });
    const crossFrame = page.frames().find((f) => f.url().includes('who=cross'));
    assert.ok(crossFrame);
    assert.equal(await crossFrame.$eval('#result', (e) => e.textContent), '已提交 1 次：a@x.cn');

    // 跨域：按持久定位器（带 frame 链）
    const crossLoc = await generateLocator(env.session, pageId, crossSubmit.ref);
    assert.ok(crossLoc.unique);
    assert.equal(crossLoc.locator.frame?.length, 1);
    const r = await ok({
      op: 'click',
      pageId,
      target: crossLoc.locator,
      post: [{ text_present: '跨域框架提交 2 次' }],
    });
    assert.notEqual(r.locator_used, 'ref');

    // 嵌套：同源外层 → 跨域内层
    const nestedSubmit = find(ob, '提交', NESTED);
    await ok({
      op: 'click',
      pageId,
      target: { ref: nestedSubmit.ref },
      post: [{ text_present: '嵌套框架提交 1 次' }],
    });
    const nestedLoc = await generateLocator(env.session, pageId, nestedSubmit.ref);
    assert.ok(nestedLoc.unique);
    assert.equal(nestedLoc.locator.frame?.length, 2);
    const nestedEmail = await generateLocator(env.session, pageId, find(ob, '邮箱', NESTED).ref);
    await ok({ op: 'fill', pageId, target: nestedEmail.locator, value: 'n@x.cn' });
    await ok({
      op: 'click',
      pageId,
      target: nestedLoc.locator,
      post: [{ text_present: '嵌套框架提交 2 次（n@x.cn）' }],
    });
    await ok({
      op: 'click',
      pageId,
      target: { ref: find(ob, '外层按钮', [NESTED[0] as RegExp]).ref },
      post: [{ text_present: '外层框架提交 1 次' }],
    });

    // 同源与 Shadow Root 里的 iframe
    await ok({
      op: 'click',
      pageId,
      target: { ref: find(ob, '提交', [FRAMES.same]).ref },
      post: [{ text_present: '同源框架提交 1 次' }],
    });
    const shadowSubmit = find(ob, '提交', [FRAMES.shadow]);
    const shadowLoc = await generateLocator(env.session, pageId, shadowSubmit.ref);
    assert.ok(shadowLoc.unique, JSON.stringify(shadowLoc.locator));
    await ok({
      op: 'click',
      pageId,
      target: shadowLoc.locator,
      post: [{ text_present: '组件内框架提交 1 次' }],
    });
    await run({ op: 'close_page', pageId });
  });

  test('Shadow DOM：开放、嵌套、封闭的元素按编号和定位器都能操作', async () => {
    const pageId = await openMain();
    const page = env.session.pages.get(pageId);
    const ob = await observe(env.session, { pageId });
    await ok({ op: 'click', pageId, target: { ref: find(ob, '关注', null).ref } });
    const star = await generateLocator(env.session, pageId, find(ob, '收藏', null).ref);
    assert.ok(star.unique);
    await ok({ op: 'click', pageId, target: star.locator });
    await ok({ op: 'fill', pageId, target: { ref: find(ob, '金额', null).ref }, value: '88' });
    const pay = await generateLocator(env.session, pageId, find(ob, '支付', null).ref);
    assert.ok(pay.unique, `封闭 Shadow 内的元素能生成唯一定位器：${JSON.stringify(pay.locator)}`);
    await ok({
      op: 'click',
      pageId,
      target: pay.locator,
      post: [{ text_present: '已支付 88 元' }],
    });
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __log: string[] }).__log), [
      '已关注',
      '已收藏',
      '已支付 88 元',
    ]);
    await run({ op: 'close_page', pageId });
  });

  for (const [how, name, from] of [
    ['target=_blank 链接', '在新标签页打开报表', 'link'],
    ['window.open', '弹出窗口', 'open'],
  ] as const) {
    test(`新标签页（${how}）：出现在 effects.new_pages，select_page 后可以 observe 与操作`, async () => {
      const pageId = await openMain();
      const ob = await observe(env.session, { pageId });
      const opener = ob.elements.find((e) => e.name === name);
      assert.ok(opener);
      const r = await ok({ op: 'click', pageId, target: { ref: opener.ref } });
      assert.equal(r.effects.new_pages.length, 1, JSON.stringify(r.effects));
      const popupId = r.effects.new_pages[0] as string;
      assert.ok(
        env.session.pages.list().some((p) => p.pageId === popupId),
        '新标签页已登记',
      );
      await ok({ op: 'wait_for', pageId: popupId, until: [{ text_present: `打开方式：${from}` }] });
      await ok({ op: 'select_page', pageId: popupId });
      const popup = await observe(env.session, { pageId: popupId });
      assert.match(popup.url, new RegExp(`/structure/popup\\.html\\?from=${from}$`));
      assert.equal(popup.title, '报表（新标签页）');
      const ack = popup.elements.find((e) => e.name === '确认收到');
      assert.ok(ack);
      await ok({
        op: 'click',
        pageId: popupId,
        target: { ref: ack.ref },
        post: [{ text_present: `已确认（来自 ${from}）` }],
      });
      // 编号属于各自的标签页：拿新标签页的编号去操作原页面要报错
      const wrong = await run({ op: 'click', pageId, target: { ref: ack.ref } });
      assert.equal(wrong.error?.code, 'invalid_params');
      await ok({ op: 'close_page', pageId: popupId });
      await ok({ op: 'select_page', pageId });
      await observe(env.session, { pageId });
      await run({ op: 'close_page', pageId });
    });
  }
});
