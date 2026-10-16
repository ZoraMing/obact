/**
 * 订单后台的页面：列表页、详情页，以及改版变体（faults.redesign）。
 *
 * 页面骨架由服务端渲染，列表内容、筛选、排序、翻页和批量审核由 client.js 在浏览器里完成
 * （不改 URL；数据来自 /api/orders）。客户端脚本不写死 id、类名和文案，一律读服务端注入的 window.__ORDERS__，
 * 所以改版变体只需要改这里的取值表。
 *
 * 改版变体（每个变体只改一个方面，4 起为三项叠加的“全面改版”）：
 *   1 改 id 与类名：所有 id、类名换成带哈希的新名字，角色和文案不变
 *   2 改按钮文案：“批量审核”→“审核所选”、“查询”→“搜索”、行内“审核”→“通过”等，id 与类名不变
 *   3 改层级：表格改成卡片列表，没有表头和全选框，排序改用下拉框 + 方向按钮
 */
import { readFileSync } from 'node:fs';
import { type Ctx, esc, type LabModule, page } from '../../core.ts';
import { type Order, SORT_KEYS, STATUSES } from './data.ts';

const CLIENT_JS = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

export type ViewIds = {
  form: string;
  status: string;
  keyword: string;
  search: string;
  reset: string;
  batch: string;
  export: string;
  selected: string;
  msg: string;
  err: string;
  summary: string;
  list: string;
  table: string;
  all: string;
  pager: string;
  sortField: string;
  sortDir: string;
  /** 详情页。 */
  state: string;
  comment: string;
  approve: string;
  actions: string;
};

export type ViewCls = {
  sort: string;
  row: string;
  check: string;
  approve: string;
  badge: string;
  page: string;
  card: string;
  num: string;
};

export type ViewText = {
  statusLabel: string;
  keywordLabel: string;
  keywordPlaceholder: string;
  search: string;
  reset: string;
  batch: string;
  export: string;
  rowApprove: string;
  detail: string;
  prev: string;
  next: string;
  reload: string;
  retry: string;
  detailApprove: string;
  commentLabel: string;
  confirmBatch: string;
  confirmRow: string;
  confirmDetail: string;
};

export type View = { ids: ViewIds; cls: ViewCls; text: ViewText; cards: boolean };

const IDS: ViewIds = {
  form: 'order-filters',
  status: 'status-filter',
  keyword: 'keyword',
  search: 'btn-search',
  reset: 'btn-reset',
  batch: 'btn-batch',
  export: 'link-export',
  selected: 'selected-count',
  msg: 'msg',
  err: 'err',
  summary: 'summary',
  list: 'order-list',
  table: 'order-table',
  all: 'check-all',
  pager: 'pager',
  sortField: 'sort-field',
  sortDir: 'sort-dir',
  state: 'order-status',
  comment: 'order-comment',
  approve: 'btn-approve',
  actions: 'order-actions',
};

const IDS_V1: ViewIds = {
  form: 'f_3b7e',
  status: 'sel_a91c',
  keyword: 'inp_52d0',
  search: 'go_c8e4',
  reset: 'rst_1f6a',
  batch: 'bulk_d73b',
  export: 'dl_90ae',
  selected: 'cnt_e2c5',
  msg: 'ok_4a18',
  err: 'bad_77fd',
  summary: 'sum_0b69',
  list: 'lst_6c3d',
  table: 'tbl_f4a2',
  all: 'all_8d51',
  pager: 'pg_b3e7',
  sortField: 'sf_2e90',
  sortDir: 'sd_a5c6',
  state: 'st_19db',
  comment: 'cm_e7f3',
  approve: 'ap_53a0',
  actions: 'ac_c1d8',
};

const CLS: ViewCls = {
  sort: 'sort-btn',
  row: 'order-row',
  check: 'row-check',
  approve: 'row-approve',
  badge: 'badge',
  page: 'page-btn',
  card: 'order-card',
  num: 'num',
};

const CLS_V1: ViewCls = {
  sort: 'x9f3-th',
  row: 'x2a7-tr',
  check: 'x41c8-ck',
  approve: 'x7be0-op',
  badge: 'x5d19-tag',
  page: 'x0c6e-pg',
  card: 'x83fa-cd',
  num: 'x6a52-n',
};

const TEXT: ViewText = {
  statusLabel: '状态',
  keywordLabel: '关键字',
  keywordPlaceholder: '订单号或客户名称',
  search: '查询',
  reset: '重置',
  batch: '批量审核',
  export: '导出 CSV',
  rowApprove: '审核',
  detail: '详情',
  prev: '上一页',
  next: '下一页',
  reload: '重新加载',
  retry: '重试提交',
  detailApprove: '审核通过',
  commentLabel: '审核意见',
  confirmBatch: '确认批量审核选中的 {n} 条订单？',
  confirmRow: '确认审核订单 {id}？',
  confirmDetail: '确认审核通过订单 {id}？',
};

const TEXT_V2: ViewText = {
  statusLabel: '订单状态',
  keywordLabel: '搜索词',
  keywordPlaceholder: '输入订单号或客户',
  search: '搜索',
  reset: '清空条件',
  batch: '审核所选',
  export: '下载 CSV',
  rowApprove: '通过',
  detail: '查看',
  prev: '上页',
  next: '下页',
  reload: '刷新',
  retry: '再次提交',
  detailApprove: '同意',
  commentLabel: '备注',
  confirmBatch: '确认审核所选的 {n} 条订单吗？',
  confirmRow: '确认通过订单 {id} 吗？',
  confirmDetail: '确认同意订单 {id} 吗？',
};

/** 按改版编号取页面的 id、类名、文案和结构。 */
export function viewOf(redesign: number): View {
  const r = Number(redesign) || 0;
  const all = r >= 4;
  return {
    ids: r === 1 || all ? IDS_V1 : IDS,
    cls: r === 1 || all ? CLS_V1 : CLS,
    text: r === 2 || all ? TEXT_V2 : TEXT,
    cards: r === 3 || all,
  };
}

const SORT_LABELS: Record<(typeof SORT_KEYS)[number], string> = {
  id: '订单号',
  customer: '客户',
  amount: '金额',
  status: '状态',
  region: '地区',
  created_at: '下单时间',
};

const STYLE = `<style>
  .o-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  .o-filters input[type=search] { padding: 4px 6px; width: 200px; }
  .o-actions { display: flex; gap: 12px; align-items: center; margin: 8px 0; }
  .o-actions a { color: #1d4ed8; }
  .o-msg { min-height: 26px; margin: 6px 0; }
  .o-ok { color: #15803d; }
  .o-bad { color: #b91c1c; border: 1px solid #fca5a5; background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
  .o-summary { color: #555; margin: 6px 0; }
  .o-list { min-height: 120px; }
  .o-list table { width: 100%; }
  .o-list th button { all: unset; cursor: pointer; font-weight: 600; }
  .o-list th button:focus-visible { outline: 2px solid #1d4ed8; }
  /* 排序箭头用伪元素画（备用文字为空，不进入按钮的可访问名称），状态由 aria-sort 表达 */
  .o-list th[aria-sort=ascending] button::after { content: ' ▲' / ''; }
  .o-list th[aria-sort=descending] button::after { content: ' ▼' / ''; }
  .o-list td.num, .o-list th.num { text-align: right; }
  .o-list td.ops { white-space: nowrap; }
  .o-list td.ops a { margin-right: 8px; }
  .o-empty { padding: 24px; color: #777; text-align: center; }
  .badge { padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .st-0 { background: #fef3c7; color: #92400e; }
  .st-1 { background: #dcfce7; color: #166534; }
  .st-2 { background: #fee2e2; color: #991b1b; }
  .cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .cards li { border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; }
  .cards .card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .cards dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  .cards dt { color: #777; }
  .cards dd { margin: 0; }
  .cards .ops { margin-top: 8px; display: flex; gap: 8px; align-items: center; }
  .o-pager { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  .o-pager button[aria-current=page] { font-weight: 700; background: #dbeafe; }
  .o-detail dl { display: grid; grid-template-columns: 6em 1fr; gap: 6px 12px; max-width: 480px; }
  .o-detail dt { color: #777; }
  .o-detail dd { margin: 0; }
  .o-detail .field { margin: 6px 0; }
  .o-detail textarea { width: 320px; height: 60px; vertical-align: top; }
</style>`;

/** 注入给 client.js 的配置；< 转成 <，避免提前结束 script 标签。 */
function configScript(cfg: unknown): string {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>window.__ORDERS__ = ${json};</script>\n<script>${CLIENT_JS}</script>`;
}

const statusOptions = (all: string): string =>
  `<option value="">${esc(all)}</option>${STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}`;

/** 列表页。 */
export function listPage(ctx: Ctx, self: LabModule): string {
  const v = viewOf(ctx.space.faults.redesign);
  const { ids: i, text: t } = v;
  const sorter = v.cards
    ? `<div class="o-actions">
  <label for="${i.sortField}">排序方式</label>
  <select id="${i.sortField}">${SORT_KEYS.map((k) => `<option value="${k}">${SORT_LABELS[k]}</option>`).join('')}</select>
  <button type="button" id="${i.sortDir}">降序</button>
</div>`
    : '';
  const body = `<section data-page="orders">
<h1>订单后台</h1>
<form id="${i.form}" class="o-filters" role="search" aria-label="订单筛选">
  <label for="${i.status}">${esc(t.statusLabel)}</label>
  <select id="${i.status}" name="status">${statusOptions('全部')}</select>
  <label for="${i.keyword}">${esc(t.keywordLabel)}</label>
  <input id="${i.keyword}" name="q" type="search" placeholder="${esc(t.keywordPlaceholder)}" autocomplete="off">
  <button type="submit" id="${i.search}">${esc(t.search)}</button>
  <button type="button" id="${i.reset}">${esc(t.reset)}</button>
</form>
<div class="o-actions">
  <button type="button" id="${i.batch}" disabled>${esc(t.batch)}</button>
  <a id="${i.export}" href="${ctx.base}/api/orders/export.csv" download="orders.csv">${esc(t.export)}</a>
  <span id="${i.selected}">已选 0 条</span>
</div>
${sorter}
<div id="${i.msg}" class="o-msg o-ok" role="status" aria-live="polite"></div>
<div id="${i.err}" class="o-msg o-bad" role="alert" hidden></div>
<div id="${i.summary}" class="o-summary">加载中…</div>
<div id="${i.list}" class="o-list"></div>
<nav id="${i.pager}" class="o-pager" aria-label="分页"></nav>
</section>
${configScript({
  mode: 'list',
  api: `${ctx.base}/api/orders`,
  base: ctx.base,
  login: `${ctx.base}/login?next=${encodeURIComponent('/orders')}`,
  ...v,
})}`;
  return page(ctx, [self], '订单后台', body, { head: STYLE });
}

const badgeClass = (o: Order): string => `st-${STATUSES.indexOf(o.status)}`;

/** 详情页；订单不存在时由调用方给 404。 */
export function detailPage(ctx: Ctx, self: LabModule, o: Order): string {
  const v = viewOf(ctx.space.faults.redesign);
  const { ids: i, cls: c, text: t } = v;
  const amount = o.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const fields: [string, string][] = [
    ['订单号', esc(o.id)],
    ['客户', esc(o.customer)],
    ['金额', `¥${amount}`],
    ['状态', `<span id="${i.state}" class="${c.badge} ${badgeClass(o)}">${o.status}</span>`],
    ['地区', esc(o.region)],
    ['下单时间', esc(o.created_at)],
    ['审核意见', o.comment ? esc(o.comment) : '（无）'],
  ];
  // 改版 3（改层级）：键值对不用 dl，改成多套一层的区块
  const info = v.cards
    ? `<div class="o-detail-card">${fields.map(([k, val]) => `<div class="field"><div><strong>${k}</strong></div><div>${val}</div></div>`).join('')}</div>`
    : `<dl>${fields.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`;
  const actions =
    o.status === '待审核'
      ? `<div id="${i.actions}" class="field">
  <p><label for="${i.comment}">${esc(t.commentLabel)}</label> <textarea id="${i.comment}" maxlength="200" placeholder="可不填"></textarea></p>
  <p><button type="button" id="${i.approve}">${esc(t.detailApprove)}</button></p>
</div>`
      : `<p id="${i.actions}">${o.status === '已审核' ? '该订单已审核。' : '该订单已驳回，不能审核。'}</p>`;
  const body = `<section class="o-detail" data-page="order-detail" data-order-id="${esc(o.id)}">
<h1>订单 ${esc(o.id)}</h1>
<p><a href="${ctx.base}/orders">返回订单列表</a></p>
${info}
<div id="${i.msg}" class="o-msg o-ok" role="status" aria-live="polite"></div>
<div id="${i.err}" class="o-msg o-bad" role="alert" hidden></div>
${actions}
</section>
${configScript({
  mode: 'detail',
  api: `${ctx.base}/api/orders`,
  base: ctx.base,
  login: `${ctx.base}/login?next=${encodeURIComponent(`/orders/${o.id}`)}`,
  orderId: o.id,
  ...v,
})}`;
  return page(ctx, [self], `订单 ${o.id}`, body, { head: STYLE });
}

export function notFoundPage(ctx: Ctx, self: LabModule, id: string): string {
  return page(
    ctx,
    [self],
    '订单不存在',
    `<section data-page="order-missing"><h1>订单不存在</h1><p>没有订单号为 ${esc(id)} 的订单。</p><p><a href="${ctx.base}/orders">返回订单列表</a></p></section>`,
    { head: STYLE },
  );
}
