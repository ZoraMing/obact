import type { Checkpoint } from '@obact/schemas';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ObactError } from './errors.ts';

type Mode = Checkpoint['mode'];

export type LaunchOptions = {
  /** 账号的浏览器配置目录（FR-02）；每个账号一个，登录态长期复用。 */
  profileDir: string;
  /** 默认有头（FR-01）；无显示器的 Linux 用 Xvfb 运行有头。 */
  mode?: Mode;
  /** Chrome for Testing 可执行文件；省略时读环境变量 CHROME_PATH。 */
  chromePath?: string;
  /** 要加载的扩展目录（只做界面，PRD 8.1）；用 --load-extension 加载（M0 预研结论）。 */
  extensions?: string[];
  args?: string[];
  windowSize?: { width: number; height: number };
};

/** 容器内以 root 运行时 Chromium 必须关沙箱；正式部署不以 root 运行。 */
export function sandboxArgs(): string[] {
  return process.getuid?.() === 0 ? ['--no-sandbox'] : [];
}

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
  const size = opts.windowSize ?? { width: 1280, height: 800 };
  const extArgs = opts.extensions?.length
    ? [
        `--load-extension=${opts.extensions.join(',')}`,
        `--disable-extensions-except=${opts.extensions.join(',')}`,
      ]
    : [];
  return puppeteer.launch({
    executablePath: resolveChromePath(opts.chromePath),
    headless: opts.mode === 'headless',
    userDataDir: opts.profileDir,
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
