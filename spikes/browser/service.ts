// 预研：服务进程管理浏览器，任务在子进程里连接（PRD 8.1、FR-03）。
// 用法：node spikes/browser/service.ts        （无头）
//       HEADED=1 xvfb-run -a node spikes/browser/service.ts   （有头，Linux 无显示器）
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';
import { CHROME_PATH, EXTRA_ARGS, HEADLESS, log } from '../lib/chrome.ts';
import { serveDir } from '../lib/static-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const profile = join(here, '..', 'out', 'profiles', 'acct1');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const { server, port } = await serveDir(join(here, '..', 'fixtures'));
const base = `http://127.0.0.1:${port}`;

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    userDataDir: profile,
    defaultViewport: null,
    args: EXTRA_ARGS,
  });
}

/** 启动任务子进程，逐行收集它输出的 JSON。 */
function runTask(
  ws: string,
  cmd: string,
  onLine?: (o: Record<string, unknown>, p: ChildProcess) => void,
) {
  const child = spawn(process.execPath, [join(here, 'task.ts'), ws, cmd, base, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      const o = JSON.parse(line) as Record<string, unknown>;
      log(cmd, o);
      onLine?.(o, child);
    }
  });
  return new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
}

log('mode', { headless: HEADLESS, chrome: CHROME_PATH });
let browser = await launch();
log('browser', { version: await browser.version(), ws: browser.wsEndpoint() });

await runTask(browser.wsEndpoint(), 'refs');
await runTask(browser.wsEndpoint(), 'big');

// 任务进程崩溃：浏览器和页面不受影响，新的任务进程能接管
const code = await runTask(browser.wsEndpoint(), 'hold', (o, p) => {
  if (o.ready) p.kill('SIGKILL');
});
log('crash', {
  exitCode: code,
  browserConnected: browser.connected,
  pages: (await browser.pages()).length,
});
await runTask(browser.wsEndpoint(), 'reattach');

// 浏览器重启：同一配置目录保留登录态
await browser.close();
browser = await launch();
await runTask(browser.wsEndpoint(), 'cookie');
await browser.close();
server.close();
