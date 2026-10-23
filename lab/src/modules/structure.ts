/**
 * Obact Lab 模块：复杂结构（PRD 9.3；覆盖 FR-04、FR-06、FR-07，参考 UI Testing Playground 同类场景）。页面都不需要登录。
 *
 * 页面：
 *   GET /structure          主页面（标题“复杂结构”）：同源 iframe（#same-frame）、跨域 iframe（#cross-frame，
 *                           脚本用 location.port 拼出另一个主机名的地址，路径同在本空间下）、嵌套 frame（#nested-frame：
 *                           同源外层 → 跨域内层）、开放 Shadow DOM（lab-profile 内嵌 lab-rating）、封闭 Shadow DOM
 *                           （lab-paybox）、target=_blank 链接与 window.open 按钮、合同表（每行一个同名的“查看”，
 *                           行上有 data-row-key）。表格的 id、哈希类名每次加载都变。
 *                           各操作的结果显示在 #status（role=status）里。
 *   GET /structure/frame    内嵌表单页（?who=same|cross|nested，其余按 same）：邮箱框 + “提交”，提交后 postMessage 给顶层
 *   GET /structure/outer    嵌套外层页：“外层按钮” + 一个跨域 iframe
 *   GET /structure/report   新标签页里的报表（?from=link|open）：“确认收到”
 *   GET /structure/library  用 Shoelace 组件库实现的差旅申请：sl-tab-group 三步（填写 → 选择 → 确认），
 *                           sl-input、sl-select、sl-radio-group、sl-checkbox、sl-dialog、sl-button；
 *                           勾选同意后才能“提交申请”，确认对话框里“确认提交”后页面显示“申请已提交：编号 TR-0001 …”
 *   GET /structure/vendor/shoelace/**   Shoelace 的 cdn 资源（见 structure/vendor.ts，防目录穿越）
 * 接口：
 *   POST /api/structure/event             页面事件上报 {type, detail?, key}（写接口，只记提交记录：同一个键再次到达计数加一）
 *   POST /api/structure/library/submit    差旅申请 {name, email, city, cabin, agree, key}（写接口，记录幂等键）
 *
 * 状态（_lab/state 的 modules.structure）：applications（差旅申请）；页面事件看 _lab/state 的 submissions（op 为 event:<type>）。
 *
 * 随机性：init 不消耗 space.rng()；每次加载 /structure 取一次 rng 作种子派生本次的 id 与类名（见 structure/view.ts）。
 * 改版变体（faults.redesign）：本模块不定义变体，按原版渲染。
 */
import type { LabModule } from '../core.ts';
import { dataOf, initStructure, parseApplication } from './structure/data.ts';
import { vendorRoutes } from './structure/vendor.ts';
import { framePage, indexPage, libraryPage, outerPage, reportPage } from './structure/view.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const mod: LabModule = {
  name: 'structure',
  title: '复杂结构',
  nav: '/structure',

  init: initStructure,

  routes(r) {
    r.get('/structure', (ctx) => ctx.html(indexPage(ctx, mod)));
    r.get('/structure/frame', (ctx) =>
      ctx.html(framePage(ctx, mod, ctx.url.searchParams.get('who'))),
    );
    r.get('/structure/outer', (ctx) => ctx.html(outerPage(ctx, mod)));
    r.get('/structure/report', (ctx) => {
      const from = ctx.url.searchParams.get('from');
      ctx.html(reportPage(ctx, mod, from === 'link' || from === 'open' ? from : 'unknown'));
    });
    r.get('/structure/library', (ctx) => ctx.html(libraryPage(ctx, mod)));

    vendorRoutes(r);

    r.post(
      '/api/structure/event',
      async (ctx) => {
        const b = await ctx.body();
        const type = str(b.type);
        if (!/^\w{1,30}$/.test(type))
          return ctx.json({ error: 'type 必须是 1~30 位的字母数字' }, 400);
        const sub = ctx.record(`event:${type}`, str(b.key) || undefined, b.detail);
        ctx.json({ ok: true, duplicate: sub.count > 1 });
      },
      { commit: true },
    );

    r.post(
      '/api/structure/library/submit',
      async (ctx) => {
        const b = await ctx.body();
        const input = parseApplication(b);
        if ('error' in input) return ctx.json({ error: input.error }, 400);
        const apps = dataOf(ctx.space).applications;
        const app = { id: `TR-${String(apps.length + 1).padStart(4, '0')}`, ...input };
        apps.push(app);
        ctx.record('library_submit', str(b.key) || undefined, { id: app.id });
        ctx.json(app);
      },
      { commit: true },
    );
  },

  state: (space) => ({ applications: dataOf(space).applications }),
};

export default mod;
