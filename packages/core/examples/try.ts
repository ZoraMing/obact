/**
 * 交互试用 observe / act（服务与统一接口在 M4 提供，这里直接调用库）。
 *
 *   CHROME_PATH=$(node tools/browser.ts path) node packages/core/examples/try.ts https://example.com
 *
 * 先运行 npm run browser:install；本脚本只认 CHROME_PATH，不会自己找 tools/browser.ts 装的浏览器。
 *
 * 启动后打印页面的可操作功能（snapshot_text）和纯网页信息（text_md），然后逐行读入命令：
 *
 *   {"op":"click","target":{"ref":3}}          一行 JSON 即一个动作（action.json），pageId 可省略
 *   {"op":"fill","target":{"role":"textbox","name":"账号"},"value":"alice"}
 *   o                                          重新观察
 *   q                                          退出
 *
 * 动作执行后打印结果并自动重新观察。HEADED=1 时有头运行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Action } from '@obact/schemas';
import { act, launchBrowser, observe, Session } from '../src/index.ts';

const url = process.argv[2];
if (!url) {
  console.error('用法：node packages/core/examples/try.ts <网址>');
  process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), 'obact-try-'));
const browser = await launchBrowser({
  profileDir,
  mode: process.env.HEADED === '1' ? 'headed' : 'headless',
});
const session = await Session.attach(browser);
const pageId = await session.pages.newPage();
await session.pages.get(pageId).goto(url, { waitUntil: 'load' });

async function show(): Promise<void> {
  const r = await observe(session, { pageId });
  console.log(`\n== ${r.title}  ${r.url}${r.truncated ? '（已截断）' : ''}`);
  console.log('\n-- 可操作功能（元素编号、角色、名称、可用操作）--');
  console.log(r.snapshot_text);
  console.log('\n-- 纯网页信息 --');
  console.log(r.text_md);
}

async function tryShow(): Promise<void> {
  try {
    await show();
  } catch (e) {
    console.log(`\n（观察失败：${(e as Error).message}）`);
  }
}

await show();
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n动作> ' });
try {
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === 'q') break;
    if (line === 'o') await tryShow();
    else if (line) {
      let action: Action | null = null;
      try {
        action = { pageId, ...JSON.parse(line) };
      } catch {
        console.log('需要一行 JSON，例如 {"op":"click","target":{"ref":3}}');
      }
      if (action) {
        const r = await act(session, action);
        console.log(JSON.stringify(r, null, 2));
        if (r.status === 'ok') await tryShow();
      }
    }
    rl.prompt();
  }
} finally {
  rl.close();
  await session.close({ closeBrowser: true });
  rmSync(profileDir, { recursive: true, force: true });
}
