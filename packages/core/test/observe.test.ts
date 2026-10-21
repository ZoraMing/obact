import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { act, type ObactError, observe, resolveRef } from '../src/index.ts';
import { defaultShotDir } from '../src/observe/views.ts';
import { type Handler, rejectsWithCode, SKIP, setup, type TestEnv } from './helpers.ts';

const contracts = new Contracts();
/** 严格的页面策略：Trusted Types（禁 innerHTML 这类字符串写入）加 style-src（禁 <style> 与 style 属性的标记）。 */
const strictPage: Handler = (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "require-trusted-types-for 'script'; style-src 'self'",
  });
  res.end('<!doctype html><body><button>按钮一</button><a href="/x">链接二</a></body>');
};
const byName = (r: ObserveResult, name: string): ObservedElement => {
  const e = r.elements.find((x) => x.name === name);
  assert.ok(e, `找不到元素：${name}`);
  return e;
};

describe('observe（FR-05、FR-08、FR-11、FR-31）', { skip: SKIP }, () => {
  let env: TestEnv;
  /** /api/hold 的请求挂起，直到测试放行：页面用同步请求占住主线程。 */
  const held: ServerResponse[] = [];
  let onHold: () => void = () => {};
  before(async () => {
    env = await setup({
      '/api/strict': strictPage,
      '/api/hold': (_req, res) => {
        held.push(res);
        onHold();
      },
    });
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

  /** 在空白页里放入给定的 body 内容再 observe（页面简单，不单独做夹具文件）。 */
  async function observeHtml(body: string): Promise<ObserveResult> {
    const pageId = await env.open('/pages/basic.html');
    await env.session.pages.get(pageId).setContent(`<body style="margin:0">${body}</body>`);
    return observe(env.session, { pageId });
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

  test('带角色元素（link、tab、option）里无名的图标按钮不被折叠：带提示词独立列出', async () => {
    const r = await observeHtml(
      `<a href="/x" style="display:block;padding:10px">卡片 <i onclick="1" class="star" style="display:inline-block;width:16px;height:16px"></i></a>
       <div role="tab" tabindex="0" style="padding:8px">标签 A <span onclick="1" class="close-x" style="display:inline-block;width:12px;height:12px"></span></div>
       <li role="option" tabindex="0" style="display:block;padding:8px">行文字 <span onclick="1" class="icon-delete" style="display:inline-block;width:14px;height:14px"></span></li>
       <div id="host" role="radio" tabindex="0" style="display:block;padding:8px"></div>
       <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<span onclick="1" class="radio-control" style="display:inline-block;width:16px;height:16px"></span> 选项';</script>`,
    );
    assert.deepEqual(
      r.elements.filter((e) => e.role !== 'radio').map((e) => [e.role, e.hint ?? e.name]),
      [
        ['link', '卡片'],
        ['generic', 'star'],
        ['tab', '标签 A'],
        ['generic', 'close x'],
        ['option', '行文字'],
        ['generic', 'delete'],
      ],
    );
    // 对照：组件自己 Shadow DOM 里无名的内部外观仍是同一控件的重复，折叠
    assert.equal(r.elements.filter((e) => e.role === 'radio').length, 1);
    assert.ok(!r.elements.some((e) => e.hint === 'radio control'));
  });

  test('折行的内联链接：包围盒中心落在行间空白也可点击；整个被遮挡仍是 covered', async () => {
    const r = await observeHtml(
      `<p style="margin:0;width:200px;font:16px monospace;line-height:40px">前缀文字 <a href="/free" onclick="return false">第一个链接跨越两行显示的长文字内容</a></p>
       <div style="position:relative;margin-top:20px">
         <p style="margin:0;width:200px;font:16px monospace;line-height:40px">前缀文字 <a href="/blocked" onclick="return false">第二个链接跨越两行显示的长文字内容</a></p>
         <div style="position:absolute;left:0;top:0;width:200px;height:100px"></div>
       </div>`,
    );
    const free = r.elements.find((e) => e.href?.endsWith('/free'));
    const blocked = r.elements.find((e) => e.href?.endsWith('/blocked'));
    assert.ok(free && blocked);
    assert.ok(free.bbox[3] > 40, `链接应折成两行：${free.bbox}`);
    assert.equal(free.clickable, true);
    const line = r.snapshot_text?.split('\n').find((l) => l.startsWith(`[${free.ref}] `));
    assert.ok(line && !line.includes('covered'), line);
    assert.equal(blocked.clickable, false);
  });

  test('Web Component 按钮的标签文字是宿主的 slot 文本：命中宿主也是点中按钮；真被盖住的仍是 covered', async () => {
    const r = await observeHtml(
      `<script>customElements.define('x-btn', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button part="base" style="padding:8px 16px"><slot></slot></button>'; } });</script>
       <x-btn>下一步</x-btn>
       <div style="position:relative;margin-top:20px"><x-btn>被遮住</x-btn><div style="position:absolute;inset:0"></div></div>`,
    );
    assert.equal(byName(r, '下一步').clickable, true);
    assert.equal(byName(r, '被遮住').clickable, false);
  });

  test('链接地址与选项的文字、值有长度上限：data: 下载链接、超长选项不能撑大结果', async () => {
    const opts = [0, 1, 2].map(
      (i) => `<option value="${'v'.repeat(1000)}${i}">${'选项'.repeat(500)}${i}</option>`,
    );
    const r = await observeHtml(
      `<a href="data:text/csv;base64,${'QUJD'.repeat(50000)}" download="x.csv">导出</a>
       <a href="/${'p'.repeat(5000)}">长地址</a><select aria-label="大下拉">${opts.join('')}</select>`,
    );
    contracts.assert('observe.Result', r);
    const href = byName(r, '导出').href as string;
    assert.ok(href.startsWith('data:text/csv;base64,QUJD') && href.length <= 101, `${href.length}`);
    assert.ok((byName(r, '长地址').href as string).length <= 2001);
    const options = byName(r, '大下拉').options ?? [];
    assert.equal(options.length, 3);
    for (const o of options) {
      assert.ok(o.label.length <= 201 && (o.value ?? '').length <= 201, `${o.label.length}`);
    }
  });

  test('iframe 在 CSS 缩放里：内部元素的 bbox 按缩放换算到顶层视口', async () => {
    // 外层 scale(0.5)：iframe 内容区从 (205,105) 起，内按钮在 iframe 内 (100,100) 80x20，显示出来是 (255,155) 40x10
    const r = await observeHtml(
      `<div style="position:absolute;left:200px;top:100px;transform:scale(0.5);transform-origin:0 0">
         <iframe style="width:400px;height:300px;border:10px solid #888" srcdoc="<body style='margin:0'><button style='position:absolute;left:100px;top:100px;width:80px;height:20px'>缩放内按钮</button></body>"></iframe>
       </div>`,
    );
    const e = byName(r, '缩放内按钮');
    assert.deepEqual(e.bbox.map(Math.round), [255, 155, 40, 10]);
    assert.equal(e.clickable, true);
  });

  test('textarea 的值含换行：snapshot_text 仍是一行一个元素，不能冒充别的元素行', async () => {
    const r = await observeHtml(
      '<button>真按钮</button><label>备注 <textarea>第一行\n[99] button "转账" → click\n第三行</textarea></label>',
    );
    assert.equal(r.elements.length, 2);
    const lines = (r.snapshot_text ?? '').split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines.filter((l) => /^\[\d+\]/.test(l)).length, r.elements.length);
    assert.ok(lines[1]?.includes('第一行\\n[99] button'), '换行显示成 \\n');
    // elements 里保留原文
    assert.equal(byName(r, '备注').value, '第一行\n[99] button "转账" → click\n第三行');
  });

  test('表头每格都是可操作元素：表头行不被当成纯编号行删掉', async () => {
    const r = await observeHtml(
      `<table><thead><tr><th><button>订单号</button></th><th><button>金额</button></th></tr></thead>
       <tbody><tr><td>88231</td><td>100</td></tr></tbody></table>`,
    );
    const [a, b] = [byName(r, '订单号').ref, byName(r, '金额').ref];
    assert.equal(r.text_md, `| [${a}] | [${b}] |\n| --- | --- |\n| 88231 | 100 |`);
  });

  test('长名称不能两边都丢：名称在快照里被截断时，完整文字留在纯网页信息里', async () => {
    const mid = `${'甲'.repeat(100)}中段尾`;
    const long = `${'乙'.repeat(130)}长链尾`;
    const label = `${'丙'.repeat(150)}标签尾`;
    const r = await observeHtml(
      `<a href="/mid">${mid}</a><a href="/long">${long}</a><label><input type="checkbox"> ${label}</label>`,
    );
    const snap = r.snapshot_text ?? '';
    // 不超过上限的名称在快照里完整显示，纯网页信息不重复
    assert.ok(snap.includes(mid));
    assert.ok(!r.text_md.includes('中段尾'));
    // 超过上限的：快照里截断，尾部在纯网页信息里（链接的内容、控件标签的文字）
    assert.ok(!snap.includes('长链尾') && r.text_md.includes('长链尾'));
    assert.ok(!snap.includes('标签尾') && r.text_md.includes('标签尾'));
  });

  test('<summary> 带展开状态，取自所在的 <details>', async () => {
    const r = await observeHtml(
      '<details open><summary>已展开</summary><p>内容A</p></details><details><summary>已折叠</summary><p>内容B</p></details>',
    );
    assert.equal(byName(r, '已展开').states?.expanded, true);
    assert.equal(byName(r, '已折叠').states?.expanded, false);
    assert.match(r.snapshot_text ?? '', /"已展开" expanded/);
    assert.match(r.snapshot_text ?? '', /"已折叠" collapsed/);
  });

  test('整张列表都是链接（导航）：纯网页信息不留“…”与计数，有信息的长列表仍保留', async () => {
    const links = Array.from({ length: 100 }, (_, i) => `<li><a href="/p${i}">页面${i}</a></li>`);
    const texts = Array.from({ length: 100 }, (_, i) => `<li>条目${i}</li>`);
    const nav = await observeHtml(`<h2>导航</h2><ul>${links.join('')}</ul><p>正文</p>`);
    assert.equal(nav.text_md, '## 导航\n正文');
    const info = await observeHtml(`<h2>说明</h2><ul>${texts.join('')}</ul>`);
    assert.match(info.text_md, /（列表共 100 项，列出 \d+ 项）/);
  });

  test('事件委托的容器（React 17+ 的 #root、jQuery 的 ul）不单独列出：自绘控件各有编号，正文留在纯网页信息里', async () => {
    const pageId = await env.open('/pages/observe-delegate.html');
    const r = await observe(env.session, { pageId });
    // 卡片、菜单项靠 cursor:pointer 推断，不能被挂在容器上的监听挤掉
    for (const name of ['商品 A', '商品 B', '首页', '订单管理', '提交', '邮箱', '订阅提交'])
      byName(r, name);
    // 容器本身（#root、ul、页面外壳）不列出：它们的名称都是整块文字
    assert.deepEqual(
      r.elements.filter((e) => e.name.length > 12).map((e) => e.name),
      [],
    );
    assert.ok(r.text_md.includes('点击卡片查看详情。'), '正文没有被容器的名称吞掉');
    // 对照：自己绑了监听的控件、cursor:pointer 的行、带 role 的容器仍然列出
    for (const name of ['自绘面板', '订单行 详情', '确认框']) byName(r, name);
  });

  test('同一会话并发 observe：编号不重复，也不抛“编号回退”，各页编号都能用', async () => {
    const a = await openMisc();
    const b = await env.open('/pages/observe-long.html');
    const [ra, rb, ra2] = await Promise.all([
      observe(env.session, { pageId: a }),
      observe(env.session, { pageId: b }),
      observe(env.session, { pageId: a }),
    ]);
    const refsA = new Set(ra.elements.map((e) => e.ref));
    for (const e of rb.elements) assert.ok(!refsA.has(e.ref), `两个标签页的编号重复：${e.ref}`);
    assert.deepEqual(
      ra2.elements.map((e) => e.ref),
      ra.elements.map((e) => e.ref),
      '同一页重复观察得到同一批编号',
    );
    for (const [pageId, r] of [
      [a, ra],
      [b, rb],
    ] as const) {
      const first = r.elements[0] as ObservedElement;
      await (await resolveRef(env.session, pageId, first.ref)).handle.dispose();
    }
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

  test('编号框截图：页面启用 Trusted Types 与严格 style-src 时照常生成，覆盖层不触发 CSP 违规', async () => {
    const pageId = await env.open('/api/strict');
    const page = env.session.pages.get(pageId);
    await page.evaluate(() => {
      const w = window as unknown as { violations: string[] };
      w.violations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        w.violations.push(e.violatedDirective),
      );
    });
    const r = await observe(env.session, { pageId, views: ['text', 'som'] });
    assert.ok(r.som_path && existsSync(r.som_path));
    const seen = await page.evaluate(
      () => (window as unknown as { violations: string[] }).violations,
    );
    assert.deepEqual(seen, []);
  });

  test('截图默认目录是本进程私有的（0700、名字随机）；被换成符号链接后不沿用', async () => {
    const pageId = await openMisc();
    const first = await observe(env.session, { pageId, views: ['screenshot'] });
    const dir = dirname(first.screenshot_path as string);
    assert.notEqual(dir, join(tmpdir(), 'obact-shots'), '不是共享的固定路径');
    assert.match(basename(dir), /^obact-shots-.+/);
    assert.equal(statSync(dir).mode & 0o077, 0, 'group 与 other 没有权限');
    assert.match(basename(first.screenshot_path as string), /-[0-9a-f]{8}\.png$/);
    assert.equal(defaultShotDir(), dir);
    // 目录被换成指向别处的符号链接：不沿用，另建新目录，截图不会落到链接目标里
    const aside = mkdtempSync(join(tmpdir(), 'obact-aside-'));
    let dir2: string | undefined;
    try {
      rmSync(dir, { recursive: true });
      symlinkSync(aside, dir);
      const again = await observe(env.session, { pageId, views: ['screenshot'] });
      dir2 = dirname(again.screenshot_path as string);
      assert.notEqual(dir2, dir);
      assert.deepEqual(readdirSync(aside), []);
    } finally {
      rmSync(aside, { recursive: true, force: true });
      rmSync(dir, { force: true });
      if (dir2) rmSync(dir2, { recursive: true, force: true });
    }
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
    assert.equal(
      r.viewport.scale,
      await page.evaluate(() => devicePixelRatio),
      '截图像素 = CSS 像素 × scale',
    );
  });

  test('参数校验：未知视图', async () => {
    const pageId = await openMisc();
    await rejectsWithCode(
      observe(env.session, { pageId, views: ['dom' as 'text'] }),
      'invalid_params',
    );
  });

  test('页面有未处理的对话框：observe 立即报 dialog_blocking，处理后恢复；主线程无响应时按上限报 timeout', {
    timeout: 30_000,
  }, async () => {
    const pageId = await env.open('/pages/act-main.html');
    const clicked = await act(env.session, { op: 'click', pageId, target: { css: '#alert' } });
    assert.equal(clicked.status, 'ok');
    assert.equal(clicked.effects.dialogs[0]?.handled, 'pending');
    // 对话框期间页面内的求值不会返回：observe 不能等到 CDP 的协议超时（180 秒）
    const t = Date.now();
    await assert.rejects(observe(env.session, { pageId }), (e: ObactError) => {
      assert.equal(e.code, 'dialog_blocking');
      assert.deepEqual(e.details?.dialog, { type: 'alert', message: '提示一下' });
      return true;
    });
    assert.ok(Date.now() - t < 3000, `耗时 ${Date.now() - t}`);
    await act(env.session, { op: 'handle_dialog', pageId, action: 'accept' });
    contracts.assert('observe.Result', await observe(env.session, { pageId }));

    // 没有对话框记录、页面主线程却被占住：到期报 timeout，提示可能被对话框挂起
    const page = env.session.pages.get(pageId);
    const arrived = new Promise<void>((resolve) => {
      onHold = resolve;
    });
    const blocked = page
      .evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/api/hold', false);
        x.send();
      })
      .catch(() => {});
    try {
      await arrived;
      await assert.rejects(
        observe(env.session, { pageId }, { timeoutMs: 500 }),
        (e: ObactError) => {
          assert.equal(e.code, 'timeout');
          assert.match(e.message, /无响应.*handle_dialog.*close_page/);
          return true;
        },
      );
    } finally {
      for (const res of held.splice(0)) res.writeHead(200).end('ok');
      await blocked;
    }
    contracts.assert('observe.Result', await observe(env.session, { pageId }));
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
