import type { Browser } from 'puppeteer-core';

/** 已验证的最低主版本（PRD 8.3）：141 及以上预期可用，低于它未验证。 */
export const MIN_BROWSER_MAJOR = 141;

export type BrowserVersionCheck = {
  /** 浏览器自报的产品串，如 "Chrome/141.0.7390.122"、"HeadlessChrome/141.0.7390.122"。 */
  product: string;
  /** 主版本号；产品串里认不出版本号时为 0。 */
  major: number;
  /** 主版本不低于 MIN_BROWSER_MAJOR。 */
  ok: boolean;
  /** 未验证时的警告文案；只警告，不阻止启动。 */
  warning?: string;
};

/** 按产品串判断版本是否在已验证区间内（纯函数）。 */
export function judgeBrowserVersion(product: string): BrowserVersionCheck {
  const major = Number(/\/(\d+)\./.exec(product)?.[1] ?? 0);
  if (major >= MIN_BROWSER_MAJOR) return { product, major, ok: true };
  const why =
    major > 0
      ? `浏览器版本 ${product} 低于已验证的最低版本 ${MIN_BROWSER_MAJOR}`
      : `无法识别浏览器版本（${product || '空'}）`;
  return {
    product,
    major,
    ok: false,
    warning: `${why}，未经验证：可能能用，也可能出现异常，不阻止运行；建议使用推荐版本 Chrome for Testing 141`,
  };
}

/**
 * 运行时浏览器版本检测（PRD 8.3）：读浏览器自报的版本，141 及以上 ok，低于 141 给出警告文案。
 * 只检测不阻止；launchBrowser 与 connectBrowser 不会自动调用，由调用方（如 BrowserPool）决定何时警告。
 */
export async function checkBrowserVersion(browser: Browser): Promise<BrowserVersionCheck> {
  return judgeBrowserVersion(await browser.version());
}
