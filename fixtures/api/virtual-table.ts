/**
 * 虚拟滚动大表夹具的接口（PRD 9.3，FR-09、FR-10）。
 *
 * GET /api/virtual-table/rows?offset=&limit=&seed= → {total, offset, limit, seed, rows}
 * rows 是原始数据：金额是数值（页面显示千分位），状态是代码（页面显示中文）。
 * 每行只由 seed 与行号决定，任意区间都可以直接算出，结果确定。
 */
import type { FixtureHandler } from '../server.ts';

export const TOTAL = 10_000;
/** 单次请求最多返回的行数。 */
export const MAX_LIMIT = 500;

export type VtRow = {
  /** 行号（0 起）。 */
  index: number;
  /** 业务主键，如 R00001。 */
  id: string;
  customer: string;
  city: string;
  /** 金额（元，两位小数）。 */
  amount: number;
  status: 'pending' | 'paid' | 'shipped' | 'done' | 'cancelled';
};

/** 状态代码 → 页面显示的中文。 */
export const STATUS_LABELS: Record<VtRow['status'], string> = {
  pending: '待付款',
  paid: '已付款',
  shipped: '已发货',
  done: '已完成',
  cancelled: '已取消',
};

const SURNAMES = ['张', '王', '李', '赵', '刘', '陈', '杨', '黄', '周', '吴', '徐', '孙'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰', '涛', '明', '超', '霞'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州'];
const STATUSES = Object.keys(STATUS_LABELS) as VtRow['status'][];

/** mulberry32：确定性伪随机数。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;

/** 第 index 行（0 起）。 */
export function rowAt(seed: number, index: number): VtRow {
  const r = rng(Math.imul(seed | 0, 1_000_003) + index * 7919 + 17);
  return {
    index,
    id: `R${String(index + 1).padStart(5, '0')}`,
    customer: pick(r, SURNAMES) + pick(r, GIVEN) + pick(r, GIVEN),
    city: pick(r, CITIES),
    amount: Math.round(r() * 5_000_000) / 100,
    status: pick(r, STATUSES),
  };
}

/** 区间 [offset, offset+limit) 内的行（越界部分截掉）。 */
export function rowsAt(seed: number, offset: number, limit: number): VtRow[] {
  const out: VtRow[] = [];
  for (let i = Math.max(0, offset); i < Math.min(TOTAL, offset + limit); i++)
    out.push(rowAt(seed, i));
  return out;
}

/** 页面上金额的显示：两位小数 + 千分位。 */
export function formatAmount(n: number): string {
  const [int, frac] = Math.abs(n).toFixed(2).split('.') as [string, string];
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

const rows: FixtureHandler = ({ url, json }) => {
  const q = url.searchParams;
  const offset = Number(q.get('offset') ?? 0);
  const limit = Number(q.get('limit') ?? 100);
  const seed = Number(q.get('seed') ?? 1);
  if (![offset, limit, seed].every(Number.isInteger) || offset < 0 || limit < 1) {
    return json({ error: 'offset、limit、seed 必须是整数，offset ≥ 0，limit ≥ 1' }, 400);
  }
  const n = Math.min(limit, MAX_LIMIT);
  json({ total: TOTAL, offset, limit: n, seed, rows: rowsAt(seed, offset, n) });
};

export const routes: Record<string, FixtureHandler> = {
  '/api/virtual-table/rows': rows,
};
