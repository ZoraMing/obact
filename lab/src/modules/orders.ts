/**
 * Obact Lab 模块：订单后台（PRD 9.3；覆盖 FR-07、FR-09、FR-16 至 FR-19、FR-25，BW-9、C-4 的前提）。
 *
 * 页面（都需要登录）：
 *   GET  /orders        列表页：筛选（状态、关键字）、排序（点表头）、翻页（每页 20 条）都在浏览器里完成，不改 URL；
 *                       勾选行 → “批量审核” → confirm 对话框 → 提交；每行还有“详情”和“审核”（同名按钮，靠所在行消歧）
 *   GET  /orders/:id    详情页：订单信息，待审核的可填审核意见并审核
 * 接口（需要登录，未登录 401；都受故障注入影响）：
 *   GET  /api/orders              列表（JSON）：status、q、sort、dir、page、page_size（默认第 1 页、每页 20，最大 500）
 *   GET  /api/orders/:id          单条订单
 *   GET  /api/orders/export.csv   导出当前筛选条件下的全部订单：UTF-8 BOM、CRLF、content-disposition: attachment
 *   POST /api/orders/approve      审核 {ids, key?, comment?}（写接口，记录幂等键）：
 *                                 只有“待审核”会变成“已审核”；同一个 key 再次提交只计数、不重复改数据，原样返回首次结果
 *
 * 幂等键：页面在每次审核操作开始时用 crypto.randomUUID() 生成；请求失败或超时（状态未明）后重试沿用同一个键；
 * 成功或明确失败（4xx）后下一次操作换新键。服务端对账看 _lab/state 里的 submissions（同一个键的 count 大于 1 即重复提交）。
 *
 * 故障注入：commit_timeout 时审核照常落库并记录，但不返回响应（C-4 的前提）；error_rate 等让页面给出可见的错误提示。
 * 改版变体（faults.redesign）：1 改 id 与类名，2 改按钮文案，3 表格改卡片列表，4 起三项叠加；见 orders/view.ts。
 *
 * 随机性：init 用 space.rng() 生成 200 条订单（顺序固定：订单号递增、下单时间递增）。
 * 注意 rng 是各模块共用的序列，前面的模块（按文件名排序，auth 在最前）如果也消耗它，这里的数据会随之变化；
 * 所以测试都不写死具体订单，只和接口、状态对账。
 */
import type { LabModule } from '../core.ts';
import {
  approveOrders,
  initOrders,
  ordersCsv,
  ordersOf,
  parsePaging,
  parseQuery,
  queryOrders,
  STATUSES,
} from './orders/data.ts';
import { detailPage, listPage, notFoundPage } from './orders/view.ts';

const MAX_IDS = 500;
const MAX_COMMENT = 200;

const mod: LabModule = {
  name: 'orders',
  title: '订单后台',
  nav: '/orders',

  init: initOrders,

  routes(r) {
    r.get('/orders', (ctx) => ctx.html(listPage(ctx, mod)), { auth: true });

    r.get(
      '/orders/:id',
      (ctx) => {
        const o = ordersOf(ctx.space).byId.get(ctx.params.id as string);
        if (!o) return ctx.html(notFoundPage(ctx, mod, ctx.params.id as string), 404);
        ctx.html(detailPage(ctx, mod, o));
      },
      { auth: true },
    );

    r.get(
      '/api/orders',
      (ctx) => {
        const q = parseQuery(ctx.url.searchParams);
        if ('error' in q) return ctx.json({ error: q.error }, 400);
        const p = parsePaging(ctx.url.searchParams);
        if ('error' in p) return ctx.json({ error: p.error }, 400);
        const rows = queryOrders(ordersOf(ctx.space).orders, q);
        const start = (p.page - 1) * p.page_size;
        ctx.json({
          total: rows.length,
          page: p.page,
          page_size: p.page_size,
          pages: Math.max(1, Math.ceil(rows.length / p.page_size)),
          items: rows.slice(start, start + p.page_size),
        });
      },
      { auth: true },
    );

    // 要排在 /api/orders/:id 之前
    r.get(
      '/api/orders/export.csv',
      (ctx) => {
        const q = parseQuery(ctx.url.searchParams);
        if ('error' in q) return ctx.json({ error: q.error }, 400);
        const body = Buffer.from(ordersCsv(queryOrders(ordersOf(ctx.space).orders, q)), 'utf8');
        ctx.res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="orders.csv"',
          'content-length': String(body.length),
          'cache-control': 'no-store',
        });
        ctx.res.end(body);
      },
      { auth: true },
    );

    r.get(
      '/api/orders/:id',
      (ctx) => {
        const o = ordersOf(ctx.space).byId.get(ctx.params.id as string);
        if (!o) return ctx.json({ error: 'not_found' }, 404);
        ctx.json(o);
      },
      { auth: true },
    );

    r.post(
      '/api/orders/approve',
      async (ctx) => {
        const b = await ctx.body();
        const ids = b.ids;
        if (
          !Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > MAX_IDS ||
          !ids.every((x) => typeof x === 'string' && x !== '')
        ) {
          return ctx.json({ error: `ids 必须是 1 ~ ${MAX_IDS} 个订单号组成的数组` }, 400);
        }
        const key = typeof b.key === 'string' && b.key !== '' ? b.key : null;
        const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
        if (comment.length > MAX_COMMENT) {
          return ctx.json({ error: `comment 最长 ${MAX_COMMENT} 个字` }, 400);
        }
        const data = ordersOf(ctx.space);
        const prior = key ? data.results.get(key) : undefined;
        if (prior) {
          // 同一个幂等键再次到达：只计数，不重复改数据，原样返回首次的结果
          ctx.record('approve', key as string, { ids });
          return ctx.json({ ...prior, duplicate: true });
        }
        const result = approveOrders(data, ids as string[], key, comment);
        if (key) data.results.set(key, result);
        ctx.record('approve', key ?? undefined, { ids });
        ctx.json(result);
      },
      { auth: true, commit: true },
    );
  },

  state(space) {
    const d = ordersOf(space);
    const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const comments: Record<string, string> = {};
    for (const o of d.orders) {
      counts[o.status] = (counts[o.status] ?? 0) + 1;
      if (o.comment) comments[o.id] = o.comment;
    }
    return {
      total: d.orders.length,
      counts,
      approved_ids: d.orders.filter((o) => o.status === '已审核').map((o) => o.id),
      /** 通过审核接口改过状态的订单号（按改动先后），对账“清单外没有被改动”用。 */
      changed_ids: [...d.changed],
      comments,
    };
  },
};

export default mod;
