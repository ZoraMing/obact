import type { Checkpoint } from '@obact/schemas';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ObactError } from './errors.ts';

type Mode = Checkpoint['mode'];

export type LaunchOptions = {
  /** 账号的浏览器配置目录（FR-02）；每个账号一个，登录态长期复用。 */
  profileDir: string;
  /** 默认有头（FR-01）；无显示器的 Linux 用 Xvfb 运行有头。 */
  mode?: Mode;
  /** Chrome / Chromium 可执行文件；省略时读环境变量 CHROME_PATH，都没有就报错（不探测系统里已有的浏览器，FR-01 的探测排在 M4）。 */
  chromePath?: string;
  /** 要加载的扩展目录：仅 M0 预研用（--load-extension），产品不加载扩展（PRD 8.1、FR-29）。 */
  extensions?: string[];
  args?: string[];
  /** 追加到浏览器进程环境的变量（如池自起 Xvfb 时的 DISPLAY）；与本进程环境合并。 */
  env?: NodeJS.ProcessEnv;
  windowSize?: { width: number; height: number };
};

/** 容器内以 root 运行时 Chromium 必须关沙箱；正式部署不以 root 运行。 */
export function sandboxArgs(): string[] {
  return process.getuid?.() === 0 ? ['--no-sandbox'] : [];
}

/**
 * Linux 上 Chrome 按进程的 locale 解释文件路径：没有设置 UTF-8 locale（常见于容器、systemd 服务）时，
 * 中文文件名的上传会被静默丢弃，下载的文件名也退化成 download。浏览器进程缺 UTF-8 locale 时补 C.UTF-8。
 */
export function browserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return env;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(loc)) return env;
  return { ...env, LC_ALL: 'C.UTF-8' };
}

/** 浏览器路径：显式传入的，否则环境变量 CHROME_PATH；都没有就报 invalid_params。测试用的路径来自 tools/browser.ts。 */
export function resolveChromePath(explicit?: string): string {
  const path = explicit ?? process.env.CHROME_PATH;
  if (!path) {
    throw new ObactError(
      'invalid_params',
      '未指定浏览器：传入 chromePath 或设置环境变量 CHROME_PATH（Chrome for Testing 固定版本）',
    );
  }
  return path;
}

/**
 * 启动浏览器。调试端口由 Puppeteer 以 --remote-debugging-port=0 打开，Chrome 默认只绑定 127.0.0.1；
 * 不要传 --remote-debugging-address（会导致启动超时，见 M0 预研）。
 */
export async function launchBrowser(opts: LaunchOptions): Promise<Browser> {
  const chromePath = resolveChromePath(opts.chromePath);
  const size = opts.windowSize ?? { width: 1280, height: 800 };
  const extArgs = opts.extensions?.length
    ? [
        `--load-extension=${opts.extensions.join(',')}`,
        `--disable-extensions-except=${opts.extensions.join(',')}`,
      ]
    : [];
  return puppeteer.launch({
    executablePath: chromePath,
    // chrome-headless-shell 是 Puppeteer 推荐的无头自动化二进制，不受完整 Chrome 的输入失效问题影响
    headless:
      opts.mode === 'headless' ? (/headless-shell/.test(chromePath) ? 'shell' : true) : false,
    userDataDir: opts.profileDir,
    env: browserEnv({ ...process.env, ...opts.env }) as Record<string, string | undefined>,
    defaultViewport: null,
    enableExtensions: extArgs.length > 0,
    args: [
      ...sandboxArgs(),
      `--window-size=${size.width},${size.height}`,
      ...extArgs,
      ...(opts.args ?? []),
    ],
  });
}

/** 任务子进程连接服务管理的浏览器（PRD 8.1）。 */
export async function connectBrowser(wsEndpoint: string): Promise<Browser> {
  return puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
}
