// Lab 测试助手：Lab 服务 + 无头浏览器 + 会话，以及三个控制接口的封装。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, Session } from '@obact/core';
import type { Browser } from 'puppeteer-core';
import { createLab, type Lab } from '../src/app.ts';
import type { Faults } from '../src/core.ts';

const CONTAINER_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const CHROME =
  process.env.CHROME_PATH ?? (existsSync(CONTAINER_CHROME) ? CONTAINER_CHROME : undefined);
/** 传给 describe 的 skip 选项：没有浏览器时跳过并说明原因。 */
export const SKIP: false | string = CHROME ? false : '未找到浏览器：请设置 CHROME_PATH';

export type LabState = {
  space: string;
  faults: Faults;
  sessions: { user: string; created: string }[];
  submissions: { key: string; op: string; count: number; payload: unknown }[];
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
  close(): Promise<void>;
};

export async function setup(): Promise<LabEnv> {
  const lab = await createLab();
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-lab-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath: CHROME,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
  });
  const session = await Session.attach(browser);
  return {
    lab,
    browser,
    session,
    async open(space, path, opts = {}) {
      const pageId = await session.pages.newPage();
      await session.pages
        .get(pageId)
        .goto(lab.url(space, opts.cross) + path, { waitUntil: 'load' });
      return pageId;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await lab.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}
