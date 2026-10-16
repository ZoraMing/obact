/**
 * 复杂结构模块的数据与校验：同名按钮的合同表、页面事件账本、组件库页面的差旅申请。
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

/** 各 frame 的标识（?who=）：同源、跨域、嵌套里的内层、组件（Shadow Root）里的框架。 */
export const WHOS = ['same', 'cross', 'nested', 'shadow'] as const;
export type Who = (typeof WHOS)[number];

/** 页面事件：前端先更新界面，再带幂等键上报；服务端按类型累计，供评分点判定。 */
export const EVENT_TYPES = [
  'frame_submit', // 各 frame 里的“提交”：{who, email}
  'outer_button', // 嵌套框架外层页面的按钮
  'view', // 同名按钮“查看”：{row}
  'follow', // 开放 Shadow DOM 里的“关注”
  'favorite', // 嵌套的开放 Shadow DOM 里的“收藏”
  'pay', // 封闭 Shadow DOM 里的“支付”：{amount}
  'draft', // 动态属性区的“保存草稿”
  'approve', // 动态属性区的“提交审批”
  'open_window', // window.open 弹出窗口
  'report_ack', // 新标签页里的“确认收到”：{from}
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type StructureEvent = {
  key: string;
  type: EventType;
  detail: Record<string, string>;
  at: string;
};

export const CITIES: readonly { value: string; label: string }[] = [
  { value: 'beijing', label: '北京' },
  { value: 'shanghai', label: '上海' },
  { value: 'shenzhen', label: '深圳' },
  { value: 'chengdu', label: '成都' },
];
export const TRANSPORTS: readonly { value: string; label: string }[] = [
  { value: 'plane', label: '飞机' },
  { value: 'train', label: '高铁' },
  { value: 'car', label: '自驾' },
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
  transport: string;
  cabin: string;
  hotel: boolean;
  /** 提交时用的幂等键。 */
  key: string;
};

export type StructureData = {
  /** 最近 200 条页面事件（按到达先后）。 */
  events: StructureEvent[];
  /** 各类型事件累计（同一个幂等键只算一次）。 */
  counts: Record<string, number>;
  /** 点过“查看”的合同号（按先后）。 */
  views: string[];
  /** 各 frame 的提交次数与最近一次邮箱。 */
  frames: Record<string, { count: number; email: string }>;
  /** 差旅申请，编号 TR-0001 起。 */
  applications: Application[];
  /** 幂等键 → 申请，用于重复提交时原样返回首次结果。 */
  applied: Map<string, Application>;
  /** 页面加载次数（用于确认“每次加载都变”确实重新渲染过）。 */
  loads: { index: number; library: number };
};

export const dataOf = (space: Space): StructureData => space.data.structure as StructureData;

export function initStructure(space: Space): void {
  const data: StructureData = {
    events: [],
    counts: Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])),
    views: [],
    frames: Object.fromEntries(WHOS.map((w) => [w, { count: 0, email: '' }])),
    applications: [],
    applied: new Map(),
    loads: { index: 0, library: 0 },
  };
  space.data.structure = data;
}

const isOneOf = (list: readonly string[], v: unknown): v is string =>
  typeof v === 'string' && list.includes(v);

/** 事件详情只留短字符串字段（防止把任意大对象塞进账本）。 */
function cleanDetail(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof v === 'string' || typeof v === 'number')
      out[k.slice(0, 20)] = String(v).slice(0, 100);
  }
  return out;
}

/** 校验一次事件上报；返回清洗后的详情，或错误说明。 */
export function parseEvent(
  body: Record<string, unknown>,
): { type: EventType; detail: Record<string, string> } | { error: string } {
  if (!isOneOf(EVENT_TYPES, body.type))
    return { error: `type 必须是 ${EVENT_TYPES.join('、')} 之一` };
  const detail = cleanDetail(body.detail);
  if (body.type === 'frame_submit' && !isOneOf(WHOS, detail.who)) {
    return { error: `frame_submit 需要 detail.who（${WHOS.join('、')}）` };
  }
  if (body.type === 'view' && !ROWS.some((r) => r.id === detail.row)) {
    return { error: 'view 需要有效的 detail.row（合同号）' };
  }
  if (body.type === 'report_ack' && !isOneOf(['link', 'open'], detail.from)) {
    detail.from = 'unknown';
  }
  return { type: body.type as EventType, detail };
}

/** 把一次（首次到达的）事件记入账本。 */
export function applyEvent(
  data: StructureData,
  key: string,
  type: EventType,
  detail: Record<string, string>,
): void {
  data.counts[type] = (data.counts[type] ?? 0) + 1;
  data.events.push({ key, type, detail, at: new Date().toISOString() });
  if (data.events.length > 200) data.events.splice(0, data.events.length - 200);
  if (type === 'view') data.views.push(detail.row as string);
  if (type === 'frame_submit') {
    const f = data.frames[detail.who as string];
    if (f) {
      f.count++;
      f.email = detail.email ?? '';
    }
  }
}

export type ApplyInput = {
  name: string;
  email: string;
  city: string;
  transport: string;
  cabin: string;
  hotel: boolean;
};

/** 校验差旅申请；通过返回规范化的字段，否则返回错误说明。 */
export function parseApplication(b: Record<string, unknown>): ApplyInput | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 50) return { error: '姓名必填，最长 50 个字' };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) {
    return { error: '邮箱格式不正确' };
  }
  const city = CITIES.map((c) => c.value);
  const transport = TRANSPORTS.map((c) => c.value);
  const cabin = CABINS.map((c) => c.value);
  if (!isOneOf(city, b.city)) return { error: '请选择目的地城市' };
  if (!isOneOf(transport, b.transport)) return { error: '请选择出行方式' };
  if (!isOneOf(cabin, b.cabin)) return { error: '请选择座位等级' };
  if (b.agree !== true) return { error: '需要先同意差旅规定' };
  return {
    name,
    email,
    city: b.city,
    transport: b.transport,
    cabin: b.cabin,
    hotel: b.hotel === true,
  };
}

export const labelOf = (list: readonly { value: string; label: string }[], v: string): string =>
  list.find((x) => x.value === v)?.label ?? v;
