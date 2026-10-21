// 页面提示条（FR-29）：不影响 observe、不拦截鼠标、跨导航保持、hideBanner 后移除。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, BANNER_ATTR, hideBanner, observe, showBanner } from '../src/index.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

describe('页面提示条（FR-29）', { skip: SKIP }, () => {
  let env: TestEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('observe 看不到它、鼠标穿透、导航后仍在、hideBanner 后消失', async () => {
    const pageId = await env.open('/pages/banner.html');
    const page = env.session.pages.get(pageId);
    // 宿主在页面里的状态：是否存在、有没有渲染出尺寸（条里的内容在封闭 Shadow DOM 里，页面脚本读不到）
    const state = () =>
      page.evaluate((attr) => {
        const h = document.querySelector(`[${attr}]`);
        const r = h?.getBoundingClientRect();
        return h ? { w: r?.width ?? 0, h: r?.height ?? 0 } : null;
      }, BANNER_ATTR);
    const views = ['text', 'axtree'] as const;

    const before = await observe(env.session, { pageId, views: [...views] });
    await showBanner(page, 'Obact 正在操作');
    const shown = await state();
    assert.ok(shown && shown.w > 0 && shown.h > 0, '提示条应已渲染');

    const after = await observe(env.session, { pageId, views: [...views] });
    assert.deepEqual(after.elements, before.elements);
    assert.equal(after.text_md, before.text_md);
    assert.equal(after.axtree, before.axtree);
    // act 的文本断言（wait_for / assert）同样看不到条里的文字
    const gone = await act(env.session, {
      op: 'wait_for',
      pageId,
      until: [{ text_absent: 'Obact 正在操作' }],
      timeout_ms: 2000,
    });
    assert.equal(gone.status, 'ok', gone.error?.message);

    // 提示条盖在按钮上，真实鼠标点击仍然点到按钮
    const target = await page.evaluate((attr) => {
      const bar = (document.querySelector(`[${attr}]`) as HTMLElement).getBoundingClientRect();
      const b = (document.getElementById('under') as HTMLElement).getBoundingClientRect();
      const [x, y] = [b.left + b.width / 2, b.top + b.height / 2];
      return { x, y, covered: x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom };
    }, BANNER_ATTR);
    assert.ok(target.covered, '测试前提：提示条应盖住按钮中心');
    await page.mouse.click(target.x, target.y);
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { events: string[] }).events),
      ['under'],
    );

    // 导航产生新文档后自动重新出现
    await page.goto(`${env.server.base}/pages/basic.html`, { waitUntil: 'load' });
    assert.ok((await state())?.w, '导航后提示条应仍在');

    await hideBanner(page);
    assert.equal(await state(), null, 'hideBanner 后应移除');
    await page.goto(`${env.server.base}/pages/banner.html`, { waitUntil: 'load' });
    assert.equal(await state(), null, '移除后新文档里不再出现');
  });

  test('当前页是 SVG 等非 HTML 文档时：showBanner 不抛错、不放提示条，页面脚本也不报错；换到 HTML 页面后提示条照常出现', async () => {
    const pageId = await env.open('/pages/star.svg');
    const page = env.session.pages.get(pageId);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const present = () =>
      page.evaluate((attr) => !!document.querySelector(`[${attr}]`), BANNER_ATTR);

    await showBanner(page, 'Obact 正在操作');
    assert.equal(await present(), false, 'SVG 文档里没有 HTML 元素，不放提示条');
    await page.goto(`${env.server.base}/pages/star.svg`, { waitUntil: 'load' });
    assert.equal(await present(), false);
    await page.goto(`${env.server.base}/pages/basic.html`, { waitUntil: 'load' });
    assert.equal(await present(), true, '注入脚本仍然登记着，HTML 页面里照常出现');
    assert.deepEqual(errors, [], 'SVG 文档里的注入脚本不报错');
    await hideBanner(page);
  });
});
