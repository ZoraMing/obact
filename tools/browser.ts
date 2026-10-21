/**
 * 测试与基准用的浏览器：开发容器、本机、CI 共用同一份固定版本的 Chrome for Testing，保证结果可复现。
 *
 *   npm run browser:install        安装到 <仓库>/.cache/chrome（已 gitignore），下载的压缩包按 BASELINE_SHA256 校验
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

/**
 * 基准版本各平台压缩包的 SHA-256（键为 @puppeteer/browsers 的平台名）：install 时校验，下载内容被换掉会直接失败。
 * 升级 BASELINE_VERSION 时整张表重算：
 *   curl -s https://storage.googleapis.com/chrome-for-testing-public/<版本>/<linux64|mac-arm64|mac-x64|win32|win64>/<chrome|chrome-headless-shell>-<平台>.zip | sha256sum
 * （linux_arm 没有 Chrome for Testing 构建。）
 */
export const BASELINE_SHA256: Record<string, { chrome: string; shell: string }> = {
  linux: {
    chrome: 'c7c9611f91f960f43cf36af1282acef5c5706bf7b026b68a400c55da24f81073',
    shell: '5ab96651d2f2d2d6501de60fec918c562c4c02fde497da0688bd82c4994a04eb',
  },
  mac_arm: {
    chrome: 'cfcb46d20f1ee3cab92cb814773a08c1fc1d53727ea87f5747cec96c69549042',
    shell: '6bd2b26e1d89f5c3939969e337ef62133631b044f28e517e5ab2a195ce7d7e7e',
  },
  mac: {
    chrome: 'abbed1d295197a9bd2493e65e9607259cbd1ce654531b9fbf48f1e3a8f9a5626',
    shell: '819199757ca223fafb401f1d20215d369a130bbd88c4ba96334bb65ac2b7d4f2',
  },
  win32: {
    chrome: 'e163433737c727a5b9577337a44b8db7eaa5ec90a6c22bd8d4b0b2a5b9658ed3',
    shell: 'f24b037deecedda3da0e200f80f65a8dd9cbbfaa6559be1eba8503697cd15dbb',
  },
  win64: {
    chrome: '918f84e6700d5929867895029981659086359d67058838adb8496db0e33f5719',
    shell: '04765b5879b09c22152b9c753778851a003ee2009269e4d049245daa774b46ce',
  },
};
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(REPO, '.cache', 'chrome');

async function installedPath(
  kind: 'chrome' | 'shell' = 'chrome',
  cacheDir = CACHE_DIR,
): Promise<string | undefined> {
  const { Browser, computeExecutablePath, detectBrowserPlatform } = await import(
    '@puppeteer/browsers'
  );
  const platform = detectBrowserPlatform();
  if (!platform) return undefined;
  const p = computeExecutablePath({
    browser: kind === 'shell' ? Browser.CHROMEHEADLESSSHELL : Browser.CHROME,
    buildId: BASELINE_VERSION,
    cacheDir,
    platform,
  });
  return existsSync(p) ? p : undefined;
}

/**
 * 测试用浏览器路径：CHROME_PATH，否则安装目录里的基准版本，都没有则 undefined。
 * 无头测试默认用 chrome-headless-shell：完整 Chrome（有头或新无头）在点击引起整页导航后，
 * 只要 Node 进程被卡住约 100 毫秒，该标签页就收不到任何鼠标和键盘输入，见 docs/spikes/M0-spikes.md 第 6 节。
 * 所以无头时缺 chrome-headless-shell 就返回 undefined（提示重新安装），不回退到完整 Chrome，否则只会变成莫名其妙的用例失败。
 * HEADED=1 时用完整 Chrome。cacheDir 只给测试换安装目录用。
 */
export async function testChrome(cacheDir = CACHE_DIR): Promise<string | undefined> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return installedPath(process.env.HEADED === '1' ? 'chrome' : 'shell', cacheDir);
}

/** 完整 Chrome（有头测试用）。 */
export async function testFullChrome(cacheDir = CACHE_DIR): Promise<string | undefined> {
  return process.env.CHROME_PATH || installedPath('chrome', cacheDir);
}

export const MISSING = `未找到浏览器：运行 npm run browser:install 安装 Chrome for Testing 与 chrome-headless-shell ${BASELINE_VERSION}，或设置 CHROME_PATH`;

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

/**
 * 安装基准版本的 Chrome 与 chrome-headless-shell，下载的压缩包按 BASELINE_SHA256 校验；返回两个可执行文件路径。
 * 表里没有当前平台时报错，不做无校验的下载。已经装好的版本不会重新下载，也就不再校验。
 */
export async function installBaseline(
  cacheDir = CACHE_DIR,
  hashes = BASELINE_SHA256,
): Promise<string[]> {
  const { Browser, install, detectBrowserPlatform } = await import('@puppeteer/browsers');
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error('不支持的平台');
  const expected = hashes[platform];
  if (!expected) throw new Error(`平台 ${platform} 没有基准版本的校验值（BASELINE_SHA256）`);
  const paths: string[] = [];
  for (const [browser, expectedHash] of [
    [Browser.CHROME, expected.chrome],
    [Browser.CHROMEHEADLESSSHELL, expected.shell],
  ] as const) {
    const r = await install({
      browser,
      buildId: BASELINE_VERSION,
      cacheDir,
      platform,
      expectedHash,
    });
    paths.push(r.executablePath);
  }
  return paths;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    for (const p of await installBaseline()) console.log(p);
  } else if (cmd === 'path') {
    console.log((await testChrome()) ?? '');
  } else {
    console.error('用法：node tools/browser.ts install | path');
    process.exit(2);
  }
}
