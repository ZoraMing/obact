/**
 * 格式化数字夹具的接口（PRD 9.3，FR-09、FR-10）：页面显示千分位、“1.2万”“3.4亿”、百分比，接口返回原始数值。
 *
 * GET /api/formatted-numbers/data?seed= → {seed, kpis, daily}。
 * 同时导出换算函数，供测试断言“显示值 ↔ 原始值”：formatValue 与页面的格式化逻辑相同；
 * parseDisplay 把显示值还原成数值并给出显示精度（末位的一个单位），|还原值 - 原始值| ≤ step / 2。
 */
import type { FixtureHandler } from '../server.ts';

/** thousands：两位小数 + 千分位；cn：中文单位（不到 1 万用整数千分位，万、亿保留一位小数）；percent：一位小数的百分比。 */
export type NumberFormat = 'thousands' | 'cn' | 'percent';

export type Kpi = { key: string; label: string; value: number; format: NumberFormat };
export type Daily = { date: string; sales: number; visitors: number; conversion: number };

function rng(seed: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) + 0x1234567) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [lo, hi) 内的数，保留 digits 位小数。 */
const between = (r: () => number, lo: number, hi: number, digits = 0) => {
  const k = 10 ** digits;
  return Math.round((lo + r() * (hi - lo)) * k) / k;
};

export function dataFor(seed: number): { seed: number; kpis: Kpi[]; daily: Daily[] } {
  const r = rng(seed);
  const kpis: Kpi[] = [
    {
      key: 'revenue',
      label: '本月营收（元）',
      value: between(r, 1e6, 1e7, 2),
      format: 'thousands',
    },
    { key: 'cost', label: '本月成本（元）', value: between(r, 1e5, 1e6, 2), format: 'thousands' },
    { key: 'refund', label: '退款（元）', value: -between(r, 1e3, 1e5, 2), format: 'thousands' },
    { key: 'orders', label: '订单数', value: between(r, 1000, 9999), format: 'cn' },
    { key: 'users', label: '注册用户', value: between(r, 1e4, 1e5), format: 'cn' },
    { key: 'pv', label: '页面浏览量', value: between(r, 1e8, 9e8), format: 'cn' },
    { key: 'gmv', label: '年度成交额（元）', value: between(r, 1e9, 9e9), format: 'cn' },
    { key: 'conversion', label: '转化率', value: between(r, 0.01, 0.2, 4), format: 'percent' },
    // 固定值：PRD 里的典型写法，与 seed 无关
    { key: 'balance', label: '账户余额（元）', value: 1_234_567.89, format: 'thousands' },
    { key: 'members', label: '会员数', value: 12_345, format: 'cn' },
    { key: 'assets', label: '资产总额（元）', value: 340_123_456, format: 'cn' },
  ];
  const daily: Daily[] = [];
  for (let d = 1; d <= 7; d++) {
    daily.push({
      date: `2026-10-0${d}`,
      sales: between(r, 1e4, 5e6, 2),
      visitors: between(r, 2000, 2e5),
      conversion: between(r, 0.005, 0.15, 4),
    });
  }
  return { seed, kpis, daily };
}

const groups = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 原始值 → 页面显示值（与页面脚本的格式化逻辑一致）。 */
export function formatValue(v: number, format: NumberFormat): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (format === 'percent') return `${(v * 100).toFixed(1)}%`;
  if (format === 'thousands') {
    const [int, frac] = a.toFixed(2).split('.') as [string, string];
    return `${sign}${groups(int)}.${frac}`;
  }
  if (a < 1e4) return `${sign}${groups(String(Math.round(a)))}`;
  const wan = Math.round(a / 1e3) / 10;
  if (wan < 1e4) return `${sign}${wan.toFixed(1)}万`;
  return `${sign}${(Math.round(a / 1e7) / 10).toFixed(1)}亿`;
}

/**
 * 显示值 → 数值与显示精度。支持千分位、万、亿、百分比；不认识的格式返回 null。
 * 例：'1,234,567.89' → {value: 1234567.89, step: 0.01}；'1.2万' → {value: 12000, step: 1000}；
 * '3.4亿' → {value: 340000000, step: 10000000}；'12.5%' → {value: 0.125, step: 0.001}。
 */
export function parseDisplay(text: string): { value: number; step: number } | null {
  const m = text.trim().match(/^(-?)([\d,]+)(?:\.(\d+))?\s*(万|亿|%)?$/);
  if (!m) return null;
  const [, sign, int, frac = '', unit] = m;
  if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(int as string)) return null;
  const scale = unit === '万' ? 1e4 : unit === '亿' ? 1e8 : unit === '%' ? 0.01 : 1;
  const digits = Number(`${(int as string).replace(/,/g, '')}.${frac || '0'}`);
  const value = (sign ? -1 : 1) * digits * scale;
  const step = 10 ** -frac.length * scale;
  return { value, step };
}

const data: FixtureHandler = ({ url, json }) => {
  const seed = Number(url.searchParams.get('seed') ?? 1);
  if (!Number.isInteger(seed)) return json({ error: 'seed 必须是整数' }, 400);
  json(dataFor(seed));
};

export const routes: Record<string, FixtureHandler> = {
  '/api/formatted-numbers/data': data,
};
