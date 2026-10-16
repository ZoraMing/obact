// BW-3 / BW-7 基准脚本的测试：本地模式全部场景通过，外加三个内核问题的回归。
//
// 单独运行：node --test bench/test/bw3-7.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { act } from '@obact/core';
import { type FixtureEnv, SKIP, setup } from '../../fixtures/test/helpers.ts';
import { run as run3 } from '../bw3.ts';
import { run as run7 } from '../bw7.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
type Site = { base: string; close(): Promise<void> };

async function serve(routes: Record<string, Handler>): Promise<Site> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const h = routes[url.pathname] ?? routes[`${url.pathname.replace(/\/$/, '')}/`];
    if (!h) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    Promise.resolve(h(req, res, url)).catch((e) => {
      res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const html = (body: string, status = 200): Handler => {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  };
};
const doc = (title: string, body: string, head = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** 只复刻 the-internet 的 /iframe（TinyMCE 的 contenteditable iframe），给 iframe 回归用。 */
async function iframeSite(): Promise<Site> {
  return serve({
    '/': html(doc('The Internet', '<h1>Welcome to the-internet</h1>')),
    '/iframe': html(
      doc(
        'The Internet',
        `<div id="content" class="large-12 columns"><div class="example"><h3>An iFrame containing the TinyMCE WYSIWYG Editor</h3>
<div class="tox tox-tinymce" style="width:100%;height:260px"><iframe id="mce_0_ifr" title="Rich Text Area" style="width:100%;height:240px;border:0"
  srcdoc="&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body id=&quot;tinymce&quot; class=&quot;mce-content-body&quot; contenteditable=&quot;true&quot; data-id=&quot;mce_0&quot;&gt;&lt;p&gt;Your content goes here.&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;"></iframe></div></div></div>`,
      ),
    ),
  });
}

describe('BW-3 / BW-7 基准脚本（本地模式）', { skip: SKIP }, () => {
  let out: string;
  before(() => {
    out = mkdtempSync(join(tmpdir(), 'obact-bench-test-'));
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('BW-3 本地：全部场景通过', async () => {
    const report = await run3({ outDir: join(out, 'bw3-local') });
    const failed = report.rows.filter((r) => !r.ok).map((r) => `${r.id}：${r.error}`);
    assert.deepEqual(failed, []);
    assert.equal(report.pass, true);
  });

  test('BW-7 本地：全部场景通过', async () => {
    const report = await run7({ outDir: join(out, 'bw7-local') });
    const failed = report.rows.filter((r) => !r.ok).map((r) => `${r.id}：${r.error}`);
    assert.deepEqual(failed, []);
    assert.equal(report.pass, true);
  });
});

describe('内核问题（基准脚本发现）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('对后台标签页的点击与悬停不应多等约 5 秒（FR-04：所有动作都带 pageId，不必先 select_page）', async () => {
    const p = await env.open('/structure/');
    // 再开一个标签页并切到前台，p 成了后台标签页
    const q = await act(env.session, { op: 'new_page', url: `${env.server.base}/timing/` });
    assert.equal(q.status, 'ok');
    const click = await act(env.session, {
      op: 'click',
      pageId: p,
      target: { role: 'button', name: '关注' },
    });
    assert.equal(click.status, 'ok');
    assert.ok(
      click.duration_ms < 2500,
      `后台标签页点击耗时 ${click.duration_ms} 毫秒，应小于 2500`,
    );
    const hover = await act(env.session, {
      op: 'hover',
      pageId: p,
      target: { role: 'button', name: '收藏' },
    });
    assert.equal(hover.status, 'ok');
    assert.ok(
      hover.duration_ms < 2500,
      `后台标签页悬停耗时 ${hover.duration_ms} 毫秒，应小于 2500`,
    );
  });

  test('封闭 Shadow DOM 里的元素，没先 observe 也应能按 {role, name} 定位（回放已存规则时页面不一定观察过）', async () => {
    const p = await env.open('/structure/');
    const r = await act(env.session, {
      op: 'fill',
      pageId: p,
      target: { role: 'textbox', name: '金额' },
      value: '88',
      timeout_ms: 3000,
    });
    assert.equal(r.status, 'ok', `${r.error?.code} ${r.error?.message}`);
    const pay = await act(env.session, {
      op: 'click',
      pageId: p,
      target: { role: 'button', name: '支付' },
      post: [{ text_present: '已支付 88 元' }],
      timeout_ms: 3000,
    });
    assert.equal(pay.status, 'ok', `${pay.error?.code} ${pay.error?.message}`);
  });

  test('iframe 里的 contenteditable（富文本编辑器）fill 应当真正写入内容，BW-7 /iframe', async () => {
    const site = await iframeSite();
    const dir = mkdtempSync(join(tmpdir(), 'obact-bench-iframe-'));
    try {
      const report = await run7({
        live: true,
        sites: { internet: site.base },
        only: ['V4'],
        outDir: dir,
      });
      const row = report.rows[0];
      assert.ok(row?.ok, row?.error);
    } finally {
      await site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
