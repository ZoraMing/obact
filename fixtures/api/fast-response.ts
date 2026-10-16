/**
 * 快速响应夹具的接口（PRD 9.3，FR-10：验证不会错过响应）。
 *
 * GET /api/fast-response/data?n=&seed=&delay= → 约 delay 毫秒（默认 20）后返回 {n, order_id, amount, delay_ms}。
 * 内容只由 seed 与 n（第几次查询）决定。
 */
import type { FixtureHandler } from '../server.ts';

export const DEFAULT_DELAY_MS = 20;

export type FastResult = { n: number; order_id: string; amount: number; delay_ms: number };

/** 第 n 次查询的结果（不含 delay_ms）。 */
export function resultFor(seed: number, n: number): Omit<FastResult, 'delay_ms'> {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(n | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return {
    n,
    order_id: `O-${String(100000 + (h % 900000))}`,
    amount: Math.round((h % 1_000_000) + 100) / 100,
  };
}

const data: FixtureHandler = async ({ url, res, json }) => {
  const q = url.searchParams;
  const n = Number(q.get('n') ?? 1);
  const seed = Number(q.get('seed') ?? 1);
  const delay = Math.min(5000, Math.max(0, Number(q.get('delay') ?? DEFAULT_DELAY_MS)));
  if (!Number.isInteger(n) || !Number.isInteger(seed) || !Number.isFinite(delay)) {
    return json({ error: 'n、seed 必须是整数' }, 400);
  }
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (res.destroyed) return;
  json({ ...resultFor(seed, n), delay_ms: delay });
};

export const routes: Record<string, FixtureHandler> = {
  '/api/fast-response/data': data,
};
