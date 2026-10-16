/**
 * 测试与基准用的浏览器：开发容器、本机、CI 共用同一份固定版本的 Chrome for Testing，保证结果可复现。
 *
 *   npm run browser:install        安装到 <仓库>/.cache/chrome（已 gitignore）
 *   CHROME_PATH=/path/to/chrome    显式指定浏览器（优先于安装目录；用于在别的版本上抽测）
 *
 * 没有安装也没有 CHROME_PATH 时返回 undefined：测试会跳过并提示先安装，不会悄悄换成别的浏览器。
 * 运行时（给用户用）的浏览器区间与推荐版本是另一回事，见 docs/PRD.md。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 基准版本：CI 与开发环境都用它跑全套测试。 */
export const BASELINE_VERSION = '141.0.7390.122';
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(REPO, '.cache', 'chrome');

async function installedPath(): Promise<string | undefined> {
  const { Browser, computeExecutablePath, detectBrowserPlatform } = await import(
    '@puppeteer/browsers'
  );
  const platform = detectBrowserPlatform();
  if (!platform) return undefined;
  const p = computeExecutablePath({
    browser: Browser.CHROME,
    buildId: BASELINE_VERSION,
    cacheDir: CACHE_DIR,
    platform,
  });
  return existsSync(p) ? p : undefined;
}

/** 测试用浏览器路径：CHROME_PATH，否则安装目录里的基准版本，都没有则 undefined。 */
export async function testChrome(): Promise<string | undefined> {
  return process.env.CHROME_PATH || (await installedPath());
}

export const MISSING = `未找到浏览器：运行 npm run browser:install 安装 Chrome for Testing ${BASELINE_VERSION}，或设置 CHROME_PATH`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    const { Browser, install, detectBrowserPlatform } = await import('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error('不支持的平台');
    const r = await install({
      browser: Browser.CHROME,
      buildId: BASELINE_VERSION,
      cacheDir: CACHE_DIR,
      platform,
    });
    console.log(r.executablePath);
  } else if (cmd === 'path') {
    console.log((await testChrome()) ?? '');
  } else {
    console.error('用法：node tools/browser.ts install | path');
    process.exit(2);
  }
}
