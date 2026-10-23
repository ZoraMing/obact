/**
 * Obact Lab 模块：大表与数据（PRD 9.3；覆盖 FR-09、FR-10，BW-1、BW-2、BW-10 的前提）。页面和接口都需要登录。
 *
 * 同一份数据（商品行：编号 id、名称、分类、价格、更新日期）的三种呈现，路径都在空间下：
 *   GET /table                 入口页
 *   GET /table/paged?page=N    普通表格，每页 20 行（1000 行 = 50 页）：每行的名称是指向 /table/item/<id> 的详情链接
 *                              （BW-1 的主键），页脚 #pager 里有“下一页”#next，最后一页没有
 *   GET /table/item/:id        详情页（dl#item）
 *   GET /table/virtual         虚拟滚动：滚动容器 #viewport（高 480px），行 .row[data-id] 高 32px，只渲染可见行 ± 3 行，
 *                              滚动时替换 DOM；数据按 100 行一块从 /api/rows 取（所以滚动会产生接口响应，BW-10 的截获用）
 *   GET /table/scroll          无限滚动：滚动容器 #list，加载时取 10 行（/api/rows?offset=0&limit=10），滚到底部再追加 10 行直到取完；
 *                              #status 显示“已加载 n / total 条”，取完变成“已加载全部 total 条”（BW-2 的截获与滚动都用它）
 * 接口：
 *   GET /api/rows              {rows, total}：page&size（默认第 1 页、每页 20）或 offset&limit，出现 offset 或 limit 就按后者；
 *                              size / limit 最大 1000；参数不合法返回 400
 *
 * 数据：行数由 POST _lab/reset 的 {rows: N}（1~20000，默认 1000）决定，内容只由种子决定（模块自带随机序列，
 * 不消耗 space.rng()，行数不同时小的是大的前缀）。价格是整数，页面和接口显示同样的值，对比时不用转换格式。
 * 故障注入沿用 core（delay_ms、error_rate 等对 /api/ 生效），本模块不定义改版变体。
 * 状态（_lab/state 的 modules.bigtable）：total。
 */
import { readFileSync } from 'node:fs';
import { type Ctx, esc, type LabModule, page, type Space, seeded } from '../core.ts';

export type Row = { id: string; name: string; category: string; price: number; updated: string };

const PAGE_SIZE = 20;
const MAX_LIMIT = 1000;
const ROW_H = 32;
const NAMES = ['键盘', '鼠标', '硬盘', '路由器', '摄像头', '耳机'];
const CATEGORIES = ['外设', '存储', '网络', '办公', '音频', '照明'];
const COLUMNS: [keyof Row, string][] = [
  ['id', '编号'],
  ['name', '名称'],
  ['category', '分类'],
  ['price', '价格'],
  ['updated', '更新日期'],
];
const CLIENT_JS = readFileSync(new URL('./bigtable/client.js', import.meta.url), 'utf8');
const STYLE = `<style>
  .row, .head { display: flex; align-items: center; border-bottom: 1px solid #eee; }
  .head { font-weight: bold; background: #f3f4f6; width: 600px; height: ${ROW_H}px; }
  .row span, .head span { flex: none; box-sizing: border-box; width: 100px; padding: 0 8px; overflow: hidden; white-space: nowrap; }
  .row .name, .head .name { width: 200px; }
  #viewport, #list { box-sizing: border-box; width: 600px; overflow-y: auto; border: 1px solid #ddd; }
  #viewport { height: 480px; }
  #spacer { position: relative; }
  #viewport .row { position: absolute; left: 0; right: 0; height: ${ROW_H}px; }
  #list { height: 320px; margin: 0; padding: 0; list-style: none; }
  #list .row { height: 40px; }
</style>`;

const pick = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length)] as T;

/** 按种子生成 n 行：编号 R00001 起递增，其余列来自模块自己的随机序列。 */
function makeRows(seed: number, n: number): Row[] {
  const rng = seeded(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `R${String(i + 1).padStart(5, '0')}`,
    name: `${pick(rng, NAMES)} ${100 + Math.floor(rng() * 900)}`,
    category: pick(rng, CATEGORIES),
    price: 10 + Math.floor(rng() * 9990),
    updated: new Date(Date.UTC(2026, 0, 1 + Math.floor(rng() * 300))).toISOString().slice(0, 10),
  }));
}

const rowsOf = (space: Space) => space.data.bigtable as Row[];

/** 接口分页：返回 [起点, 条数]；参数不合法返回错误说明。 */
function range(p: URLSearchParams): [number, number] | string {
  const num = (name: string, def: number): number => {
    const v = p.get(name);
    return v === null || v === '' ? def : /^\d+$/.test(v) ? Number(v) : Number.NaN;
  };
  const byOffset = p.has('offset') || p.has('limit');
  const size = num(byOffset ? 'limit' : 'size', PAGE_SIZE);
  const start = byOffset ? num('offset', 0) : (num('page', 1) - 1) * size;
  if (size >= 1 && size <= MAX_LIMIT && start >= 0) return [start, size];
  return `size / limit 必须是 1~${MAX_LIMIT} 的整数，offset 不小于 0，page 不小于 1`;
}

const mod: LabModule = {
  name: 'bigtable',
  title: '大表与数据',
  nav: '/table',

  init(space) {
    space.data.bigtable = makeRows(space.seed, space.options.rows ?? 1000);
  },
  resetOptions: { rows: { min: 1, max: 20000 } },

  routes(r) {
    const view = (ctx: Ctx, title: string, body: string, style = '') =>
      ctx.html(page(ctx, [mod], title, `<h1>${esc(title)}</h1>${body}`, { head: style }));
    /** 虚拟滚动与无限滚动共用的脚本：配置在 window.__BT__。 */
    const script = (ctx: Ctx, mode: string) =>
      `<script>window.__BT__ = ${JSON.stringify({ mode, api: `${ctx.base}/api/rows`, total: rowsOf(ctx.space).length, row_h: ROW_H })};</script><script>${CLIENT_JS}</script>`;
    const headCells = (role: string) =>
      COLUMNS.map(([k, label]) => `<span class="${k}"${role}>${label}</span>`).join('');

    r.get(
      '/table',
      (ctx) => {
        const li = (p: string, t: string) => `<li><a href="${ctx.base}/table/${p}">${t}</a></li>`;
        view(
          ctx,
          '大表与数据',
          `<ul>${li('paged', '分页表格')}${li('virtual', '虚拟滚动表格')}${li('scroll', '无限滚动列表')}</ul>`,
        );
      },
      { auth: true },
    );

    r.get(
      '/table/paged',
      (ctx) => {
        const rows = rowsOf(ctx.space);
        const pages = Math.ceil(rows.length / PAGE_SIZE);
        const n = Math.min(pages, Number.parseInt(ctx.url.searchParams.get('page') ?? '', 10) || 1);
        const tr = rows.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE).map((x) => {
          const cell = (k: keyof Row) =>
            k === 'name'
              ? `<a href="${ctx.base}/table/item/${x.id}">${esc(x.name)}</a>`
              : esc(x[k]);
          return `<tr data-id="${x.id}">${COLUMNS.map(([k]) => `<td>${cell(k)}</td>`).join('')}</tr>`;
        });
        const next =
          n < pages
            ? ` <a id="next" rel="next" href="${ctx.base}/table/paged?page=${n + 1}">下一页</a>`
            : '';
        view(
          ctx,
          '商品列表',
          `<table id="rows"><thead><tr>${COLUMNS.map(([, t]) => `<th>${t}</th>`).join('')}</tr></thead><tbody>${tr.join('')}</tbody></table>
<p id="pager">第 ${n} / ${pages} 页，共 ${rows.length} 条${next}</p>`,
        );
      },
      { auth: true },
    );

    r.get(
      '/table/item/:id',
      (ctx) => {
        const id = ctx.params.id as string;
        const x = /^R\d{5}$/.test(id) ? rowsOf(ctx.space)[Number(id.slice(1)) - 1] : undefined;
        if (!x) return ctx.html(page(ctx, [mod], '未找到', '<h1>商品不存在</h1>'), 404);
        const dl = COLUMNS.map(([k, t]) => `<dt>${t}</dt><dd>${esc(x[k])}</dd>`).join('');
        view(ctx, x.name, `<dl id="item">${dl}</dl>`);
      },
      { auth: true },
    );

    r.get(
      '/table/virtual',
      (ctx) => {
        const total = rowsOf(ctx.space).length;
        view(
          ctx,
          '商品大表（虚拟滚动）',
          `<p id="status">共 ${total} 条</p>
<div id="grid" role="grid" aria-rowcount="${total + 1}">
<div class="head" role="row">${headCells(' role="columnheader"')}</div>
<div id="viewport"><div id="spacer" style="height: ${total * ROW_H}px"></div></div>
</div>${script(ctx, 'virtual')}`,
          STYLE,
        );
      },
      { auth: true },
    );

    r.get(
      '/table/scroll',
      (ctx) =>
        view(
          ctx,
          '商品列表（无限滚动）',
          `<p id="status" role="status"></p><div class="head">${headCells('')}</div><ul id="list"></ul>${script(ctx, 'scroll')}`,
          STYLE,
        ),
      { auth: true },
    );

    r.get(
      '/api/rows',
      (ctx) => {
        const rows = rowsOf(ctx.space);
        const got = range(ctx.url.searchParams);
        if (typeof got === 'string') return ctx.json({ error: got }, 400);
        ctx.json({ rows: rows.slice(got[0], got[0] + got[1]), total: rows.length });
      },
      { auth: true },
    );
  },

  state: (space) => ({ total: rowsOf(space).length }),
};

export default mod;
