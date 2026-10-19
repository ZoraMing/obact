import type { Page } from 'puppeteer-core';

/**
 * 页面提示条（FR-29）：有头运行时在页面角落放一条“Obact 正在操作”，让人一眼看出正在自动化操作。
 *
 * - 放在关闭的 Shadow DOM 里，页面样式进不去，条里的样式也不会漏到页面；pointer-events:none，不拦截鼠标。
 * - 不进入 observe 与 act：宿主元素带 BANNER_ATTR，mark.ts 不会把它的封闭 Shadow Root 暴露给页面助手，
 *   所以元素列表、纯网页文本、编号、命中测试里都没有它；宿主本身是个没有文字、没有角色的空元素。
 * - 导航产生的新文档由 evaluateOnNewDocument 重新注入；act 不会自动显示它，由调用方（runner）决定何时显示和移除。
 *   无头运行时不该调用（FR-29）。
 */

/** 提示条宿主元素上的属性（mark.ts 据此跳过它的封闭 Shadow Root）。 */
export const BANNER_ATTR = 'data-obact-banner';
export const DEFAULT_BANNER_TEXT = 'Obact 正在操作';

/**
 * 在页面内放置（或更新文字）提示条。自包含：同时用于 evaluateOnNewDocument（此时可能还没有根元素）
 * 和 evaluate（当前文档）。只放在顶层文档，子 frame 里不放。
 */
function obBannerInstall(text: string, attr: string): void {
  if (window !== window.top) return;
  type Handle = { setText(t: string): void };
  const KEY = '__obactBanner';
  const old = document.querySelector(`[${attr}]`) as unknown as Record<string, Handle> | null;
  if (old?.[KEY]) {
    old[KEY].setText(text);
    return;
  }
  const host = document.createElement('obact-banner');
  host.setAttribute(attr, '');
  host.setAttribute('aria-hidden', 'true');
  // 内联样式用 !important 压过页面的 * 或标签选择器；经 CSSOM 设置，不受页面 CSP 的 style-src 限制
  host.style.cssText = [
    'all:initial',
    'position:fixed',
    'left:12px',
    'bottom:12px',
    'z-index:2147483647',
    'display:block',
    'pointer-events:none',
  ]
    .map((d) => `${d}!important`)
    .join(';');
  const root = host.attachShadow({ mode: 'closed' });
  const css = `
    .bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
      background: rgba(17, 24, 39, 0.88); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      font: 13px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      user-select: none; pointer-events: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; }
    @media print { .bar { display: none; } }`;
  try {
    const sheet = new CSSStyleSheet(); // 构造样式表不受页面 CSP 限制
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
  const bar = document.createElement('div');
  bar.className = 'bar';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = text;
  bar.append(dot, label);
  root.append(bar);
  Object.defineProperty(host, KEY, {
    value: {
      setText: (t: string) => {
        label.textContent = t;
      },
    } satisfies Handle,
  });
  // 挂在根元素下（不在 body 里），页面整体替换 body 时不受影响；被页面脚本清掉时补回，最多 20 次，避免和页面互相抢
  let moved = 0;
  const watcher = new MutationObserver(() => sync());
  const sync = () => {
    const html = document.documentElement;
    if (!html) return; // 新文档刚开始还没有根元素：等 document 的子节点出现
    if (host.parentNode !== html) {
      if (++moved > 20) {
        watcher.disconnect();
        return;
      }
      html.appendChild(host);
    }
    watcher.observe(html, { childList: true });
  };
  watcher.observe(document, { childList: true });
  Object.defineProperty(host, '__obactBannerStop', { value: () => watcher.disconnect() });
  sync();
}

/** 在页面内移除提示条，并停止补回。 */
function obBannerRemove(attr: string): void {
  for (const host of document.querySelectorAll(`[${attr}]`)) {
    (host as unknown as { __obactBannerStop?: () => void }).__obactBannerStop?.();
    host.remove();
  }
}

/** 每个标签页登记的“新文档注入脚本”标识，hideBanner 据此撤销。 */
const injected = new WeakMap<Page, string>();

/** 页面正在导航属于正常情况：当前文档里注入失败不要紧，新文档的注入脚本会接上。 */
const ignoreNavigation = (e: unknown) => {
  if (!/Execution context was destroyed|Target closed|detached|Session closed/i.test(String(e))) {
    throw e;
  }
};

/**
 * 在标签页角落显示提示条，之后每次导航产生的新文档里也会自动出现，直到 hideBanner。
 * 重复调用只更新文字。同一个 Page 对象负责显示和移除（登记信息记在 Page 对象上）。
 */
export async function showBanner(page: Page, text: string = DEFAULT_BANNER_TEXT): Promise<void> {
  const prev = injected.get(page);
  if (prev) await page.removeScriptToEvaluateOnNewDocument(prev).catch(() => {});
  const { identifier } = await page.evaluateOnNewDocument(obBannerInstall, text, BANNER_ATTR);
  injected.set(page, identifier);
  await page.evaluate(obBannerInstall, text, BANNER_ATTR).catch(ignoreNavigation);
}

/** 撤销新文档注入并移除当前文档里的提示条。没有显示过时什么也不做。 */
export async function hideBanner(page: Page): Promise<void> {
  const id = injected.get(page);
  if (id) {
    injected.delete(page);
    await page.removeScriptToEvaluateOnNewDocument(id).catch(() => {});
  }
  await page.evaluate(obBannerRemove, BANNER_ATTR).catch(ignoreNavigation);
}
