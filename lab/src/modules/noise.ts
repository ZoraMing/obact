/**
 * Obact Lab 模块：干扰层（PRD 9.3；覆盖 FR-13、FR-23，BW-7 的 Entry Ad，TS-07 的随机弹窗）。页面都不需要登录。
 * 只保留一种干扰：广告弹窗（全屏半透明遮罩 + 对话框“特别优惠”，含“立即领取”链接和“关闭”按钮）。
 * Cookie 提示条、透明遮挡层、布局偏移由 fixtures 的“遮挡与弹窗”“时序”夹具覆盖。
 *
 * 页面：
 *   GET /noise           干扰层页（标题“干扰层”）：一个“继续阅读”按钮；广告层只在 popup_rate 命中时出现
 *   GET /noise/entry-ad  Entry Ad 页（标题“入口广告”）：每次加载都弹广告，不受 popup_rate 与“已关闭”影响；
 *                        广告没关时点“继续阅读”会被遮挡（BW-7）
 * 接口（不在 /api/ 下，不受故障注入影响：干扰层自身要稳定，被测对象才是代理的应对）：
 *   POST /noise/ad-close 关闭广告（页面里点“关闭”时调用）：关闭次数加一，并且本空间内不再随机弹出
 *
 * 随机广告弹窗（faults.popup_rate，实现在模块的 shell 钩子里，所以 core 的 page() 渲染的任何页面都会带上）：
 *   popup_rate > 0 且本空间还没关过广告时，每个页面按 space.rng() < popup_rate 决定是否输出广告层，
 *   页面加载约 500 毫秒后出现，点“关闭”后移除。关闭记在空间数据里（不是 cookie），所以同一空间换标签页、
 *   换浏览器都不再弹，_lab/reset 后恢复。popup_rate 为 0 或已关闭时不消耗 space.rng()，不影响其他模块的随机序列。
 *   /noise/entry-ad 总是输出广告层（不看 popup_rate，也不看是否关过），并且不会再叠加一个随机弹窗。
 *
 * 状态（_lab/state 的 modules.noise）：ad_shown（输出广告层的次数，含 Entry Ad 页）、ad_closed（点“关闭”的次数）、
 * ad_dismissed（本空间是否已关过广告）、entry_ad_loads（Entry Ad 页的加载次数）。
 *
 * 随机性：init 不消耗 space.rng()。改版变体（faults.redesign）：本模块不定义变体，按原版渲染。
 */
import { type Ctx, esc, type LabModule, page, type Space } from '../core.ts';

/** 广告层在页面加载后多久出现（毫秒）。 */
export const AD_DELAY_MS = 500;

export type NoiseData = {
  ad_shown: number;
  ad_closed: number;
  ad_dismissed: boolean;
  entry_ad_loads: number;
};

export const dataOf = (space: Space): NoiseData => space.data.noise as NoiseData;

const AD_STYLE = `<style>
  .noise-ad { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
  .noise-ad[hidden] { display: none; }
  .noise-ad-box { position: relative; width: 360px; max-width: calc(100vw - 32px); box-sizing: border-box; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
  .noise-ad-box h2 { margin: 0 0 8px; font-size: 22px; color: #b91c1c; }
  .noise-ad-cta { display: inline-block; padding: 6px 14px; background: #dc2626; color: #fff; border-radius: 4px; text-decoration: none; }
  .noise-ad-close { position: absolute; right: 12px; top: 12px; padding: 4px 10px; }
</style>`;

/** 广告层脚本：约 500 毫秒后显示；点“关闭”先通知服务端再移除（通知失败也移除，用户看到的关闭必须生效）。 */
const AD_JS = `(function () {
  var ad = document.getElementById('noise-ad');
  setTimeout(function () { ad.hidden = false; }, Number(ad.getAttribute('data-delay')));
  ad.querySelector('.noise-ad-close').addEventListener('click', function () {
    var done = function () { ad.remove(); };
    fetch(ad.getAttribute('data-base') + '/noise/ad-close', { method: 'POST', keepalive: true }).then(done, done);
  });
})();`;

/** 广告层（初始隐藏，脚本在 AD_DELAY_MS 后显示）。 */
function adHtml(ctx: Ctx): string {
  return `${AD_STYLE}
<div id="noise-ad" class="noise-ad" data-base="${esc(ctx.base)}" data-delay="${AD_DELAY_MS}" hidden>
  <div class="noise-ad-box" role="dialog" aria-modal="true" aria-labelledby="noise-ad-title">
    <h2 id="noise-ad-title">特别优惠</h2>
    <p>新用户注册立减 30 元，仅限今日。</p>
    <a href="#promo" class="noise-ad-cta">立即领取</a>
    <button type="button" class="noise-ad-close">关闭</button>
  </div>
</div>
<script>${AD_JS}</script>`;
}

/** /noise 与 /noise/entry-ad 共用的页面：一个“继续阅读”按钮，点了在提示区显示结果。 */
function noisePage(ctx: Ctx, entry: boolean): string {
  return page(
    ctx,
    [mod],
    entry ? '入口广告' : '干扰层',
    `<section>
<h1>${entry ? '入口广告（Entry Ad）' : '干扰层'}</h1>
<p>${entry ? '每次加载本页，约 0.5 秒后都会弹出全屏遮罩广告；关闭后才能继续操作页面。' : '广告弹窗由故障开关 popup_rate 随机触发，本页没有广告时可以直接操作。'}</p>
<p><button type="button" id="noise-continue">继续阅读</button></p>
<p id="noise-result" role="status"></p>
</section>
<script>
  document.getElementById('noise-continue').addEventListener('click', function () {
    document.getElementById('noise-result').textContent = '已继续阅读：正文加载完成。';
  });
</script>`,
  );
}

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
    } satisfies NoiseData;
  },

  routes(r) {
    r.get('/noise', (ctx) => ctx.html(noisePage(ctx, false)));

    r.get('/noise/entry-ad', (ctx) => {
      dataOf(ctx.space).entry_ad_loads++;
      ctx.html(noisePage(ctx, true));
    });

    r.post('/noise/ad-close', (ctx) => {
      const d = dataOf(ctx.space);
      d.ad_closed++;
      d.ad_dismissed = true;
      ctx.space.log.push({ at: new Date().toISOString(), type: 'noise_ad_close' });
      ctx.json({ ok: true });
    });
  },

  state: (space) => ({ ...dataOf(space) }),

  shell(ctx) {
    const d = dataOf(ctx.space);
    if (ctx.url.pathname !== `${ctx.base}/noise/entry-ad`) {
      const rate = ctx.space.faults.popup_rate;
      if (!(rate > 0) || d.ad_dismissed) return '';
      if (!(ctx.space.rng() < rate)) return '';
    }
    d.ad_shown++;
    return adHtml(ctx);
  },
};

export default mod;
