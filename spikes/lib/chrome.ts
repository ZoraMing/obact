// 预研用浏览器路径：环境变量 CHROME_PATH，否则用本容器预装的 Chromium。
export const CHROME_PATH =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const HEADLESS = process.env.HEADED !== '1';

export function log(tag: string, data: unknown): void {
  console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
}

/** 容器里以 root 运行时 Chromium 必须关沙箱；正式部署不以 root 运行，不需要这一项。 */
export const EXTRA_ARGS = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
