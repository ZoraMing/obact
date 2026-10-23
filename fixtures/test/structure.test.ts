// 夹具：页面结构（PRD 9.3，FR-04、FR-05）。开放 / 封闭 Shadow DOM、同源 / 跨域 / 嵌套 iframe、新标签页：
// observe 都看得到，按编号和按定位器都能操作，效果在顶层可见。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { generateLocator, observe } from '@obact/core';
import { type FixtureEnv, ok, SKIP, setup } from './helpers.ts';

describe('夹具 structure（FR-04、FR-05）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('Shadow DOM、各级 iframe 与新标签页里的元素都能观察和操作', async () => {
    const pageId = await env.open('/structure/');
    const page = env.session.pages.get(pageId);
    for (const who of ['same', 'cross', 'nested']) {
      const f = await page.waitForFrame((fr) => fr.url().includes(`who=${who}`));
      await f.waitForSelector('#submit');
    }
    const ob = await observe(env.session, { pageId });
    const named = (name: string) => ob.elements.filter((e) => e.name === name);
    for (const name of ['关注', '金额', '支付']) assert.equal(named(name).length, 1, name);
    const [same, cross, nested] = ['same-frame', 'cross-frame', 'inner-frame'].map((id) => {
      const e = named('提交').find((x) => x.frame?.at(-1)?.includes(id));
      assert.ok(e, `${id} 里的提交按钮`);
      return e;
    });
    assert.equal(named('提交').length, 3, '三个 frame 里的同名按钮各有编号');
    assert.equal(nested?.frame?.length, 2, '嵌套 frame 链有两级');

    // Shadow DOM：开放的按编号点，封闭的按定位器点
    await ok(env, { op: 'click', pageId, target: { ref: named('关注')[0]?.ref as number } });
    await ok(env, {
      op: 'fill',
      pageId,
      target: { ref: named('金额')[0]?.ref as number },
      value: '88',
    });
    const pay = await generateLocator(env.session, pageId, named('支付')[0]?.ref as number);
    assert.ok(pay.unique, JSON.stringify(pay.locator));
    await ok(env, {
      op: 'click',
      pageId,
      target: pay.locator,
      post: [{ text_present: '已支付 88 元' }],
    });
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __log: string[] }).__log), [
      '已关注',
      '已支付 88 元',
    ]);

    // 跨域 iframe：按编号填写与点击，再按带 frame 链的持久定位器点击
    const email = named('邮箱').find((x) => x.frame?.at(-1)?.includes('cross-frame'));
    await ok(env, { op: 'fill', pageId, target: { ref: email?.ref as number }, value: 'a@x.cn' });
    await ok(env, {
      op: 'click',
      pageId,
      target: { ref: cross?.ref as number },
      post: [{ text_present: '跨域框架提交 1 次（a@x.cn）' }],
    });
    // 同源与嵌套（同源外层 → 跨域内层，frame 链两级）也按定位器点击
    for (const [e, label, nth] of [
      [cross, '跨域框架', 2],
      [nested, '嵌套框架', 1],
      [same, '同源框架', 1],
    ] as const) {
      const g = await generateLocator(env.session, pageId, e?.ref as number);
      assert.ok(g.unique, JSON.stringify(g.locator));
      assert.equal(g.locator.frame?.length, e?.frame?.length);
      const r = await ok(env, {
        op: 'click',
        pageId,
        target: g.locator,
        post: [{ text_present: `${label}提交 ${nth} 次` }],
      });
      assert.notEqual(r.locator_used, 'ref');
    }

    // 新标签页：出现在 effects.new_pages，select_page 后可以 observe 与操作
    const r = await ok(env, {
      op: 'click',
      pageId,
      target: { ref: named('在新标签页打开表单')[0]?.ref as number },
    });
    assert.equal(r.effects.new_pages.length, 1, JSON.stringify(r.effects));
    const popupId = r.effects.new_pages[0] as string;
    await ok(env, { op: 'select_page', pageId: popupId });
    const popup = await observe(env.session, { pageId: popupId });
    assert.match(popup.url, /\/structure\/frame\.html\?who=popup$/);
    await ok(env, {
      op: 'click',
      pageId: popupId,
      target: { ref: popup.elements.find((e) => e.name === '提交')?.ref as number },
      post: [{ text_present: '已提交 1 次' }],
    });
    await ok(env, { op: 'close_page', pageId: popupId });
  });
});
