// Lab 测试助手：Lab 服务 + 无头浏览器 + 会话，以及三个控制接口的封装。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActOptions, act, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { skipIfNoBrowser, testChrome } from '../../tools/browser.ts';
import { createLab, type Lab } from '../src/app.ts';
import type { Faults, LabModule } from '../src/core.ts';

export const CHROME = await testChrome();
/** 传给 describe 的 skip 选项：没有浏览器时跳过并说明原因（OBACT_REQUIRE_BROWSER=1 时直接失败）。 */
export const SKIP: false | string = skipIfNoBrowser(CHROME);

const contracts = new Contracts();

export type LabState = {
  space: string;
  seed: number;
  options: Record<string, number>;
  faults: Faults;
  sessions: { user: string; created: string }[];
  submissions: { key: string; op: string; count: number; payload: unknown; conflict?: boolean }[];
  log: { type: string; detail?: unknown }[];
  modules: Record<string, unknown>;
};

/** 控制接口：不经过浏览器。 */
export function control(lab: Lab, space: string) {
  const u = (p: string) => `${lab.url(space)}/_lab/${p}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(u(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  };
  return {
    reset: (seed?: number) => post('reset', seed === undefined ? {} : { seed }),
    faults: (f: Partial<Faults>) => post('faults', f) as Promise<Faults>,
    state: async () => (await (await fetch(u('state'))).json()) as LabState,
  };
}

export type LabEnv = {
  lab: Lab;
  browser: Browser;
  session: Session;
  /** 新建标签页打开某空间下的路径（如 /orders），返回 pageId。 */
  open(space: string, path: string, opts?: { cross?: boolean }): Promise<string>;
  /** 关掉 open 打开的全部标签页（放在 afterEach 里，免得上一个用例的页面干扰下一个）。 */
  closePages(): Promise<void>;
  /** 执行动作并校验返回值符合契约。 */
  run(a: Action, opts?: ActOptions): Promise<ActResult>;
  /** 执行动作，要求成功。 */
  ok(a: Action, opts?: ActOptions): Promise<ActResult>;
  /** observe 并校验返回值符合契约。 */
  look(pageId: string, opts?: Parameters<typeof observe>[2]): Promise<ObserveResult>;
  close(): Promise<void>;
};

/** 起 Lab（默认加载全部模块；测试可只装配需要的）和一个无头浏览器会话。 */
export async function setup(opts: { modules?: LabModule[] } = {}): Promise<LabEnv> {
  const lab = await createLab({ modules: opts.modules });
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-lab-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath: CHROME,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
  });
  const session = await Session.attach(browser);
  const run: LabEnv['run'] = async (a, o) => {
    const r = await act(session, a, o);
    contracts.assert('act-result', r);
    return r;
  };
  const opened: string[] = [];
  return {
    lab,
    browser,
    session,
    async open(space, path, o = {}) {
      const pageId = await session.pages.newPage();
      opened.push(pageId);
      await session.pages.get(pageId).goto(lab.url(space, o.cross) + path, { waitUntil: 'load' });
      return pageId;
    },
    async closePages() {
      for (const pageId of opened.splice(0))
        await run({ op: 'close_page', pageId }).catch(() => {});
    },
    run,
    async ok(a, o) {
      const r = await run(a, o);
      assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
      return r;
    },
    async look(pageId, o) {
      const r = await observe(session, { pageId }, o);
      contracts.assert('observe.Result', r);
      return r;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await lab.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
