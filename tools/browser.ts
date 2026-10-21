/**
 * 测试与基准用的浏览器：开发容器、本机、CI 共用同一份固定版本的 Chrome for Testing，保证结果可复现。
 *
 *   npm run browser:install        安装到 <仓库>/.cache/chrome（已 gitignore）
 *   CHROME_PATH=/path/to/chrome    显式指定浏览器（优先于安装目录；用于在别的版本上抽测）
 *
 * 没有安装也没有 CHROME_PATH 时返回 undefined：测试会跳过并提示先安装，不会悄悄换成别的浏览器。
 * 设了环境变量 OBACT_REQUIRE_BROWSER=1（CI 设置）则不跳过，直接失败，见 skipIfNoBrowser。
 * 运行时（给用户用）的浏览器区间与推荐版本是另一回事，见 docs/PRD.md。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 基准版本：CI 与开发环境都用它跑全套测试。 */
export const BASELINE_VERSION = '141.0.7390.122';
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(REPO, '.cache', 'chrome');

async function installedPath(kind: 'chrome' | 'shell' = 'chrome'): Promise<string | undefined> {
  const { Browser, computeExecutablePath, detectBrowserPlatform } = await import(
    '@puppeteer/browsers'
  );
  const platform = detectBrowserPlatform();
  if (!platform) return undefined;
  const p = computeExecutablePath({
    browser: kind === 'shell' ? Browser.CHROMEHEADLESSSHELL : Browser.CHROME,
    buildId: BASELINE_VERSION,
    cacheDir: CACHE_DIR,
    platform,
  });
  return existsSync(p) ? p : undefined;
}

/**
 * 测试用浏览器路径：CHROME_PATH，否则安装目录里的基准版本，都没有则 undefined。
 * 无头测试默认用 chrome-headless-shell：完整 Chrome（有头或新无头）在点击引起整页导航后，
 * 只要 Node 进程被卡住约 100 毫秒，该标签页就收不到任何鼠标和键盘输入，见 docs/spikes/M0-spikes.md 第 6 节。
 * HEADED=1 时用完整 Chrome。
 */
export async function testChrome(): Promise<string | undefined> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.HEADED !== '1') return (await installedPath('shell')) ?? (await installedPath());
  return installedPath();
}

/** 完整 Chrome（有头测试用）。 */
export async function testFullChrome(): Promise<string | undefined> {
  return process.env.CHROME_PATH || installedPath();
}

export const MISSING = `未找到浏览器：运行 npm run browser:install 安装 Chrome for Testing ${BASELINE_VERSION}，或设置 CHROME_PATH`;

/**
 * 传给 describe 的 skip 选项：有浏览器返回 false，没有则返回 MISSING（跳过并提示）。
 * OBACT_REQUIRE_BROWSER=1 时找不到浏览器直接抛错：套件级跳过不计入 skipped 汇总、退出码仍是 0，
 * 浏览器没装上时大部分测试会悄悄没跑，CI 靠这个变量把它变成失败。
 */
export function skipIfNoBrowser(chrome: string | undefined): false | string {
  if (chrome) return false;
  if (process.env.OBACT_REQUIRE_BROWSER === '1') {
    throw new Error(`OBACT_REQUIRE_BROWSER=1，不允许跳过浏览器测试。${MISSING}`);
  }
  return MISSING;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    const { Browser, install, detectBrowserPlatform } = await import('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error('不支持的平台');
    for (const browser of [Browser.CHROME, Browser.CHROMEHEADLESSSHELL]) {
      const r = await install({
        browser,
        buildId: BASELINE_VERSION,
        cacheDir: CACHE_DIR,
        platform,
      });
      console.log(r.executablePath);
    }
  } else if (cmd === 'path') {
    console.log((await testChrome()) ?? '');
  } else {
    console.error('用法：node tools/browser.ts install | path');
    process.exit(2);
  }
}
