// 预研：固定版本 Chromium 下加载 MV3 扩展的几种方式，以及侧边栏页面连接本机服务、扩展建标签组。
// 用法：node spikes/extension/load.ts            （无头）
//       HEADED=1 xvfb-run -a node spikes/extension/load.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer-core';
import { CHROME_PATH, EXTRA_ARGS, HEADLESS, log } from '../lib/chrome.ts';
import { serveWs } from '../lib/mini-ws.ts';

const EXT = join(dirname(fileURLToPath(import.meta.url)), 'ext');
const WS_PORT = 47210;

// Puppeteer 的 enableExtensions 安装失败时会产生未处理的 Promise 拒绝，这里记录下来而不让进程退出
process.on('unhandledRejection', (e) => log('unhandledRejection', (e as Error).message));

const received: { origin: string | undefined; text: string }[] = [];
const loaded = new Map<string, boolean>();
const wsServer = await serveWs(WS_PORT, (m) => {
  received.push({ origin: m.origin, text: m.text });
  m.reply(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { run_id: 'run_42', state: 'RUNNING' } }),
  );
});

async function extensionWorker(browser: Browser) {
  const target = await browser
    .waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 5000 },
    )
    .catch(() => null);
  return target;
}

async function tryMethod(name: string, options: LaunchOptions, install?: boolean) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'obact-ext-'));
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: HEADLESS,
      userDataDir,
      timeout: 15000,
      protocolTimeout: 15000,
      ...options,
      args: [...EXTRA_ARGS, ...(options.args ?? [])],
    });
    log(name, '已启动');
    let installedId: string | undefined;
    if (install) installedId = await browser.installExtension(EXT);
    const sw = await extensionWorker(browser);
    loaded.set(name, Boolean(sw));
    if (!sw) return log(name, { loaded: false, installedId });
    const id = new URL(sw.url()).host;
    log(name, `扩展已加载 ${id}`);

    // 侧边栏页面（这里在标签页中打开同一页面）连接服务
    received.length = 0;
    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${id}/sidepanel.html#port=${WS_PORT}`);
    await panel
      .waitForFunction(() => document.title !== 'Obact 侧边栏', { timeout: 5000 })
      .catch(() => {});
    const title = await panel.title();
    log(name, `侧边栏页面：${title}`);

    // 扩展把两个标签页编成标签组。注意：Puppeteer 的 target.worker().evaluate 对扩展 SW 会挂起，
    // 改用对 SW target 直接开 CDP 会话执行 Runtime.evaluate。
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.goto('data:text/html,<title>a</title>');
    await b.goto('data:text/html,<title>b</title>');
    const swSession = await sw.createCDPSession();
    const evalSw = async (expression: string) => {
      const r = (await swSession.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result: { value: unknown }; exceptionDetails?: { text: string } };
      return r.exceptionDetails ? `error: ${r.exceptionDetails.text}` : r.result.value;
    };
    const tabIds = await evalSw(
      "chrome.tabs.query({}).then((ts) => ts.filter((t) => t.title === 'a' || t.title === 'b').map((t) => t.id))",
    );
    const groupId = await evalSw(`obactGroup(${JSON.stringify(tabIds)}, 'acct1·只读')`);
    const group = await evalSw(`chrome.tabGroups.get(${JSON.stringify(groupId)})`);

    // 外部进程能否通过 DevToolsActivePort 连上同一个浏览器
    let wsReachable: string | boolean = false;
    try {
      const [p, path] = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n');
      const other = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${p}${path}` });
      wsReachable = (await other.pages()).length > 0;
      await other.disconnect();
    } catch (e) {
      wsReachable = `否：${(e as Error).message.slice(0, 80)}`;
    }

    log(name, {
      loaded: true,
      id,
      installedId,
      panelTitle: title,
      wsOrigin: received[0]?.origin,
      wsMessage: received[0]?.text,
      tabIds,
      group,
      wsReachable,
    });
  } catch (e) {
    log(name, { loaded: false, error: (e as Error).message.split('\n')[0] });
  } finally {
    await browser?.close();
  }
}

log('mode', { headless: HEADLESS, chrome: CHROME_PATH });

// A：命令行 --load-extension（Chrome 137 起品牌版 Chrome 移除，Chromium / Chrome for Testing 待验证）
await tryMethod('A --load-extension', {
  enableExtensions: true,
  args: [
    '--remote-debugging-port=0',
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
  ],
});

// B：Puppeteer enableExtensions（内部走 CDP Extensions.loadUnpacked），WebSocket 连接
await tryMethod('B enableExtensions + ws', { enableExtensions: [EXT] });

// C：同 B，但用 pipe 连接，并额外开调试端口供任务子进程连接
await tryMethod('C enableExtensions + pipe', {
  pipe: true,
  enableExtensions: [EXT],
  args: ['--remote-debugging-port=0'],
});

// D：pipe 启动后再 installExtension，并加 --enable-unsafe-extension-debugging
await tryMethod(
  'D pipe + installExtension + unsafe flag',
  {
    pipe: true,
    enableExtensions: true,
    args: ['--remote-debugging-port=0', '--enable-unsafe-extension-debugging'],
  },
  true,
);

// E：只用 pipe（不开调试端口）+ unsafe 标志，再 installExtension
await tryMethod(
  'E pipe only + installExtension + unsafe flag',
  { pipe: true, enableExtensions: true, args: ['--enable-unsafe-extension-debugging'] },
  true,
);

wsServer.close();

// ASSERT=1（CI）：方式 A 是选定方案，加载失败则退出码为 1
if (process.env.ASSERT === '1' && !loaded.get('A --load-extension')) {
  console.error('方式 A（--load-extension）在此浏览器上不可用');
  process.exit(1);
}
