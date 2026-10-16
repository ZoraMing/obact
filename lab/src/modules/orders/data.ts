/**
 * 订单后台的数据与查询逻辑（与页面无关）：确定性生成 200 条订单、筛选、排序、分页、CSV。
 *
 * 排序规则要和页面里的前端排序（client.js）完全一致，测试会比较两边的结果：
 *   - 金额按数值，状态按“待审核、已审核、已驳回”的顺序，其余按字符串码点比较；
 *   - 键值相同的按订单号升序（不随排序方向翻转），所以结果是确定的。
 */
import type { Space } from '../../core.ts';

export const STATUSES = ['待审核', '已审核', '已驳回'] as const;
export type Status = (typeof STATUSES)[number];

export const SORT_KEYS = ['id', 'customer', 'amount', 'status', 'region', 'created_at'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type Order = {
  /** 订单号（5 位数字，同一个空间内唯一、随下单时间递增）。 */
  id: string;
  customer: string;
  /** 金额（元，两位小数，接口返回原始数值；页面显示千分位）。 */
  amount: number;
  status: Status;
  region: string;
  /** 下单时间：YYYY-MM-DD HH:mm（固定按 UTC 书写，不随运行环境的时区变化）。 */
  created_at: string;
  /** 审核意见（批量审核时可带）。 */
  comment: string;
};

export type ApproveResult = {
  ok: true;
  key: string | null;
  /** 本次真正变为“已审核”的订单号。 */
  approved: number;
  approved_ids: string[];
  /** 被跳过的订单：不存在、已经审核过、已驳回（不能直接审核）。 */
  skipped: { id: string; reason: 'not_found' | 'already_approved' | 'rejected' }[];
};

export type OrdersData = {
  orders: Order[];
  /** 订单号 → 订单，便于按主键取。 */
  byId: Map<string, Order>;
  /** 幂等键 → 首次处理的结果；同一个键再次提交时原样返回，不再改数据。 */
  results: Map<string, ApproveResult>;
  /** 通过审核接口改过状态的订单号（按改动先后）。 */
  changed: string[];
};

export const ORDER_COUNT = 200;
export const PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 500;
export const REGIONS = ['华北', '华东', '华南', '华中', '西南', '西北', '东北'] as const;

/** 客户名里故意带逗号、引号和英文，覆盖 CSV 转义与 HTML 转义。 */
export const CUSTOMERS = [
  '北辰贸易有限公司',
  '星河科技有限公司',
  '云岭农业合作社',
  '海岳物流集团',
  '鼎盛建材商行',
  '锦绣服饰有限公司',
  '远航电子科技',
  '青禾食品有限公司',
  '博雅教育咨询',
  '恒通机械制造厂',
  '听雨轩茶业',
  '三联医药批发',
  '新桥五金交电',
  '瑞丰能源有限公司',
  '盛世文化传媒',
  '天工精密仪器',
  'Orion Trading, Ltd.',
  '老张"鲜果"批发部',
  'Nova Retail Co.',
  '金桥国际贸易（深圳）有限公司',
] as const;

const pick = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length)] as T;

const pad = (n: number): string => String(n).padStart(2, '0');

/** UTC 毫秒时间戳 → YYYY-MM-DD HH:mm。 */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 按随机数序列生成订单：同一个随机序列得到同样的 200 条。 */
export function generateOrders(rng: () => number, count = ORDER_COUNT): Order[] {
  const out: Order[] = [];
  let no = 88000;
  let at = Date.UTC(2026, 0, 5, 8, 0);
  for (let i = 0; i < count; i++) {
    no += 1 + Math.floor(rng() * 4);
    at += (30 + Math.floor(rng() * 600)) * 60_000;
    const r = rng();
    out.push({
      id: String(no),
      customer: pick(rng, CUSTOMERS),
      amount: Math.round((80 + rng() * rng() * 49_920) * 100) / 100,
      status: r < 0.62 ? '待审核' : r < 0.9 ? '已审核' : '已驳回',
      region: pick(rng, REGIONS),
      created_at: fmtTime(at),
      comment: '',
    });
  }
  return out;
}

export function ordersOf(space: Space): OrdersData {
  return space.data.orders as OrdersData;
}

export function initOrders(space: Space): void {
  const orders = generateOrders(space.rng);
  const data: OrdersData = {
    orders,
    byId: new Map(orders.map((o) => [o.id, o])),
    results: new Map(),
    changed: [],
  };
  space.data.orders = data;
}

export type Query = {
  status: Status | '';
  q: string;
  sort: SortKey;
  dir: 'asc' | 'desc';
};

export const DEFAULT_QUERY: Query = { status: '', q: '', sort: 'created_at', dir: 'desc' };

/** 从 URL 参数解析查询条件；非法值返回错误说明。 */
export function parseQuery(p: URLSearchParams): Query | { error: string } {
  const status = p.get('status') ?? '';
  if (status !== '' && status !== 'all' && !(STATUSES as readonly string[]).includes(status)) {
    return { error: `status 只能是 ${STATUSES.join('、')} 或留空` };
  }
  const sort = p.get('sort') ?? DEFAULT_QUERY.sort;
  if (!(SORT_KEYS as readonly string[]).includes(sort)) {
    return { error: `sort 只能是 ${SORT_KEYS.join('、')}` };
  }
  const dir = p.get('dir') ?? DEFAULT_QUERY.dir;
  if (dir !== 'asc' && dir !== 'desc') return { error: 'dir 只能是 asc 或 desc' };
  return {
    status: status === 'all' ? '' : (status as Status | ''),
    q: (p.get('q') ?? '').trim(),
    sort: sort as SortKey,
    dir,
  };
}

/** 页码参数：缺省为第 1 页、每页 20 条；page_size 最大 500。 */
export function parsePaging(
  p: URLSearchParams,
): { page: number; page_size: number } | { error: string } {
  const num = (name: string, def: number): number | null => {
    const v = p.get(name);
    if (v === null || v === '') return def;
    return /^\d+$/.test(v) && Number(v) >= 1 ? Number(v) : null;
  };
  const page = num('page', 1);
  const size = num('page_size', PAGE_SIZE);
  if (page === null) return { error: 'page 必须是正整数' };
  if (size === null || size > MAX_PAGE_SIZE) {
    return { error: `page_size 必须是 1 ~ ${MAX_PAGE_SIZE} 的整数` };
  }
  return { page, page_size: size };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rank = (s: Status): number => STATUSES.indexOf(s);

function compareBy(key: SortKey, a: Order, b: Order): number {
  switch (key) {
    case 'amount':
      return a.amount - b.amount;
    case 'status':
      return rank(a.status) - rank(b.status);
    default:
      return cmp(a[key], b[key]);
  }
}

/** 筛选（状态精确匹配；关键字不分大小写，匹配订单号或客户名）并排序。 */
export function queryOrders(orders: readonly Order[], q: Query): Order[] {
  const kw = q.q.toLowerCase();
  const rows = orders.filter(
    (o) =>
      (q.status === '' || o.status === q.status) &&
      (kw === '' || o.id.includes(kw) || o.customer.toLowerCase().includes(kw)),
  );
  const sign = q.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => sign * compareBy(q.sort, a, b) || cmp(a.id, b.id));
}

export const CSV_HEADER = ['订单号', '客户', '金额', '状态', '地区', '下单时间'] as const;

/** RFC 4180：含逗号、引号、换行的字段加引号，引号写两次。 */
export function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出的 CSV 一行：金额是原始数值（两位小数，不带千分位）。 */
export function csvRow(o: Order): string[] {
  return [o.id, o.customer, o.amount.toFixed(2), o.status, o.region, o.created_at];
}

/** 完整的 CSV 文本：UTF-8 BOM、CRLF 换行、末尾有换行。 */
export function ordersCsv(rows: readonly Order[]): string {
  const lines = [CSV_HEADER as readonly string[], ...rows.map(csvRow)].map((r) =>
    r.map(csvField).join(','),
  );
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 执行审核：只有“待审核”会变为“已审核”；已审核、已驳回、不存在的订单跳过并说明原因。 */
export function approveOrders(
  data: OrdersData,
  ids: readonly string[],
  key: string | null,
  comment: string,
): ApproveResult {
  const approvedIds: string[] = [];
  const skipped: ApproveResult['skipped'] = [];
  for (const id of new Set(ids)) {
    const o = data.byId.get(id);
    if (!o) skipped.push({ id, reason: 'not_found' });
    else if (o.status === '已审核') skipped.push({ id, reason: 'already_approved' });
    else if (o.status === '已驳回') skipped.push({ id, reason: 'rejected' });
    else {
      o.status = '已审核';
      if (comment) o.comment = comment;
      approvedIds.push(id);
      data.changed.push(id);
    }
  }
  return { ok: true, key, approved: approvedIds.length, approved_ids: approvedIds, skipped };
}
