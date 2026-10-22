/**
 * 复杂结构模块的数据与校验：同名按钮的合同表、组件库页面的差旅申请。
 *
 * 数据放在 space.data.structure；init 不消耗 space.rng()（不影响其他模块的初始数据），
 * 随机只发生在页面加载时（见 view.ts 的 loadTokens：每次加载取一次 rng 当种子）。
 */
import type { Space } from '../../core.ts';

/** 同名按钮表的行：每行一个“查看”。数据固定，测试可以按合同号断言。 */
export type Row = { id: string; title: string; owner: string; amount: number };

export const ROWS: readonly Row[] = [
  { id: 'HT-2401', title: '办公用品年度采购', owner: '王芳', amount: 12800 },
  { id: 'HT-2402', title: '机房托管服务续约', owner: '李明', amount: 96000 },
  { id: 'HT-2403', title: '采购框架协议', owner: '张伟', amount: 450000 },
  { id: 'HT-2404', title: '市场推广外包', owner: '赵丽', amount: 38500 },
  { id: 'HT-2405', title: '软件许可补充协议', owner: '陈静', amount: 72000 },
  { id: 'HT-2406', title: '园区保洁服务', owner: '刘洋', amount: 21600 },
];

export const CITIES: readonly { value: string; label: string }[] = [
  { value: 'beijing', label: '北京' },
  { value: 'shanghai', label: '上海' },
  { value: 'shenzhen', label: '深圳' },
];
export const CABINS: readonly { value: string; label: string }[] = [
  { value: 'economy', label: '经济' },
  { value: 'business', label: '商务' },
];

/** 组件库页面提交的差旅申请。 */
export type Application = {
  id: string;
  name: string;
  email: string;
  city: string;
  cabin: string;
};

/** 差旅申请，编号 TR-0001 起。 */
export type StructureData = { applications: Application[] };

export const dataOf = (space: Space): StructureData => space.data.structure as StructureData;

export function initStructure(space: Space): void {
  space.data.structure = { applications: [] } satisfies StructureData;
}

const isOneOf = (list: readonly { value: string }[], v: unknown): v is string =>
  typeof v === 'string' && list.some((x) => x.value === v);

/** 校验差旅申请；通过返回规范化的字段，否则返回错误说明。 */
export function parseApplication(
  b: Record<string, unknown>,
): Omit<Application, 'id'> | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 50) return { error: '姓名必填，最长 50 个字' };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) {
    return { error: '邮箱格式不正确' };
  }
  if (!isOneOf(CITIES, b.city)) return { error: '请选择目的地城市' };
  if (!isOneOf(CABINS, b.cabin)) return { error: '请选择座位等级' };
  if (b.agree !== true) return { error: '需要先同意差旅规定' };
  return { name, email, city: b.city, cabin: b.cabin };
}
