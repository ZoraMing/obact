import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  asObactError,
  markPage,
  ObactError,
  resolveLocator,
  resolveRef,
  resolveTarget,
  Session,
} from '../src/index.ts';
import { rejectsWithCode, SKIP, setup, type TestEnv } from './helpers.ts';

let env: TestEnv;

/** basic.html 主文档里的可交互元素数（含 2 个 option、隐藏的导出按钮、开放和封闭 Shadow 内的按钮）。 */
const MAIN_INTERACTIVE = 18;

async function text(s: Session, pageId: string, ref: number): Promise<string> {
  const r = await resolveRef(s, pageId, ref);
  return r.handle.evaluate(
    (el) => (el as HTMLElement).innerText || el.getAttribute('placeholder') || '',
  );
}

/** 找出某段文字对应的编号。 */
async function refOf(s: Session, pageId: string, label: string): Promise<number> {
  const frames = await markPage(s, pageId);
  for (const f of frames) {
    for (const ref of f.refs) {
      if ((await text(s, pageId, ref).catch(() => '')) === label) return ref;
    }
  }
  throw new Error(`找不到 ${label}`);
}

describe('底座：编号、解析与标签页', { skip: SKIP }, () => {
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('给主文档、iframe（含跨域）、开放与封闭 Shadow DOM 的可交互元素编号', async () => {
    const pageId = await env.open('/pages/basic.html', { pageId: 'main' });
    const page = env.session.pages.get(pageId);
    await page.waitForFrame((f) => f.url().includes('who=cross'));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
    const frames = await markPage(env.session, pageId);
    const main = frames[0];
    assert.ok(main);
    assert.equal(main.refs.length, MAIN_INTERACTIVE);
    const inFrames = frames.slice(1).map((f) => f.refs.length);
    assert.deepEqual(inFrames, [2, 2]);
    const all = frames.flatMap((f) => f.refs);
    assert.equal(new Set(all).size, all.length, '编号不重复');
    assert.deepEqual(
      all,
      [...all].sort((a, b) => a - b),
      '按顺序递增',
    );

    const again = await markPage(env.session, pageId);
    assert.equal(again.flatMap((f) => f.added).length, 0, '再次编号不新增');
    assert.deepEqual(
      again.flatMap((f) => f.refs),
      all,
      '已有编号保持不变',
    );

    assert.equal(
      await text(env.session, pageId, await refOf(env.session, pageId, '封闭按钮')),
      '封闭按钮',
    );
  });

  test('编号绑定具体节点：克隆重绘与新节点重绘都判定失效，重新编号不复用', async () => {
    const pageId = await env.open('/pages/basic.html');
    const a = await refOf(env.session, pageId, '条目 A');
    const page = env.session.pages.get(pageId);

    await page.click('#rerender-clone');
    await rejectsWithCode(resolveRef(env.session, pageId, a), 'stale_ref');
    const a2 = await refOf(env.session, pageId, '条目 A');
    assert.ok(a2 > a, `克隆节点获得新编号（${a2} > ${a}）`);
    const attr = await page.$eval('#list button', (el) => el.getAttribute('data-obact-ref'));
    assert.equal(Number(attr), a2, '属性被新编号覆盖');

    await page.click('#rerender-fresh');
    await rejectsWithCode(resolveRef(env.session, pageId, a2), 'stale_ref');
    const a3 = await refOf(env.session, pageId, '条目 A');
    assert.ok(a3 > a2);
  });

  test('新会话把旧会话的编号视为失效并重新编号', async () => {
    const pageId = await env.open('/pages/basic.html');
    const old = await refOf(env.session, pageId, '查询');
    const s2 = await Session.attach(env.browser);
    try {
      const pageId2 = s2.pages.idOf(env.session.pages.get(pageId));
      assert.ok(pageId2);
      await rejectsWithCode(resolveRef(s2, pageId2, old), 'stale_ref');
      const fresh = await refOf(s2, pageId2, '查询');
      assert.equal(await text(s2, pageId2, fresh), '查询');
      // 旧会话的编号也随之失效：属性已被新会话覆盖
      await rejectsWithCode(resolveRef(env.session, pageId, old), 'stale_ref');
    } finally {
      s2.pages.dispose();
    }
  });

  test('未分配的编号、属于其他标签页的编号', async () => {
    const p1 = await env.open('/pages/basic.html');
    const p2 = await env.open('/pages/basic.html');
    const ref = await refOf(env.session, p1, '查询');
    await rejectsWithCode(resolveRef(env.session, p1, 99999), 'stale_ref');
    await rejectsWithCode(resolveRef(env.session, p2, ref), 'invalid_params');
  });

  test('定位器：CSS、within 消歧、角色+名称、隐藏副本、Shadow DOM', async () => {
    const pageId = await env.open('/pages/basic.html');
    const s = env.session;
    const css = await resolveLocator(s, pageId, { css: '[data-testid=query-btn]' });
    assert.equal(css.via, 'css');

    await rejectsWithCode(resolveLocator(s, pageId, { css: 'button.audit' }), 'not_unique');
    const row = await resolveLocator(s, pageId, {
      css: 'button.audit',
      within: "tr[data-id='88232']",
    });
    assert.equal(await row.handle.evaluate((el) => el.closest('tr')?.dataset.id), '88232');

    const byRole = await resolveLocator(s, pageId, { role: 'textbox', name: '订单号' });
    assert.equal(byRole.via, 'role');
    assert.equal(await byRole.handle.evaluate((el) => el.id), 'order');

    // CSS 不唯一时退到 角色+名称
    const fallback = await resolveLocator(s, pageId, {
      css: 'button',
      role: 'button',
      name: '自绘按钮',
    });
    assert.equal(fallback.via, 'role');
    await rejectsWithCode(
      resolveLocator(s, pageId, { role: 'button', name: '审核' }),
      'not_unique',
    );
    const partial = await resolveLocator(s, pageId, { role: 'link', name: '详', exact: false });
    assert.equal(partial.via, 'role');

    const visible = await resolveLocator(s, pageId, { css: 'button.resp' });
    assert.equal(
      await visible.handle.evaluate((el) => getComputedStyle(el).display),
      'inline-block',
    );

    const open = await resolveLocator(s, pageId, { css: 'button.sh' });
    assert.equal(await open.handle.evaluate((el) => el.textContent), '开放按钮');
    await markPage(s, pageId); // 挂上封闭的 Shadow Root
    const closed = await resolveLocator(s, pageId, { role: 'button', name: '封闭按钮' });
    assert.equal(await closed.handle.evaluate((el) => el.className), 'sh-closed');

    await rejectsWithCode(resolveLocator(s, pageId, { css: '#nope' }), 'not_found');
  });

  test('定位器：进入同源与跨域 iframe', async () => {
    const pageId = await env.open('/pages/basic.html');
    const page = env.session.pages.get(pageId);
    await page.waitForFrame((f) => f.url().includes('who=cross'));
    for (const id of ['same', 'cross']) {
      const r = await resolveTarget(env.session, pageId, { css: '#in-frame', frame: [`#${id}`] });
      assert.equal(await r.frame.evaluate(() => document.body.dataset.who), id);
    }
    await rejectsWithCode(
      resolveLocator(env.session, pageId, { css: '#in-frame', frame: ['#missing'] }),
      'not_found',
    );
  });

  test('标签页登记：指定 ID、弹出窗口自动登记、关闭后报错', async () => {
    const reg = env.session.pages;
    const pageId = await env.open('/pages/basic.html', { pageId: 'reg-main' });
    const mark = reg.mark();
    await env.session.pages.get(pageId).click('#popup');
    let created: string[] = [];
    for (let i = 0; i < 50 && created.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      created = reg.createdSince(mark);
    }
    assert.equal(created.length, 1);
    const popup = reg.get(created[0] as string);
    await popup.waitForFunction(() => document.body?.dataset.who === 'popup');
    await popup.close();
    assert.throws(
      () => reg.get(created[0] as string),
      (e: ObactError) => e.code === 'page_not_found',
    );
    await assert.rejects(
      reg.newPage({ pageId: 'reg-main' }),
      (e: ObactError) => e.code === 'invalid_params',
    );
    await assert.rejects(
      reg.newPage({ pageId: 'bad id' }),
      (e: ObactError) => e.code === 'invalid_params',
    );
  });

  test('错误归一', () => {
    const t = new Error('waiting failed');
    t.name = 'TimeoutError';
    assert.equal(asObactError(t).code, 'timeout');
    assert.equal(asObactError(new Error('Target closed')).code, 'browser_disconnected');
    assert.equal(asObactError('x').code, 'internal');
    const e = new ObactError('not_found', 'x', { a: 1 });
    assert.deepEqual(e.toJSON(), { code: 'not_found', message: 'x', details: { a: 1 } });
  });
});

describe('页面内助手：稳定性判断与所在容器', { skip: SKIP }, () => {
  let env2: TestEnv;
  before(async () => {
    env2 = await setup();
  });
  after(async () => {
    await env2?.close();
  });

  test('obIsStableToken / obIsStableText / obWithin', async () => {
    const pageId = await env2.open('/pages/basic.html');
    const page = env2.session.pages.get(pageId);
    const { bundle } = await import('../src/page/bundle.ts');
    const { DOM_LIB, obIsStableToken, obIsStableText, obWithin } = await import(
      '../src/page/dom.ts'
    );
    const tokens = await page.evaluate(
      bundle((list: string[]) => list.map((t) => obIsStableToken(t)), DOM_LIB),
      [
        'audit-btn',
        'submit',
        'order-list',
        'id-1696845123',
        'css-1x2y3z',
        'Button_btn__3xK9z',
        ':r1:',
        'a8f3k2l9q',
        'sc-bdVaJa',
        'row-2',
      ],
    );
    assert.deepEqual(tokens, [true, true, true, false, false, false, false, false, false, true]);
    const texts = await page.evaluate(
      bundle((l: string[]) => l.map((t) => obIsStableText(t)), DOM_LIB),
      ['审核', '订单 88231', '2026-10-15'],
    );
    assert.deepEqual(texts, [true, false, false]);
    const within = await page.evaluate(
      bundle(() => obWithin(document.querySelectorAll('button.audit')[1] as Element), DOM_LIB),
    );
    assert.equal(within, "tr[data-id='88232']");
    const none = await page.evaluate(
      bundle(() => obWithin(document.getElementById('query') as Element), DOM_LIB),
    );
    assert.equal(none, null);
  });
});
