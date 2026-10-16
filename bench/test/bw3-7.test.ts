// BW-3 / BW-7 基准脚本的测试：脚本导出 run()，这里调用并断言全部通过。
//
// 覆盖：
//   1. 本地模式：BW-3、BW-7 的全部场景通过（含“脚本里没有固定延时”的自检场景），报告文件与结果表齐全；
//   2. --live 模式的逻辑：容器访问不了公开站点，所以用本文件里按站点公开页面结构复刻的桩页
//      （quotes.toscrape.com、uitestingplayground.com、the-internet.herokuapp.com；延迟缩短，页面结构、选择器、
//      文案、对话框文字与站点一致）跑通脚本逻辑。桩页通过不等于真实站点通过：真实站点没有实测过；
//   3. 站点不可达时如实报告失败原因；--only 过滤；命令行入口；
//   4. 三个内核问题的回归：后台标签页上的点击要先切到前台；封闭 Shadow DOM 里的元素没先 observe 也能按角色定位；
//      iframe 里的 contenteditable 要真正拿到焦点才写入。
//
// 单独运行：node --test bench/test/bw3-7.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act } from '@obact/core';
import { type FixtureEnv, SKIP, setup } from '../../fixtures/test/helpers.ts';
import { type Report as Report3, run as run3 } from '../bw3.ts';
import { type Report as Report7, run as run7 } from '../bw7.ts';

type Report = Report3 | Report7;
const BENCH = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------------------------
// 桩站点：按公开站点的页面结构复刻（延迟缩短）
// ---------------------------------------------------------------------------------------------

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
/** 服务器端延迟后再回复。 */
const later =
  (ms: number, h: Handler): Handler =>
  (req, res, url) =>
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(h(req, res, url)), ms);
    });

// quotes.toscrape.com/js-delayed：名言由脚本延迟渲染（真实站点约 10 秒，这里 900 毫秒）
const QUOTE_AUTHORS = [
  [
    'Albert Einstein',
    'J.K. Rowling',
    'Albert Einstein',
    'Jane Austen',
    'Marilyn Monroe',
    'Albert Einstein',
    'André Gide',
    'Thomas A. Edison',
    'Eleanor Roosevelt',
    'Steve Martin',
  ],
  [
    'Marilyn Monroe',
    'J.K. Rowling',
    'Albert Einstein',
    'Bob Marley',
    'Dr. Seuss',
    'Douglas Adams',
    'Elie Wiesel',
    'Friedrich Nietzsche',
    'Mark Twain',
    'Allen Saunders',
  ],
] as const;

function quotesPage(page: 1 | 2): Handler {
  const data = (QUOTE_AUTHORS[page - 1] ?? []).map((author, i) => ({
    text: `“第 ${page} 页的第 ${i + 1} 条名言。”`,
    author,
  }));
  const pager = `<nav><ul class="pager">${
    page === 2
      ? '<li class="previous"><a href="/js-delayed/page/1/"><span aria-hidden="true">&larr;</span> Previous</a></li>'
      : ''
  }${
    page === 1
      ? '<li class="next"><a href="/js-delayed/page/2/">Next <span aria-hidden="true">&rarr;</span></a></li>'
      : ''
  }</ul></nav>`;
  return html(
    doc(
      'Quotes to Scrape',
      `<div class="container">
  <div class="row header-box"><div class="col-md-8"><h1><a href="/" style="text-decoration: none">Quotes to Scrape</a></h1></div>
  <div class="col-md-4"><p><a href="/login">Login</a></p></div></div>
  <div class="row"><div class="col-md-8" id="quotes"></div></div>
  ${pager}
</div>
<script>
var data = ${JSON.stringify(data)};
setTimeout(function () {
  var c = document.getElementById('quotes');
  data.forEach(function (d) {
    var q = document.createElement('div');
    q.className = 'quote';
    q.innerHTML = '<span class="text">' + d.text + '</span><span>by <small class="author">' + d.author + '</small> <a href="/author/x">(about)</a></span>';
    c.appendChild(q);
  });
}, 900);
</script>`,
    ),
  );
}

async function quotesSite(): Promise<Site> {
  return serve({
    '/': html(doc('Quotes to Scrape', '<h1>Quotes to Scrape</h1>')),
    '/js-delayed/': quotesPage(1),
    '/js-delayed/page/1/': quotesPage(1),
    '/js-delayed/page/2/': quotesPage(2),
  });
}

// uitestingplayground.com：loaddelay、ajax、clientdelay、progressbar
const playground = (title: string, body: string, script = '') =>
  doc(
    'UI Test Automation Playground',
    `<nav class="navbar"><a class="navbar-brand" href="/">UI Test Automation Playground</a></nav>
<div class="container"><section><h3>${title}</h3>${body}</section></div>${script ? `<script>${script}</script>` : ''}`,
  );

async function playgroundSite(): Promise<Site> {
  return serve({
    '/': html(playground('UI Test Automation Playground', '<p>首页</p>')),
    // 页面本身加载慢，之后按钮才出现
    '/loaddelay': later(
      700,
      html(
        playground(
          'Load Delay',
          '<p>Sometimes pages are loading with a delay.</p><div id="content"></div>',
          `setTimeout(function () {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'Button Appearing After Delay';
  document.getElementById('content').appendChild(b);
}, 500);`,
        ),
      ),
    ),
    '/ajax': html(
      playground(
        'AJAX Data',
        '<button type="button" class="btn btn-primary" id="ajaxButton">Button Triggering AJAX Request</button><div id="content"></div>',
        `document.getElementById('ajaxButton').onclick = function () {
  fetch('/ajaxdata').then(function (r) { return r.text(); }).then(function () {
    var p = document.createElement('p'); p.className = 'bg-success'; p.textContent = 'Data loaded with AJAX get request.';
    document.getElementById('content').appendChild(p);
  });
};`,
      ),
    ),
    '/ajaxdata': later(1200, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }),
    '/clientdelay': html(
      playground(
        'Client Side Delay',
        '<button type="button" class="btn btn-primary" id="ajaxButton">Button Triggering Client Side Logic</button><div id="content"></div>',
        `document.getElementById('ajaxButton').onclick = function () {
  setTimeout(function () {
    var p = document.createElement('p'); p.className = 'bg-success'; p.textContent = 'Data calculated on the client side.';
    document.getElementById('content').appendChild(p);
  }, 1200);
};`,
      ),
    ),
    '/progressbar': html(
      playground(
        'Progress Bar',
        `<button type="button" class="btn btn-primary" id="startButton">Start</button>
<button type="button" class="btn btn-primary" id="stopButton">Stop</button>
<div class="progress"><div id="progressBar" class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width: 0%">0%</div></div>
<p id="result">Result:</p>`,
        `var timer = 0;
function show(v) {
  var b = document.getElementById('progressBar');
  b.setAttribute('aria-valuenow', String(v)); b.style.width = v + '%'; b.textContent = v + '%';
}
document.getElementById('startButton').onclick = function () {
  if (timer) return;
  var v = 0;
  timer = setInterval(function () { v += 1; show(v); if (v >= 100) { clearInterval(timer); timer = 0; } }, 30);
};
document.getElementById('stopButton').onclick = function () {
  clearInterval(timer); timer = 0;
  document.getElementById('result').textContent = 'Result: ' + document.getElementById('progressBar').getAttribute('aria-valuenow');
};`,
      ),
    ),
  });
}

// the-internet.herokuapp.com
const internet = (title: string, body: string, script = '') =>
  doc(
    'The Internet',
    `<div id="content" class="large-12 columns"><div class="example">${body}</div></div>${script ? `<script>${script}</script>` : ''}`,
  ).replace('<title>The Internet</title>', `<title>${title}</title>`);

const FRAME_PAGE = (inner: string): string =>
  `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
const frameset = (attrs: string, kids: string) =>
  `<!DOCTYPE html><html><head><title>Frames</title></head><frameset frameborder="1" ${attrs}>${kids}</frameset></html>`;

const DOWNLOADS: Record<string, string> = {
  'some-file.txt': '桩站点下载文件 1\n',
  'test.txt': 'Obact BW-7 download\n',
};

async function internetSite(): Promise<Site> {
  const posted: string[] = [];
  return serve({
    '/': html(internet('The Internet', '<h1>Welcome to the-internet</h1>')),
    '/entry_ad': html(
      internet(
        'The Internet',
        `<h3>Entry Ad</h3>
<p>Displays an ad on page load.</p>
<p>Click <a href="#" id="restart-ad">here</a> to re-enable the pop-up.</p>
<div id="modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10">
  <div class="modal" style="background:#fff;margin:80px auto;width:420px;padding:16px">
    <div class="modal-title"><h3>This is a modal window</h3></div>
    <div class="modal-body"><p>It's commonly used to encourage a user to take an action.</p></div>
    <div class="modal-footer"><p style="cursor:pointer">Close</p></div>
  </div>
</div>`,
        `var modal = document.getElementById('modal');
if (document.cookie.indexOf('modal_viewed=1') < 0) setTimeout(function () { modal.style.display = 'block'; }, 400);
document.querySelector('.modal-footer p').onclick = function () {
  modal.style.display = 'none'; document.cookie = 'modal_viewed=1; path=/';
};
document.getElementById('restart-ad').onclick = function (e) {
  e.preventDefault();
  document.cookie = 'modal_viewed=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  modal.style.display = 'block';
};`,
      ),
    ),
    '/javascript_alerts': html(
      internet(
        'The Internet',
        `<h3>JavaScript Alerts</h3>
<p>Here are some examples of different JavaScript alerts which can be troublesome for automation</p>
<ul>
  <li><button onclick="jsAlert()">Click for JS Alert</button></li>
  <li><button onclick="jsConfirm()">Click for JS Confirm</button></li>
  <li><button onclick="jsPrompt()">Click for JS Prompt</button></li>
</ul>
<h4>Result:</h4>
<p id="result"></p>`,
        `function jsAlert() { alert('I am a JS Alert'); document.getElementById('result').textContent = 'You successfully clicked an alert'; }
function jsConfirm() { var r = confirm('I am a JS Confirm'); document.getElementById('result').textContent = 'You clicked: ' + (r ? 'Ok' : 'Cancel'); }
function jsPrompt() { var r = prompt('I am a JS prompt'); document.getElementById('result').textContent = 'You entered: ' + r; }`,
      ),
    ),
    '/frames': html(
      internet(
        'The Internet',
        '<h3>Frames</h3><ul><li><a href="/nested_frames">Nested Frames</a></li><li><a href="/iframe">iFrame</a></li></ul>',
      ),
    ),
    '/nested_frames': html(
      frameset(
        'rows="50%,50%"',
        '<frame src="/frame_top" name="frame-top"><frame src="/frame_bottom" name="frame-bottom">',
      ),
    ),
    '/frame_top': html(
      frameset(
        'cols="33%,33%,33%"',
        '<frame src="/frame_left" name="frame-left"><frame src="/frame_middle" name="frame-middle"><frame src="/frame_right" name="frame-right">',
      ),
    ),
    '/frame_left': html(FRAME_PAGE('LEFT')),
    '/frame_middle': html(FRAME_PAGE('<div id="content">MIDDLE</div>')),
    '/frame_right': html(FRAME_PAGE('RIGHT')),
    '/frame_bottom': html(FRAME_PAGE('BOTTOM')),
    '/iframe': html(
      internet(
        'The Internet',
        `<h3>An iFrame containing the TinyMCE WYSIWYG Editor</h3>
<div class="tox tox-tinymce" style="width:100%;height:260px"><iframe id="mce_0_ifr" title="Rich Text Area" style="width:100%;height:240px;border:0"
  srcdoc="&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body id=&quot;tinymce&quot; class=&quot;mce-content-body&quot; contenteditable=&quot;true&quot; data-id=&quot;mce_0&quot;&gt;&lt;p&gt;Your content goes here.&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;"></iframe></div>`,
      ),
    ),
    '/shadowdom': html(
      internet(
        'The Internet',
        `<h1>Simple template</h1>
<my-paragraph><span slot="my-text">Let's have some different text!</span></my-paragraph>
<my-paragraph><ul slot="my-text"><li>Let's have some different text!</li><li>In a list!</li></ul></my-paragraph>
<template id="my-paragraph"><style>p { color: white; background-color: #666; padding: 5px; }</style><p><slot name="my-text">My default text</slot></p></template>`,
        `customElements.define('my-paragraph', class extends HTMLElement {
  constructor() {
    super();
    var t = document.getElementById('my-paragraph').content;
    this.attachShadow({ mode: 'open' }).appendChild(t.cloneNode(true));
  }
});`,
      ),
    ),
    '/upload': (req, res) => {
      if (req.method !== 'POST') {
        html(
          internet(
            'The Internet',
            `<h3>File Uploader</h3>
<p>Choose a file on your system and then click upload. Or, drag and drop a file into the area below.</p>
<form id="file-upload-form" method="POST" action="/upload" enctype="multipart/form-data">
  <input id="file-upload" type="file" name="file">
  <input id="file-submit" class="button" type="submit" value="Upload">
  <div id="drag-drop-upload" class="dz-clickable">Drag and Drop Files Here</div>
</form>`,
          ),
        )(req, res, new URL('http://stub/upload'));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const name = /filename="([^"]*)"/.exec(Buffer.concat(chunks).toString('latin1'))?.[1] ?? '';
        posted.push(name);
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            internet(
              'The Internet',
              `<h3>File Uploaded!</h3>\n<div id="uploaded-files">\n    ${name}\n  </div>`,
            ),
          );
      });
    },
    '/download': html(
      internet(
        'The Internet',
        `<h3>File Downloader</h3>\n${Object.keys(DOWNLOADS)
          .map((n) => `<a href="download/${n}">${n}</a>`)
          .join('\n')}`,
      ),
    ),
    ...Object.fromEntries(
      Object.entries(DOWNLOADS).map(([name, body]) => [
        `/download/${name}`,
        ((_req, res) => {
          res
            .writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename="${name}"`,
            })
            .end(body);
        }) as Handler,
      ]),
    ),
    '/windows': html(
      internet(
        'The Internet',
        '<h3>Opening a new window</h3><a href="/windows/new" target="_blank">Click Here</a>',
      ),
    ),
    '/windows/new': html(internet('New Window', '<h3>New Window</h3>')),
  });
}

// ---------------------------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------------------------

/** 报告完整：全部通过、有逐项结果表、报告文件已写出且与返回值一致。 */
function assertReport(report: Report, expect: { mode: 'local' | 'live'; ids: string[] }): void {
  const failed = report.rows.filter((r) => !r.ok).map((r) => `${r.id}：${r.error}`);
  assert.deepEqual(failed, [], `有场景失败：\n${failed.join('\n')}`);
  assert.equal(report.pass, true);
  assert.equal(report.mode, expect.mode);
  assert.deepEqual(
    report.rows.map((r) => r.id),
    expect.ids,
  );
  // 结果表：表头 + 每个场景一行，带步骤数、结果、耗时
  assert.match(report.markdown, /\| 编号 \| 场景 \| 步骤数 \| 结果 \| 耗时 \| 失败原因 \|/);
  for (const r of report.rows) {
    assert.ok(report.markdown.includes(`| ${r.id} |`), `结果表里没有 ${r.id} 这一行`);
    if (r.id !== 'S0') assert.ok(r.steps > 0, `${r.id} 的步骤数应大于 0`);
  }
  assert.ok(report.markdown.includes(`结果：${report.rows.length}/${report.rows.length} 通过`));
  assert.equal(readFileSync(report.files.md, 'utf8'), report.markdown);
  const json = JSON.parse(readFileSync(report.files.json, 'utf8')) as Report;
  assert.equal(json.pass, true);
  assert.equal(json.rows.length, report.rows.length);
}

/** 检查项里没有“固定延时”：S0 场景通过，并且确实扫描了脚本。 */
function assertNoFixedDelay(report: Report): void {
  const s0 = report.rows.find((r) => r.id === 'S0');
  assert.ok(s0?.ok, `S0：${s0?.error}`);
  assert.match(s0.notes.join(' '), /扫描 \d+ 行/);
}

const LOCAL_3 = ['S0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const LOCAL_7 = ['S0', ...Array.from({ length: 13 }, (_, i) => `L${i + 1}`)];
const LIVE_3 = ['S0', 'V1', 'V2', 'V3', 'V4', 'V5'];
const LIVE_7 = ['S0', ...Array.from({ length: 8 }, (_, i) => `V${i + 1}`)];

// ---------------------------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------------------------

describe('BW-3 / BW-7 基准脚本', { skip: SKIP }, () => {
  let out: string;
  const sites: Site[] = [];
  before(() => {
    out = mkdtempSync(join(tmpdir(), 'obact-bench-test-'));
  });
  after(async () => {
    await Promise.all(sites.map((s) => s.close()));
    rmSync(out, { recursive: true, force: true });
  });
  const start = async (make: () => Promise<Site>): Promise<Site> => {
    const s = await make();
    sites.push(s);
    return s;
  };

  test('BW-3 本地：timing、fast-response、polling 夹具与 Lab 订单列表（注入延迟）全部通过', async () => {
    const report = await run3({ outDir: join(out, 'bw3-local') });
    assertReport(report, { mode: 'local', ids: LOCAL_3 });
    assertNoFixedDelay(report);
    // 每个场景都至少有一条实测耗时说明（等待确实发生过，不是空跑）
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
      assert.ok(report.rows.find((r) => r.id === id)?.notes.length, `${id} 没有耗时说明`);
    }
  });

  test('BW-7 本地：弹窗、对话框、frame、Shadow DOM、上传下载、新标签页全部通过', async () => {
    const report = await run7({ outDir: join(out, 'bw7-local') });
    assertReport(report, { mode: 'local', ids: LOCAL_7 });
    assertNoFixedDelay(report);
  });

  test('BW-3 --live（桩站点，未对真实站点实测）：quotes /js-delayed 与 playground 四个页面', async () => {
    const quotes = await start(quotesSite);
    const pg = await start(playgroundSite);
    const report = await run3({
      live: true,
      sites: { quotes: quotes.base, playground: pg.base },
      outDir: join(out, 'bw3-live'),
    });
    assertReport(report, { mode: 'live', ids: LIVE_3 });
    assertNoFixedDelay(report);
    assert.match(report.markdown, /公开站点/);
    // 延迟确实被等到：quotes 名言延迟约 0.9 秒，AJAX 与客户端延迟各约 1.2 秒
    const ms = (id: string) => report.rows.find((r) => r.id === id)?.notes.join(' ') ?? '';
    assert.match(ms('V1'), /等到名言出现：\d+ 毫秒/);
    assert.match(ms('V3'), /点击到数据出现：\d+ 毫秒/);
  });

  test('BW-7 --live（桩站点，未对真实站点实测）：the-internet 的 entry_ad、alerts、frames、shadowdom、upload、download、windows', async () => {
    const site = await start(internetSite);
    const ids = LIVE_7;
    const report = await run7({
      live: true,
      sites: { internet: site.base },
      only: ids,
      outDir: join(out, 'bw7-live'),
    });
    assertReport(report, { mode: 'live', ids });
    assertNoFixedDelay(report);
  });

  test('--live 站点不可达：如实报告失败与原因，不挂起，不记为通过', async () => {
    // 先占一个端口再关掉，得到一个没人监听的地址
    const dead = await serve({});
    await dead.close();
    const r3 = await run3({
      live: true,
      only: ['V2'],
      sites: { playground: dead.base },
      outDir: join(out, 'bw3-dead'),
    });
    assert.equal(r3.pass, false);
    assert.equal(r3.rows.length, 1);
    assert.equal(r3.rows[0]?.ok, false);
    assert.match(r3.rows[0]?.error ?? '', /站点不可达.*127\.0\.0\.1/);
    assert.equal(r3.rows[0]?.steps, 0);
    assert.match(r3.markdown, /\| V2 \|.*\| 失败 \|.*站点不可达/);

    const r7 = await run7({
      live: true,
      only: ['V2', 'V8'],
      sites: { internet: dead.base },
      outDir: join(out, 'bw7-dead'),
    });
    assert.equal(r7.pass, false);
    assert.deepEqual(
      r7.rows.map((r) => [r.id, r.ok]),
      [
        ['V2', false],
        ['V8', false],
      ],
    );
  });

  test('--only 只跑指定场景，其余不跑；场景全被过滤掉时不算通过', async () => {
    const some = await run3({ only: ['S0', 'L1'], outDir: join(out, 'only') });
    assert.deepEqual(
      some.rows.map((r) => r.id),
      ['S0', 'L1'],
    );
    assert.equal(some.pass, true);
    const none = await run3({ only: ['不存在'], outDir: join(out, 'only-none') });
    assert.deepEqual(none.rows, []);
    assert.equal(none.pass, false);
  });

  test('命令行入口：打印结果表、写报告到 --out 目录、全部通过时退出码为 0', async () => {
    const dir = join(out, 'cli');
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const p = spawn(process.execPath, [join(BENCH, 'bw7.ts'), '--only', 'S0,L4', '--out', dir], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      p.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /\| L4 \|.*\| 通过 \|/);
    assert.ok(existsSync(join(dir, 'bw7-local.md')));
    assert.ok(existsSync(join(dir, 'bw7-local.json')));
  });
});

// ---------------------------------------------------------------------------------------------
// 内核问题的回归：写基准脚本时发现，已修复
// ---------------------------------------------------------------------------------------------

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
    const site = await internetSite();
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
