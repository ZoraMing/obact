import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import type { ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { observe } from '../src/index.ts';
import { rejectsWithCode, SKIP, setup, type TestEnv } from './helpers.ts';

const contracts = new Contracts();
const byName = (r: ObserveResult, name: string): ObservedElement => {
  const e = r.elements.find((x) => x.name === name);
  assert.ok(e, `找不到元素：${name}`);
  return e;
};

describe('observe（FR-05、FR-08、FR-11、FR-31）', { skip: SKIP }, () => {
  let env: TestEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function openMisc(): Promise<string> {
    const pageId = await env.open('/pages/observe-misc.html');
    const page = env.session.pages.get(pageId);
    await page.waitForFrame((f) => f.url().includes('who=cross'));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
    return pageId;
  }

  test('返回值符合契约；elements、snapshot_text、DOM 属性编号一致', async () => {
    const pageId = await openMisc();
    const r = await observe(env.session, { pageId });
    contracts.assert('observe.Result', r);
    const page = env.session.pages.get(pageId);
    const domRefs = await page.$$eval('[data-obact-ref]', (els) =>
      els.map((e) => Number(e.getAttribute('data-obact-ref'))),
    );
    for (const e of r.elements) {
      assert.ok(r.snapshot_text?.includes(`[${e.ref}] `), `snapshot_text 缺少 ${e.ref}`);
      if (!e.frame) assert.ok(domRefs.includes(e.ref), `DOM 中缺少 ${e.ref}`);
    }
    const lines = (r.snapshot_text ?? '').split('\n').filter((l) => /^\[\d+\]/.test(l));
    assert.equal(lines.length, r.elements.length);
  });

  test('密码与令牌类字段打码，普通字段显示原值', async () => {
    const pageId = await openMisc();
    const r = await observe(env.session, { pageId });
    assert.equal(byName(r, '账号').value, 'alice');
    assert.equal(byName(r, '密码').value, '***');
    assert.equal(byName(r, '令牌').value, '***');
    assert.ok(!r.snapshot_text?.includes('s3cret'));
  });

  test('iframe（同源与跨域）内元素的 bbox 与 Puppeteer 一致', async () => {
    const pageId = await openMisc();
    const page = env.session.pages.get(pageId);
    const r = await observe(env.session, { pageId });
    for (const who of ['same', 'cross']) {
      const e = r.elements.find(
        (x) => x.name === 'frame 内按钮' && x.frame?.[0]?.includes(`#${who}`),
      );
      assert.ok(e, `找不到 ${who} 内的按钮`);
      const owner = await page.$(`#${who}`);
      const frame = await owner?.contentFrame();
      const box = await (await frame?.$('#in-frame'))?.boundingBox();
      assert.ok(box);
      const [x, y, w, h] = e.bbox;
      for (const [a, b] of [
        [x, box.x],
        [y, box.y],
        [w, box.width],
        [h, box.height],
      ] as [number, number][]) {
        assert.ok(Math.abs(a - b) <= 1, `${who}: bbox ${e.bbox} vs ${JSON.stringify(box)}`);
      }
    }
  });

  test('部分出视口的可见比例、被遮罩挡住时不可点击', async () => {
    const pageId = await openMisc();
    const r = await observe(env.session, { pageId });
    const half = byName(r, '半出视口');
    assert.ok(half.visible_ratio > 0.4 && half.visible_ratio < 0.6, `ratio ${half.visible_ratio}`);
    assert.equal(byName(r, '被遮挡').clickable, false);
    assert.equal(byName(r, '账号').clickable, true);
  });

  test('纯网页信息只含不可操作内容', async () => {
    const pageId = await openMisc();
    const r = await observe(env.session, { pageId });
    assert.ok(r.text_md.includes('登录'));
    assert.ok(r.text_md.includes('请输入账号和密码。'));
    assert.ok(!r.text_md.includes('半出视口'));
    assert.ok(!r.text_md.includes('账号 '), '控件的标签文字不进纯网页信息');
  });

  test('字符预算：截断并标注，elements 与 snapshot_text 始终一致', async () => {
    const pageId = await env.open('/pages/observe-long.html');
    const full = await observe(env.session, { pageId });
    assert.equal(full.truncated, false);
    assert.equal(full.elements.length, 300);
    const r = await observe(env.session, { pageId, max_chars: 3000 });
    contracts.assert('observe.Result', r);
    assert.equal(r.truncated, true);
    assert.ok(r.elements.length < 300);
    assert.ok((r.snapshot_text ?? '').length + r.text_md.length <= 3000, '总长不超过预算');
    for (const e of r.elements) assert.ok(r.snapshot_text?.includes(`[${e.ref}] `));
    // 优先保留视口内可见的元素
    const visible = full.elements.filter((e) => e.visible_ratio > 0).map((e) => e.ref);
    for (const ref of visible.slice(0, 5)) {
      assert.ok(
        r.elements.some((e) => e.ref === ref),
        `视口内元素 ${ref} 应被保留`,
      );
    }
    await rejectsWithCode(observe(env.session, { pageId, max_chars: 10 }), 'invalid_params');
  });

  test('页面签名：url、title、must_exist、must_not_exist', async () => {
    const pageId = await openMisc();
    const sigs = [
      { id: 'list', url: '/orders$' },
      { id: 'login-done', title: '观察测试', must_not_exist: [{ css: '#user' }] },
      { id: 'login', title: '观察测试', must_exist: [{ role: 'textbox', name: '账号' }] },
    ];
    const r = await observe(env.session, { pageId }, { signatures: sigs });
    assert.equal(r.signature, 'login');
    const none = await observe(env.session, { pageId }, { signatures: sigs.slice(0, 2) });
    assert.equal(none.signature, null);
  });

  test('Canvas 大面积覆盖时告警', async () => {
    const pageId = await env.open('/pages/observe-canvas.html');
    const r = await observe(env.session, { pageId });
    assert.equal(r.canvas_warning, true);
    const misc = await observe(env.session, { pageId: await openMisc() });
    assert.equal(misc.canvas_warning, false);
  });

  test('截图、编号框截图（结束后 DOM 不变）、可访问性树', async () => {
    const pageId = await openMisc();
    const page = env.session.pages.get(pageId);
    await observe(env.session, { pageId }); // 先编号：编号会给元素加属性
    const before = await page.evaluate(() => document.documentElement.outerHTML.length);
    const r = await observe(env.session, {
      pageId,
      views: ['text', 'screenshot', 'som', 'axtree'],
    });
    contracts.assert('observe.Result', r);
    assert.ok(r.screenshot_path && existsSync(r.screenshot_path));
    assert.ok(r.som_path && existsSync(r.som_path));
    const after = await page.evaluate(() => document.documentElement.outerHTML.length);
    assert.equal(after, before, '编号框覆盖层已移除');
    assert.equal(await page.$('[data-obact-som]'), null);
    assert.ok(r.axtree);
    const axRefs = [...(r.axtree.matchAll(/\[(\d+)\]/g) ?? [])].map((m) => Number(m[1]));
    const refs = new Set(r.elements.map((e) => e.ref));
    assert.ok(axRefs.length > 0);
    for (const ref of axRefs) assert.ok(refs.has(ref), `可访问性树中的 [${ref}] 不在 elements 中`);
    assert.equal(r.viewport.scale > 0, true);
  });

  test('参数校验：未知视图', async () => {
    const pageId = await openMisc();
    await rejectsWithCode(
      observe(env.session, { pageId, views: ['dom' as 'text'] }),
      'invalid_params',
    );
  });

  test('大表性能：5000 行（1 万个可交互元素）', async () => {
    const pageId = await env.open('/pages/observe-long.html');
    // 复用长页面的结构，追加 5000 行
    await env.session.pages.get(pageId).evaluate(() => {
      const rows: string[] = [];
      for (let i = 0; i < 5000; i++) {
        rows.push(
          `<tr data-id="${i}"><td>订单 ${i}</td><td><input value="${i}"></td><td><button>审核</button></td></tr>`,
        );
      }
      document.body.insertAdjacentHTML(
        'beforeend',
        `<table><tbody>${rows.join('')}</tbody></table>`,
      );
    });
    const t = performance.now();
    const r = await observe(env.session, { pageId });
    const ms = performance.now() - t;
    console.log(
      `大表 observe：${Math.round(ms)} ms，元素 ${r.elements.length}，截断 ${r.truncated}`,
    );
    assert.ok(ms < 4000, `耗时 ${ms}`);
    assert.equal(r.truncated, true);
  });
});
