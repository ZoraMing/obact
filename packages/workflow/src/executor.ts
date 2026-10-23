// Executor 的真实实现：基于 @obact/core 的 act、断言、接口缓存与标签页登记（DESIGN 约定 12、15、16）。
// 约定与 test/fake-executor.ts 一致：act 不抛异常，失败以 status:'error' 返回；extract、check 失败抛 ObactError。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  act,
  assertAccountName,
  checkAssertions,
  currentActionSeq,
  type LaunchOptions,
  launchBrowser,
  NetworkCache,
  ObactError,
  Session,
} from '@obact/core';
import { extractFromPage, extractFromResponse } from './extract.ts';
import { RunStore } from './store.ts';
import type { Action, ActResult, Executor, ExtractResult, Step, Workflow } from './types.ts';

/** 失败现场截图的时间上限：页面被对话框占住时截图不会返回。 */
const SHOT_TIMEOUT_MS = 3000;

export type CoreExecutorOptions = {
  session: Session;
  /** 任务起点的标签页（别名 main）。 */
  main: string;
  workspace: string;
  runId: string;
  /** 工作流元信息：采集输出的主键（滚动去重用）。 */
  meta?: Workflow['meta'];
  /** 接口缓存；工作流没有声明 intercept 时为空，接口读取报 invalid_params。 */
  cache?: NetworkCache;
  /** close() 时同时关闭浏览器（浏览器由 openSession 启动时为 true；调用方自己管理时不关）。 */
  closeBrowser?: boolean;
};

export class CoreExecutor implements Executor {
  readonly session: Session;
  readonly #o: CoreExecutorOptions;
  readonly #store: RunStore;
  /** 接口读取的起点：最近一个会触发请求的动作的序号（wait_for、assert 只看不动，不算）。 */
  #mark = 0;

  constructor(o: CoreExecutorOptions) {
    this.session = o.session;
    this.#o = o;
    this.#store = new RunStore(o.workspace, o.runId);
  }

  async act(action: Action): Promise<ActResult> {
    const res = await act(this.session, action, { filesRoot: this.#o.workspace });
    if (action.op !== 'wait_for' && action.op !== 'assert') this.#mark = this.actionSeq();
    // 接口缓存给新标签页建监听是异步的（M2 的变通：等就绪再往下走，页面最初几毫秒的请求仍可能漏掉）
    if (res.effects.new_pages.length > 0) await this.#o.cache?.ready();
    return res;
  }

  async extract(step: Extract<Step, { op: 'extract' }>): Promise<ExtractResult> {
    const pageId = String(step.pageId ?? this.#o.main);
    const { source } = step;
    if (source.type === 'response') {
      if (!this.#o.cache) {
        throw new ObactError(
          'invalid_params',
          '接口读取需要在 workflow.json 的 intercept 里声明 URL 正则',
        );
      }
      return extractFromResponse(this.#o.cache, pageId, source, this.#mark, step.wait_ms);
    }
    const key = step.key ?? (step.into ? this.#o.meta?.outputs?.[step.into]?.key : undefined);
    return extractFromPage(this.session, pageId, source, {
      ...(key ? { key } : {}),
      ...(step.wait_ms !== undefined ? { waitMs: step.wait_ms } : {}),
    });
  }

  async check(
    pageId: string,
    checks: NonNullable<Action['post']>,
  ): Promise<{ pass: boolean; detail?: string }> {
    const failed = (await checkAssertions(this.session, pageId, checks)).filter((r) => !r.pass);
    if (failed.length === 0) return { pass: true };
    return {
      pass: false,
      detail: failed
        .map((r) => r.detail ?? '')
        .filter(Boolean)
        .join('；'),
    };
  }

  mainPage(): string {
    return this.#o.main;
  }

  pageOpen(pageId: string): boolean {
    try {
      this.session.pages.get(pageId);
      return true;
    } catch {
      return false;
    }
  }

  actionSeq(): number {
    return currentActionSeq(this.session);
  }

  /** 失败现场截图，存到 runs/<run_id>/shots/keep/，返回相对工作区的路径；截不了返回 null。 */
  async screenshot(pageId: string, name: string): Promise<string | null> {
    try {
      const file = this.#store.shotPath(name, { keep: true });
      const shot = this.session.pages.get(pageId).screenshot({ path: file as `${string}.webp` });
      const timer = new Promise<never>((_, reject) => {
        setTimeout(reject, SHOT_TIMEOUT_MS, new Error('截图超时')).unref();
      });
      await Promise.race([shot, timer]);
      return relative(this.#o.workspace, file);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.#o.cache?.dispose();
    await this.session.close({ closeBrowser: this.#o.closeBrowser ?? false }).catch(() => {});
    rmSync(browserPidFile(this.#o.workspace, this.#o.runId), { force: true });
  }
}

/** 运行目录里记录浏览器进程号的文件：运行子进程被 SIGKILL 后，浏览器（自成进程组）会成孤儿，靠它清扫。 */
const browserPidFile = (workspace: string, runId: string) =>
  join(workspace, 'runs', runId, 'browser.pid');

/**
 * 子进程退出后清扫它留下的浏览器（Chrome 由 puppeteer 放在自己的进程组里，监督进程清扫子进程组碰不到它）。
 * 为防 pid 被别的进程复用，只清命令行里带该运行配置目录的进程；读不到命令行就不动手。
 */
export function sweepBrowser(workspace: string, runId: string): void {
  const file = browserPidFile(workspace, runId);
  let rec: { pid: number; profile: string };
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  rmSync(file, { force: true });
  let cmd = '';
  try {
    cmd =
      process.platform === 'linux'
        ? readFileSync(`/proc/${rec.pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
        : (spawnSync('ps', ['-p', String(rec.pid), '-o', 'command='], { encoding: 'utf8' })
            .stdout ?? '');
  } catch {
    return;
  }
  if (!cmd.includes(`--user-data-dir=${rec.profile}`)) return;
  try {
    process.kill(-rec.pid, 'SIGKILL'); // 浏览器自己的进程组
  } catch {
    try {
      process.kill(rec.pid, 'SIGKILL');
    } catch {}
  }
}

export type OpenSessionOptions = {
  workspace: string;
  runId: string;
  workflow: Workflow;
  /** 默认 headless。 */
  mode?: LaunchOptions['mode'];
  /** 浏览器路径；省略时读环境变量 CHROME_PATH。 */
  chromePath?: string;
  /** 账号（决定浏览器配置目录）；省略时取工作流的 account，再缺省 default。 */
  account?: string;
};

/**
 * 启动浏览器（配置目录 <工作区>/profiles/<账号>），接入会话，新建 main 标签页，返回执行器。
 * 工作流声明了 intercept 时先挂接口缓存，再开标签页，main 页的请求不会漏。
 */
export async function openSession(o: OpenSessionOptions): Promise<CoreExecutor> {
  const account = o.account ?? o.workflow.meta.account ?? 'default';
  assertAccountName(account);
  const profileDir = join(o.workspace, 'profiles', account);
  const browser = await launchBrowser({
    profileDir,
    mode: o.mode ?? 'headless',
    chromePath: o.chromePath,
  });
  const pid = browser.process()?.pid;
  if (pid) {
    try {
      const file = browserPidFile(o.workspace, o.runId);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ pid, profile: profileDir }));
    } catch {} // 记不下来只是少一道清扫，不影响运行
  }
  try {
    const session = await Session.attach(browser, { adopt: false });
    const rules = o.workflow.meta.intercept ?? [];
    let cache: NetworkCache | undefined;
    if (rules.length > 0) {
      cache = new NetworkCache(session);
      await cache.attach({ rules });
    }
    const main = await session.pages.newPage();
    await cache?.ready();
    // 浏览器启动时自带的空白页（或上次遗留的页面）不登记，关掉免得干扰
    for (const p of await browser.pages())
      if (!session.pages.idOf(p)) await p.close().catch(() => {});
    return new CoreExecutor({
      session,
      main,
      workspace: o.workspace,
      runId: o.runId,
      meta: o.workflow.meta,
      ...(cache ? { cache } : {}),
      closeBrowser: true,
    });
  } catch (e) {
    await browser.close().catch(() => {});
    rmSync(browserPidFile(o.workspace, o.runId), { force: true });
    throw e;
  }
}
