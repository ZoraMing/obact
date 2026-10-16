import { testChrome } from '../../tools/browser.ts';

// 预研用浏览器路径：CHROME_PATH，否则 npm run browser:install 装的基准版本。
export const CHROME_PATH = (await testChrome()) as string;

export const HEADLESS = process.env.HEADED !== '1';

export function log(tag: string, data: unknown): void {
  console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
}

/** 容器里以 root 运行时 Chromium 必须关沙箱；正式部署不以 root 运行，不需要这一项。 */
export const EXTRA_ARGS = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
