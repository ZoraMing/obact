// 夹具测试助手：夹具服务 + 无头浏览器 + 会话。每个测试文件 setup 一次。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ActOptions, act, launchBrowser, Session } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { skipIfNoBrowser, testChrome } from '../../tools/browser.ts';
import { type FixtureServer, startFixtures } from '../server.ts';

export const CHROME = await testChrome();
/** 传给 describe 的 skip 选项：没有浏览器时跳过并说明原因（OBACT_REQUIRE_BROWSER=1 时直接失败）。 */
export const SKIP: false | string = skipIfNoBrowser(CHROME);

export type FixtureEnv = {
  server: FixtureServer;
  browser: Browser;
  session: Session;
  /** 新建标签页并打开夹具路径（如 /timing/），返回 pageId。 */
  open(path: string, opts?: { cross?: boolean }): Promise<string>;
  close(): Promise<void>;
};

export async function setup(): Promise<FixtureEnv> {
  const server = await startFixtures();
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-fixture-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath: CHROME,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
    // 浏览器进程的 TMPDIR 含 .. 片段（如 /x/a/../b）时，Chrome 会取消所有下载；先规范化
    env: { TMPDIR: resolve(tmpdir()) },
  });
  const session = await Session.attach(browser);
  return {
    server,
    browser,
    session,
    async open(path, opts = {}) {
      const pageId = await session.pages.newPage();
      await session.pages
        .get(pageId)
        .goto((opts.cross ? server.crossBase : server.base) + path, { waitUntil: 'load' });
      return pageId;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await server.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

let contracts: Contracts | undefined;

/** 执行动作，并校验返回值符合 act-result 契约。 */
export async function run(env: FixtureEnv, a: Action, opts?: ActOptions): Promise<ActResult> {
  const r = await act(env.session, a, opts);
  (contracts ??= new Contracts()).assert('act-result', r);
  return r;
}

/** 同 run，但要求 status 为 ok。 */
export async function ok(env: FixtureEnv, a: Action, opts?: ActOptions): Promise<ActResult> {
  const r = await run(env, a, opts);
  assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
  return r;
}
