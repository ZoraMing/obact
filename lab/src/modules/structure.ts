/**
 * Obact Lab 模块：复杂结构（PRD 9.3；覆盖 FR-04、FR-06、FR-07，参考 UI Testing Playground 同类场景）。页面都不需要登录。
 *
 * 页面：
 *   GET /structure          主页面（标题“复杂结构”）：同源 iframe（#same-frame）、跨域 iframe（#cross-frame，
 *                           脚本用 location.port 拼出另一个主机名的地址，路径同在本空间下）、嵌套 frame（#nested-frame：
 *                           同源外层 → 跨域内层）、Shadow Root 里的 iframe、开放 Shadow DOM（lab-profile 内嵌 lab-rating）、
 *                           封闭 Shadow DOM（lab-paybox）、target=_blank 链接与 window.open 按钮、合同表（每行一个同名的“查看”，
 *                           行上有 data-row-key）、审批单（“保存草稿”“提交审批”）。表格和审批单的 id、哈希类名每次加载都变。
 *   GET /structure/frame    内嵌表单页（?who=same|cross|nested|shadow）：邮箱框 + “提交”，提交后 postMessage 给顶层
 *   GET /structure/outer    嵌套外层页：“外层按钮” + 一个跨域 iframe（?who=nested）
 *   GET /structure/report   新标签页里的报表（?from=link|open）：“确认收到”
 *   GET /structure/library  用 Shoelace 组件库实现的差旅申请：sl-tab-group 三步（填写 → 选择 → 确认），
 *                           sl-input、sl-select、sl-dropdown、sl-radio-group、sl-checkbox、sl-switch、sl-dialog、sl-alert、sl-button；
 *                           勾选同意后才能“提交申请”，确认对话框里“确认提交”后页面显示“申请已提交：编号 TR-0001 …”
 *                           ?tab=info|choose|confirm 直接打开某一步（录制回放、测试用）
 *   GET /structure/vendor/shoelace/**   Shoelace 的 cdn 资源（见 structure/vendor.ts，防目录穿越）
 * 页面就绪标记（供条件等待）：/structure 的 <body data-structure-ready="1"> 表示脚本就绪，<html data-frames-ready="4">
 * 表示四个框架（same、cross、nested、shadow）都加载完；/structure/library 的 <body data-sl-ready="1"> 表示 Shoelace 组件都已定义并升级完成。
 * 接口：
 *   POST /api/structure/event             页面事件上报 {type, detail?, key}（写接口，记录幂等键；同一个键只计一次）
 *   POST /api/structure/library/submit    差旅申请 {name, email, city, transport, cabin, hotel, agree, key}
 *                                         （写接口，记录幂等键；同一个键再次提交只计数，原样返回首次的申请）
 *
 * 状态（_lab/state 的 modules.structure）：events 累计、各 frame 提交次数、点过“查看”的合同号、差旅申请、页面加载次数。
 *
 * 随机性：init 不消耗 space.rng()；每次加载 /structure 取一次 rng 作种子派生本次的 id 与类名（见 structure/view.ts）。
 * 改版变体（faults.redesign）：本模块不定义变体，按原版渲染。
 * 页面的前端脚本在 structure/*.js，页面骨架在 structure/view.ts。
 */
import type { LabModule } from '../core.ts';
import {
  applyEvent,
  dataOf,
  initStructure,
  parseApplication,
  parseEvent,
  WHOS,
  type Who,
} from './structure/data.ts';
import { vendorRoutes } from './structure/vendor.ts';
import { framePage, indexPage, libraryPage, outerPage, reportPage } from './structure/view.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const mod: LabModule = {
  name: 'structure',
  title: '复杂结构',
  nav: '/structure',

  init: initStructure,

  routes(r) {
    r.get('/structure', (ctx) => {
      dataOf(ctx.space).loads.index++;
      ctx.html(indexPage(ctx, mod));
    });

    r.get('/structure/frame', (ctx) => {
      const who = ctx.url.searchParams.get('who') ?? 'same';
      ctx.html(
        framePage(ctx, mod, (WHOS as readonly string[]).includes(who) ? (who as Who) : 'same'),
      );
    });

    r.get('/structure/outer', (ctx) => ctx.html(outerPage(ctx, mod)));

    r.get('/structure/report', (ctx) => {
      const from = ctx.url.searchParams.get('from');
      ctx.html(reportPage(ctx, mod, from === 'link' || from === 'open' ? from : 'unknown'));
    });

    r.get('/structure/library', (ctx) => {
      dataOf(ctx.space).loads.library++;
      ctx.html(libraryPage(ctx, mod));
    });

    vendorRoutes(r);

    r.post(
      '/api/structure/event',
      async (ctx) => {
        const b = await ctx.body();
        const ev = parseEvent(b);
        if ('error' in ev) return ctx.json({ error: ev.error }, 400);
        const key = str(b.key) || undefined;
        const sub = ctx.record(`event:${ev.type}`, key, ev.detail);
        // 同一个幂等键再次到达（重试）只计数，不重复记账
        if (sub.count === 1) applyEvent(dataOf(ctx.space), sub.key, ev.type, ev.detail);
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
        const data = dataOf(ctx.space);
        const key = str(b.key) || undefined;
        const prior = key ? data.applied.get(key) : undefined;
        if (prior) {
          ctx.record('library_submit', key, { id: prior.id });
          return ctx.json({ ...prior, duplicate: true });
        }
        const app = {
          id: `TR-${String(data.applications.length + 1).padStart(4, '0')}`,
          ...input,
          key: key ?? '',
        };
        data.applications.push(app);
        const sub = ctx.record('library_submit', key, { id: app.id });
        app.key = sub.key;
        data.applied.set(sub.key, app);
        ctx.json(app);
      },
      { commit: true },
    );
  },

  state(space) {
    const d = dataOf(space);
    return {
      counts: d.counts,
      views: d.views,
      frames: d.frames,
      events: d.events,
      applications: d.applications,
      loads: d.loads,
    };
  },
};

export default mod;
