/**
 * Obact Lab 模块：干扰层（PRD 9.3；覆盖 FR-13、FR-23，BW-7 的 Entry Ad，TS-07 的弹窗与布局偏移）。页面都不需要登录。
 *
 * 页面：
 *   GET /noise           干扰层演示页（标题“干扰层”）。一个“姓名 + 提交”的小表单，周围放了四种干扰：
 *                        1. 底部 Cookie 提示条（固定定位，“接受”按钮）：挡住右下角的“在线客服”悬浮按钮和页脚的“隐私政策”；
 *                           点“接受”后不再显示，按空间记住；
 *                        2. 透明遮挡层：加载后的前 1.5 秒完全盖住“提交”按钮，之后自动移除；
 *                        3. 布局偏移：加载后 300 毫秒在表单上方插入“限时活动”横幅，把“提交”按钮往下推；
 *                        4. 随机广告弹窗（全局故障，见下）。
 *                        提交表单后在页面里显示“提交成功”（提示区 role=status）。
 *   GET /noise/entry-ad  Entry Ad 演示页（标题“入口广告”）：每次加载都弹出广告，不受 popup_rate 与“已关闭”影响；
 *                        页面上有“继续阅读”按钮，广告没关时点它会被遮挡（BW-7）。
 * 页面的演示开关（查询参数，默认值就是上面写的行为；测试用来隔离某一种干扰，评测任务不需要用）：
 *   cookie=0     不显示 Cookie 提示条
 *   mask=0       不加透明遮挡层；mask_ms=N  遮挡层持续 N 毫秒（默认 1500，0 等于不加）
 *   shift=0      不做布局偏移；shift_ms=N  偏移延迟 N 毫秒（默认 300）；
 *   shift=hover  首次把鼠标移到“提交”上时才偏移（让偏移恰好发生在“移动鼠标”与“按下”之间，用于验证落点防护）
 * 接口（Cookie 与广告的两个接口不在 /api/ 下，不受故障注入影响：干扰层自身要稳定，被测对象才是代理的应对）：
 *   POST /noise/cookie-accept   接受 Cookie 提示（页面里点“接受”时调用）
 *   POST /noise/ad-close        关闭广告（页面里点“关闭”时调用）：关闭次数加一，并且本空间内不再随机弹出
 *   POST /api/noise/submit      提交表单 {name?, key?}（写接口，记录幂等键；受故障注入影响）：
 *                               同一个 key 再次提交只在提交记录里计数，不重复计入 form_submits，返回 duplicate: true
 *
 * 随机广告弹窗（faults.popup_rate，实现在模块的 shell 钩子里，所以 core 的 page() 渲染的任何页面都会带上）：
 *   popup_rate > 0 且本空间还没关过广告时，每个页面按 space.rng() < popup_rate 决定是否输出广告层；
 *   广告层是全屏半透明遮罩 + 对话框“特别优惠”（含“立即领取”链接和“关闭”按钮），页面加载约 500 毫秒后出现，
 *   点“关闭”后移除。关闭记在空间数据里（不是 cookie），所以同一空间换标签页、换浏览器都不再弹，_lab/reset 后恢复。
 *   popup_rate 为 0 或已关闭时不消耗 space.rng()，所以不影响其他模块的随机序列。
 *   /noise/entry-ad 总是输出广告层（不看 popup_rate，也不看是否关过），并且不会再叠加一个随机弹窗。
 *
 * 状态（_lab/state 的 modules.noise）：
 *   ad_shown         输出广告层的次数（页面渲染时由服务端决定并计数，层本身约 500 毫秒后才出现；含 Entry Ad 页）
 *   ad_closed        点“关闭”的次数
 *   ad_dismissed     本空间是否已关过广告（true 后不再随机弹出）
 *   entry_ad_loads   Entry Ad 页的加载次数
 *   cookie_accepted  Cookie 提示是否已接受
 *   form_submits     表单提交次数（按幂等键去重）
 *   names            每次提交的姓名（按提交顺序）
 *
 * 页面脚本留的钩子（测试用）：window.__noise（/noise 页）：clicks（文档里每次点击落在哪个 data-noise 上，没有则记为“(标签名)”）、
 *   maskStartedAt/maskRemovedAt、shiftedAt、shift()（立即触发偏移）；window.__noiseAd（有广告层的页面）：
 *   scheduledAt、shownAt、closedAt、clicks（落在广告层里的点击）。时间都是 performance.now()。
 *
 * 随机性：init 不消耗 space.rng()。改版变体（faults.redesign）：本模块不定义变体，按原版渲染。
 */
import { BodyTooLarge, type Ctx, esc, type LabModule, page, type Space } from '../core.ts';

/** 广告层在页面加载后多久出现（毫秒）。 */
export const AD_DELAY_MS = 500;
/** 透明遮挡层默认持续多久（毫秒）。 */
export const MASK_MS = 1500;
/** 布局偏移默认延迟（毫秒）。 */
export const SHIFT_MS = 300;

export type NoiseData = {
  ad_shown: number;
  ad_closed: number;
  ad_dismissed: boolean;
  entry_ad_loads: number;
  cookie_accepted: boolean;
  form_submits: number;
  names: string[];
};

export const dataOf = (space: Space): NoiseData => space.data.noise as NoiseData;

const MAX_NAME = 50;
const MAX_KEY = 64;
const SUBMIT_OP = 'noise.submit';

/** 页面外壳用的模块列表：Ctx 没有完整列表时导航里只会有本模块。 */
const shellModules = (): readonly LabModule[] => [mod];

/** 非负整数查询参数；缺省、非法或超过 10 分钟都取默认值。 */
function msParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d{1,6}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n > 600_000 ? fallback : n;
}

// ---------------------------------------------------------------------------------------------
// 广告层（shell 钩子与 Entry Ad 页共用）
// ---------------------------------------------------------------------------------------------

const AD_STYLE = `<style>
  .noise-ad { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
  .noise-ad[hidden] { display: none; }
  .noise-ad-box { position: relative; width: 360px; max-width: calc(100vw - 32px); box-sizing: border-box; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
  .noise-ad-box h2 { margin: 0 0 8px; font-size: 22px; color: #b91c1c; }
  .noise-ad-box p { margin: 0 0 12px; }
  .noise-ad-cta { display: inline-block; padding: 6px 14px; background: #dc2626; color: #fff; border-radius: 4px; text-decoration: none; }
  .noise-ad-close { position: absolute; right: 12px; top: 12px; padding: 4px 10px; }
</style>`;

/** 广告层脚本：约 500 毫秒后显示；点“关闭”先通知服务端再移除（通知失败也移除，用户看到的关闭必须生效）。 */
const AD_JS = `(function () {
  var ad = document.getElementById('noise-ad');
  if (!ad) return;
  var base = ad.getAttribute('data-base');
  var delay = Number(ad.getAttribute('data-delay'));
  var st = (window.__noiseAd = { scheduledAt: performance.now(), shownAt: null, closedAt: null, clicks: [] });
  document.addEventListener('click', function (e) {
    if (!ad.contains(e.target)) return;
    var el = e.target.closest('[data-noise]');
    st.clicks.push(el ? el.getAttribute('data-noise') : '(' + e.target.tagName.toLowerCase() + ')');
  }, true);
  setTimeout(function () {
    ad.hidden = false;
    st.shownAt = performance.now();
  }, delay);
  var closing = false;
  ad.querySelector('.noise-ad-close').addEventListener('click', function () {
    if (closing) return;
    closing = true;
    var done = function () {
      st.closedAt = performance.now();
      ad.remove();
    };
    fetch(base + '/noise/ad-close', { method: 'POST', keepalive: true }).then(done, done);
  });
})();`;

/** 广告层（初始隐藏，脚本在 AD_DELAY_MS 后显示）。 */
function adHtml(ctx: Ctx): string {
  return `${AD_STYLE}
<div id="noise-ad" class="noise-ad" data-noise="ad-backdrop" data-base="${esc(ctx.base)}" data-delay="${AD_DELAY_MS}" hidden>
  <div class="noise-ad-box" role="dialog" aria-modal="true" aria-labelledby="noise-ad-title" data-noise="ad-dialog">
    <h2 id="noise-ad-title">特别优惠</h2>
    <p>新用户注册立减 30 元，仅限今日。</p>
    <a href="#promo" class="noise-ad-cta" data-noise="ad-cta">立即领取</a>
    <button type="button" class="noise-ad-close" data-noise="ad-close">关闭</button>
  </div>
</div>
<script>${AD_JS}</script>`;
}

// ---------------------------------------------------------------------------------------------
// /noise 页面
// ---------------------------------------------------------------------------------------------

const PAGE_STYLE = `<style>
  .noise-page { display: flex; flex-direction: column; min-height: calc(100vh - 110px); max-width: 720px; }
  .noise-page h1 { margin: 0 0 8px; }
  .noise-lead { margin: 0 0 12px; color: #555; }
  .noise-form { margin: 8px 0; padding: 12px 16px; border: 1px solid #ccc; border-radius: 6px; }
  .noise-form label { display: inline-block; min-width: 3em; }
  .noise-form input { padding: 4px 6px; width: 200px; }
  .noise-submit-wrap { position: relative; display: inline-block; margin-top: 12px; }
  .noise-submit-wrap button { padding: 6px 20px; }
  #noise-blocker { position: absolute; inset: -4px; z-index: 5; background: transparent; }
  .noise-promo { margin: 0 0 12px; padding: 14px 16px; min-height: 44px; box-sizing: border-box; background: #fff7e6; border: 1px solid #ffd591; border-radius: 4px; }
  .noise-status { min-height: 1.6em; margin: 8px 0; color: #15803d; }
  .noise-status.error { color: #b91c1c; }
  .noise-footer { margin-top: auto; padding: 12px 0; color: #666; font-size: 13px; }
  .noise-fab { position: fixed; right: 24px; bottom: 20px; z-index: 50; padding: 12px 20px; border: 0; border-radius: 999px; background: #2563eb; color: #fff; font-size: 14px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
  .noise-cookie { position: fixed; left: 0; right: 0; bottom: 0; z-index: 100; height: 96px; box-sizing: border-box; display: flex; align-items: center; gap: 16px; padding: 0 24px; background: rgba(30, 30, 30, 0.95); color: #fff; }
  .noise-cookie button { padding: 8px 24px; }
</style>`;

/** /noise 页脚本：点击记录、遮挡层定时移除、布局偏移、Cookie 接受、表单提交、客服按钮。 */
const PAGE_JS = `(function () {
  var root = document.getElementById('noise-root');
  var base = root.getAttribute('data-base');
  var maskMs = Number(root.getAttribute('data-mask-ms'));
  var shiftMode = root.getAttribute('data-shift-mode');
  var shiftMs = Number(root.getAttribute('data-shift-ms'));
  var $ = function (id) { return document.getElementById(id); };
  var n = (window.__noise = {
    clicks: [], loadedAt: null, maskStartedAt: null, maskRemovedAt: null, shiftedAt: null, shift: shift
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-noise]') : null;
    n.clicks.push(el ? el.getAttribute('data-noise') : '(' + e.target.tagName.toLowerCase() + ')');
  }, true);

  // 布局偏移：在表单上方插入横幅，把表单和“提交”往下推
  function shift() {
    if (n.shiftedAt !== null) return false;
    n.shiftedAt = performance.now();
    var bar = document.createElement('div');
    bar.id = 'noise-promo';
    bar.className = 'noise-promo';
    bar.setAttribute('data-noise', 'promo');
    bar.innerHTML = '<strong>限时活动</strong> 本周注册即送体验金。 <a href="#promo" data-noise="promo-link">了解活动</a>';
    $('noise-form').parentNode.insertBefore(bar, $('noise-form'));
    return true;
  }

  function afterLoad(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn);
  }

  afterLoad(function () {
    n.loadedAt = performance.now();
    var blocker = $('noise-blocker');
    if (blocker) {
      n.maskStartedAt = performance.now();
      setTimeout(function () {
        blocker.remove();
        n.maskRemovedAt = performance.now();
      }, maskMs);
    }
    if (shiftMode === 'timer') setTimeout(shift, shiftMs);
  });
  if (shiftMode === 'hover') $('noise-submit-wrap').addEventListener('mouseover', shift);

  var accept = $('noise-cookie-accept');
  if (accept) {
    accept.addEventListener('click', function () {
      var done = function () { $('noise-cookie').remove(); };
      fetch(base + '/noise/cookie-accept', { method: 'POST', keepalive: true }).then(done, done);
    });
  }

  $('noise-chat').addEventListener('click', function () {
    $('noise-chat-reply').textContent = '客服暂未上线，请留言。';
  });

  // 提交：幂等键在状态未明（超时、网络错误、5xx）时沿用，成功或明确失败（4xx）后换新
  var key = null;
  var busy = false;
  var form = $('noise-form');
  var status = $('noise-status');
  var say = function (text, bad) {
    status.textContent = text;
    status.className = 'noise-status' + (bad ? ' error' : '');
  };
  var uuid = function () {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2);
  };
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    key = key || uuid();
    say('提交中…');
    fetch(base + '/api/noise/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('noise-name').value, key: key }),
      signal: AbortSignal.timeout(8000)
    }).then(function (r) {
      if (r.ok) { key = null; say('提交成功'); }
      else if (r.status >= 400 && r.status < 500) { key = null; say('提交被拒绝（' + r.status + '）', true); }
      else say('提交失败（' + r.status + '），请重试', true);
    }, function () {
      say('提交超时或网络错误，状态未知，请重试', true);
    }).then(function () { busy = false; });
  });
})();`;

type PageOpts = {
  cookie: boolean;
  maskMs: number;
  shiftMode: 'timer' | 'hover' | 'off';
  shiftMs: number;
};

function pageOpts(ctx: Ctx): PageOpts {
  const q = ctx.url.searchParams;
  const shiftParam = q.get('shift');
  return {
    cookie: q.get('cookie') !== '0' && !dataOf(ctx.space).cookie_accepted,
    maskMs: q.get('mask') === '0' ? 0 : msParam(ctx.url, 'mask_ms', MASK_MS),
    shiftMode: shiftParam === '0' ? 'off' : shiftParam === 'hover' ? 'hover' : 'timer',
    shiftMs: msParam(ctx.url, 'shift_ms', SHIFT_MS),
  };
}

function noisePage(ctx: Ctx): string {
  const o = pageOpts(ctx);
  const blocker =
    o.maskMs > 0 ? '<div id="noise-blocker" data-noise="blocker" aria-hidden="true"></div>' : '';
  const cookie = o.cookie
    ? `<div id="noise-cookie" class="noise-cookie" role="region" aria-label="Cookie 提示" data-noise="cookie-bar">
  <span>我们使用 Cookie 改善浏览体验，继续使用即表示您同意我们的 Cookie 政策。</span>
  <button type="button" id="noise-cookie-accept" data-noise="cookie-accept">接受</button>
</div>`
    : '';
  return page(
    ctx,
    shellModules(),
    '干扰层',
    `<section id="noise-root" class="noise-page" data-page="noise" data-base="${esc(ctx.base)}" data-mask-ms="${o.maskMs}" data-shift-mode="${o.shiftMode}" data-shift-ms="${o.shiftMs}">
<h1>干扰层</h1>
<p class="noise-lead">本页故意放了几种干扰：底部的 Cookie 提示条、盖在“提交”上的透明层、加载后把表单往下推的横幅。</p>
<form id="noise-form" class="noise-form" aria-label="留言表单">
  <p><label for="noise-name">姓名</label> <input id="noise-name" name="name" type="text" autocomplete="off" data-noise="name"></p>
  <span id="noise-submit-wrap" class="noise-submit-wrap">
    <button type="submit" id="noise-submit" data-noise="submit">提交</button>
    ${blocker}
  </span>
</form>
<p id="noise-status" class="noise-status" role="status"></p>
<p id="noise-chat-reply" class="noise-status" role="status"></p>
<footer class="noise-footer">Obact Lab 干扰层演示页 · <a href="#privacy" data-noise="privacy">隐私政策</a></footer>
</section>
<button type="button" id="noise-chat" class="noise-fab" data-noise="chat">在线客服</button>
${cookie}
<script>${PAGE_JS}</script>`,
    { head: PAGE_STYLE },
  );
}

function entryAdPage(ctx: Ctx): string {
  return page(
    ctx,
    shellModules(),
    '入口广告',
    `<section class="noise-page" data-page="entry-ad">
<h1>入口广告（Entry Ad）</h1>
<p class="noise-lead">每次加载本页，约 0.5 秒后都会弹出一个全屏遮罩广告层；关闭后才能继续操作页面。</p>
<p><button type="button" id="entry-continue" data-noise="continue">继续阅读</button></p>
<p id="entry-result" class="noise-status" role="status"></p>
<p><a href="${esc(ctx.base)}/noise/entry-ad" id="entry-reload">重新加载本页</a></p>
</section>
<script>
  document.getElementById('entry-continue').addEventListener('click', function () {
    document.getElementById('entry-result').textContent = '已继续阅读：正文加载完成。';
  });
</script>`,
    { head: PAGE_STYLE },
  );
}

// ---------------------------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------------------------

const mod: LabModule = {
  name: 'noise',
  title: '干扰层',
  nav: '/noise',

  init(space) {
    space.data.noise = {
      ad_shown: 0,
      ad_closed: 0,
      ad_dismissed: false,
      entry_ad_loads: 0,
      cookie_accepted: false,
      form_submits: 0,
      names: [],
    } satisfies NoiseData;
  },

  routes(r) {
    r.get('/noise', (ctx) => ctx.html(noisePage(ctx)));

    r.get('/noise/entry-ad', (ctx) => {
      dataOf(ctx.space).entry_ad_loads++;
      ctx.html(entryAdPage(ctx));
    });

    r.post('/noise/cookie-accept', (ctx) => {
      dataOf(ctx.space).cookie_accepted = true;
      ctx.space.log.push({ at: new Date().toISOString(), type: 'noise_cookie_accept' });
      ctx.json({ ok: true });
    });

    r.post('/noise/ad-close', (ctx) => {
      const d = dataOf(ctx.space);
      d.ad_closed++;
      d.ad_dismissed = true;
      ctx.space.log.push({ at: new Date().toISOString(), type: 'noise_ad_close' });
      ctx.json({ ok: true });
    });

    r.post(
      '/api/noise/submit',
      async (ctx) => {
        let b: Record<string, unknown>;
        try {
          b = await ctx.body();
        } catch (e) {
          if (e instanceof BodyTooLarge) throw e;
          return ctx.json({ error: 'bad_request' }, 400);
        }
        const name = typeof b.name === 'string' ? b.name.slice(0, MAX_NAME) : '';
        const key = typeof b.key === 'string' && b.key ? b.key.slice(0, MAX_KEY) : undefined;
        const sub = ctx.record(SUBMIT_OP, key, { name });
        const d = dataOf(ctx.space);
        const duplicate = sub.count > 1;
        if (!duplicate) {
          d.form_submits++;
          d.names.push(name);
        }
        ctx.json({ ok: true, key: sub.key, duplicate, form_submits: d.form_submits });
      },
      { commit: true },
    );
  },

  state(space) {
    const d = dataOf(space);
    return { ...d, names: [...d.names] };
  },

  shell(ctx) {
    const d = dataOf(ctx.space);
    const entry = ctx.url.pathname === `${ctx.base}/noise/entry-ad`;
    if (!entry) {
      const rate = ctx.space.faults.popup_rate;
      if (!(rate > 0) || d.ad_dismissed) return '';
      if (!(ctx.space.rng() < rate)) return '';
    }
    d.ad_shown++;
    return adHtml(ctx);
  },
};

export default mod;
