/**
 * 时序夹具的接口：慢接口（骨架屏之后才返回的订单数据）。
 * GET /api/timing/orders?delay=700 → 延时 delay 毫秒（0～5000）后返回固定的订单列表。
 */
import type { FixtureHandler } from '../server.ts';

const ORDERS = [
  { no: 'SO-31001', customer: '华东仓储', amount: 12800 },
  { no: 'SO-31002', customer: '星河贸易', amount: 3560.5 },
  { no: 'SO-31003', customer: '北辰科技', amount: 980 },
];

export const routes: Record<string, FixtureHandler> = {
  '/api/timing/orders': async ({ url, json }) => {
    const delay = Math.min(5000, Math.max(0, Number(url.searchParams.get('delay') ?? 700) || 0));
    await new Promise((resolve) => setTimeout(resolve, delay));
    json({ orders: ORDERS });
  },
};
