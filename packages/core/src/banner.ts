import type { Page } from 'puppeteer-core';

/**
 * 页面提示条（FR-29）：有头运行时在页面角落放一条“Obact 正在操作”，让人一眼看出正在自动化操作。
 *
 * - 放在关闭的 Shadow DOM 里，页面样式进不去，条里的样式也不会漏到页面；pointer-events:none，不拦截鼠标。
 * - 不进入 observe 与 act：宿主元素带 BANNER_ATTR，mark.ts 不会把它的封闭 Shadow Root 暴露给页面助手，
 *   所以元素列表、纯网页文本、编号、命中测试里都没有它；宿主本身是个没有文字、没有角色的空元素。
 * - 导航产生的新文档由 evaluateOnNewDocument 重新注入；act 不会自动显示它，由调用方（runner）决定何时显示和移除。
 *   无头运行时不该调用（FR-29）。
 * - 它不是防篡改边界：条和页面脚本在同一个 JS 世界里，页面总能删掉自己的 DOM、用内联样式盖住它，
 *   或在条放进来之前钩住 attachShadow 拿到封闭根。这里只保证页面正常运行时（含框架整体重绘）条不会丢，
 *   页面一直在删时也会（延迟）补回；需要可信提示的场景以终端侧的提示为准。
 */

/** 提示条宿主元素上的属性（mark.ts 据此跳过它的封闭 Shadow Root）。 */
export const BANNER_ATTR = 'data-obact-banner';
export const DEFAULT_BANNER_TEXT = 'Obact 正在操作';

/**
 * 在页面内放置（或更新文字）提示条。自包含：同时用于 evaluateOnNewDocument（此时可能还没有根元素）
 * 和 evaluate（当前文档）。只放在顶层的 HTML 文档，子 frame、SVG/XML 文档里不放。
 */
function obBannerInstall(text: string, attr: string): void {
  if (window !== window.top) return;
  type Handle = { setText(t: string): void; stop(): void };
  // 句柄挂在 document 上而不是宿主上：宿主被页面摘掉、等着延迟补回时，更新文字与停止补回也找得到它
  const KEY = '__obactBanner';
  const old = (document as unknown as Record<string, Handle | undefined>)[KEY];
  if (old) {
    old.setText(text);
    return;
  }
  const host = document.createElement('obact-banner');
  // SVG、XML 等非 HTML 文档里建出来的不是 HTML 元素（没有 style，也显示不出来）：不放，也不报错
  if (!(host instanceof HTMLElement)) return;
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
  // 挂在根元素下（不在 body 里），页面整体替换 body 时不受影响；被页面脚本清掉时补回。
  // 前 20 次立刻补回；页面还在删，就改成延迟补回，间隔逐步拉长（上限 2 秒）：
  // 不会和页面在同一轮微任务里互相抢到卡死，也不会被一直删掉。
  let moved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = new MutationObserver(() => sync());
  const place = () => {
    timer = undefined;
    const html = document.documentElement;
    if (!html) return; // 新文档刚开始还没有根元素：等 document 的子节点出现
    if (host.parentNode !== html) {
      moved++;
      html.appendChild(host);
    }
    watcher.observe(html, { childList: true });
  };
  const sync = () => {
    if (timer !== undefined) return; // 已经排好了延迟补回
    if (moved < 20 || host.parentNode === document.documentElement) place();
    else timer = setTimeout(place, Math.min(2000, 50 * 2 ** (moved - 20)));
  };
  watcher.observe(document, { childList: true });
  Object.defineProperty(document, KEY, {
    configurable: true,
    value: {
      setText: (t: string) => {
        label.textContent = t;
      },
      stop: () => {
        watcher.disconnect();
        clearTimeout(timer);
        timer = undefined;
        Reflect.deleteProperty(document, KEY);
      },
    } satisfies Handle,
  });
  sync();
}

/** 在页面内移除提示条，并停止补回（含已经排上的延迟补回）。 */
function obBannerRemove(attr: string): void {
  (
    document as unknown as Record<string, { stop?: () => void } | undefined>
  ).__obactBanner?.stop?.();
  for (const host of document.querySelectorAll(`[${attr}]`)) host.remove();
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
