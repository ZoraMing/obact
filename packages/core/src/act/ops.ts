import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type {
  Action,
  Click,
  ClickAt,
  Drag,
  EvaluateScript,
  Fill,
  FillForm,
  HandleDialog,
  MouseMove,
  NavigatePage,
  NewPage,
  Point as PointT,
  PressKey,
  Scroll,
  TakeScreenshot,
  Target,
  TypeText,
  UploadFile,
} from '@obact/schemas';
import type { ElementHandle, HTTPResponse, KeyInput, MouseButton, Page } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import { type Ctx, type Effects, fail } from './ctx.ts';
import {
  actionable,
  checkInViewport,
  type Located,
  locate,
  notifyObscured,
  type Subject,
} from './locate.ts';
import {
  ACT_DEPS,
  obActCaretEnd,
  obActDatalistInput,
  obActFocus,
  obActFocusSelectAll,
  obActHasFocus,
  obActHoldEvents,
  obActInfo,
  obActIsFocused,
  obActLabelProxy,
  obActLandRead,
  obActLandStart,
  obActOptionOwner,
  obActProbe,
  obActScrollAmount,
  obActScrollState,
  obActSelectApply,
  obActSelectPlan,
  obActSetNativeValue,
} from './page.ts';
import { dropPending, pendingOf, watchPage } from './state.ts';
import { parseKeyCombo, pressCombo, resolveInside, sleep, within } from './util.ts';

const INFO = bundle(obActInfo, ACT_DEPS);
const FOCUS_SELECT_ALL = bundle(obActFocusSelectAll, ACT_DEPS);
const IS_FOCUSED = bundle(obActIsFocused, ACT_DEPS);
const HAS_FOCUS = bundle(obActHasFocus, ACT_DEPS);
const CARET_END = bundle(obActCaretEnd, ACT_DEPS);
const FOCUS = bundle(obActFocus, ACT_DEPS);
const LABEL_PROXY = bundle(obActLabelProxy, ACT_DEPS);
const LAND_START = bundle(
  (el: Element, key: string, subject: Element | null) => obActLandStart(key, el, subject),
  ACT_DEPS,
);
const LAND_READ = bundle(
  (_el: Element, key: string, final: boolean, fx: number, fy: number) =>
    obActLandRead(key, final, fx, fy),
  ACT_DEPS,
);
const SET_NATIVE = bundle(obActSetNativeValue, ACT_DEPS);
const SELECT_PLAN = bundle(obActSelectPlan, ACT_DEPS);
const SELECT_APPLY = bundle(obActSelectApply, ACT_DEPS);
const HOLD_EVENTS = bundle(obActHoldEvents, ACT_DEPS);
const SELECTED_INDEX = (el: Element) => (el as HTMLSelectElement).selectedIndex;
const OPTION_OWNER = bundle(obActOptionOwner, ACT_DEPS);
const DATALIST_INPUT = bundle(obActDatalistInput, ACT_DEPS);
const PROBE = bundle(obActProbe, ACT_DEPS);
const SCROLL_STATE = bundle(obActScrollState, ACT_DEPS);
const SCROLL_AMOUNT = bundle(obActScrollAmount, ACT_DEPS);
const CHECKED = (el: Element) =>
  el.tagName === 'INPUT'
    ? (el as HTMLInputElement).checked
    : el.getAttribute('aria-checked') === 'true';

type Info = Awaited<ReturnType<typeof obActInfo>>;
export type Handler = (ctx: Ctx, fx: Effects) => Promise<void>;

function page(ctx: Ctx): Page {
  if (!ctx.page) fail('internal', '缺少标签页');
  return ctx.page;
}

/** 可用操作的约定与 observe 一致（page/dom.ts 的 obActions）：不支持的操作报 not_actionable 并说明。 */
function requireAction(info: Info, op: string): void {
  if (info.actions.includes(op)) return;
  const what = `${info.role}${info.name ? ` "${info.name}"` : ''}`;
  let hint = '';
  if (op === 'fill' && info.fill === 'text') hint = '只读输入框不能填写。';
  else if (op === 'click' && info.tag === 'select') hint = '下拉框请用 fill 按选项文本或值选择。';
  else if (op === 'click' && info.isFileInput) hint = '文件输入框请用 upload_file。';
  else if (op === 'click' && info.kind === 'scroll') hint = '滚动容器请用 scroll。';
  else if (op === 'click' && info.type === 'range') hint = '滑块请用 fill（填数值）或 drag。';
  fail(
    'not_actionable',
    `${hint}该元素（${what}）不支持 ${op}，可用操作：${info.actions.join('、') || '无'}`,
    { op, actions: info.actions, role: info.role },
  );
}

const sameEl = (loc: Located, handle: ElementHandle<Element>): Located => ({ ...loc, handle });

/** 鼠标按下状态异常（上次拖拽被打断）时先抬起再重试一次。 */
async function mouseSafe(page: Page, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!/already pressed/.test(String((e as Error).message))) throw e;
    await page.mouse.up().catch(() => {});
    await fn();
  }
}

/** 按住修饰键执行（鼠标事件的 modifiers 取自键盘状态）。 */
async function withModifiers(
  page: Page,
  modifiers: readonly string[] | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const down: string[] = [];
  try {
    for (const m of modifiers ?? []) {
      await page.keyboard.down(m as KeyInput);
      down.push(m);
    }
    await fn();
  } finally {
    for (const m of down.reverse()) await page.keyboard.up(m as KeyInput).catch(() => {});
  }
}

/**
 * 可信点击（CDP Input.dispatchMouseEvent）：可操作性检查 → 移动 → 复核命中 → 按下/抬起（FR-13）。
 * 按下前在页面里装落点防护：按下事件的真实目标不是目标元素（布局在最后一次命中测试之后又移动了）时，
 * 页面拦截这次点击，页面脚本看不到；随后回调 onObscured 并重试，连续 3 次不符报 landing_mismatch。
 */
async function clickElement(
  ctx: Ctx,
  loc: Located,
  o: { button?: MouseButton; count?: number; modifiers?: readonly string[]; who?: Subject } = {},
): Promise<Located> {
  const p = page(ctx);
  const streak = { n: 0 };
  for (;;) {
    const ready = await actionable(ctx, loc, { move: true, who: o.who, streak });
    loc = ready.loc;
    const el = o.who?.el ?? loc.handle;
    const subject = o.who?.subject ?? null;
    const key = `__obactLand_${ctx.s.key}`;
    await el.evaluate(LAND_START, key, subject).catch(() => {});
    ctx.alive();
    ctx.dispatched = true;
    await withModifiers(p, o.modifiers, () =>
      mouseSafe(p, () =>
        p.mouse.click(ready.point.x, ready.point.y, {
          button: o.button ?? 'left',
          count: o.count ?? 1,
        }),
      ),
    );
    ctx.alive();
    // 按下事件可能稍晚才到：没收到时先等一会（最多 600 毫秒），读到记录或超时再定论
    const readBy = Date.now() + 600;
    let land = await within(
      el.evaluate(LAND_READ, key, false, ready.point.fx, ready.point.fy),
      1500,
      null,
    ).catch(() => null);
    while (land?.pending) {
      if (Date.now() >= readBy) {
        land = await within(
          el.evaluate(LAND_READ, key, true, ready.point.fx, ready.point.fy),
          1500,
          null,
        ).catch(() => null);
        break;
      }
      await sleep(25);
      land = await within(
        el.evaluate(LAND_READ, key, false, ready.point.fx, ready.point.fy),
        1500,
        null,
      ).catch(() => null);
    }
    // 读不到（导航、文档替换）或落点正确时不再判定
    if (!land || land.ok) return loc;
    const at: [number, number] = [ready.point.x, ready.point.y];
    if (!land.fired) {
      // 按下事件始终没有到达目标所在的文档：点击没有被页面收到，可以安全重试（连续 3 次报错）
      streak.n++;
      await notifyObscured(ctx, loc, at, '（按下事件未送达）', streak.n);
      if (streak.n >= 3) {
        fail(
          'landing_mismatch',
          `按下事件没有到达目标所在的文档（连续 ${streak.n} 次；${land.info ?? ''}）`,
          { hit: '', point: at, page: land.info ?? '' },
        );
      }
      continue;
    }
    streak.n++;
    await notifyObscured(ctx, loc, at, land.desc, streak.n);
    if (streak.n >= 3) {
      fail(
        'landing_mismatch',
        `点击落在了 ${land.desc} 上，而不是目标元素（连续 ${streak.n} 次，已拦截，页面没有收到点击）`,
        { hit: land.desc, point: at },
      );
    }
  }
}

/** 隐藏的原生复选/单选：改点可见的 label；否则点元素本身。 */
async function labelProxy(loc: Located, info: Info): Promise<Subject | undefined> {
  if (info.click !== 'label') return undefined;
  const h = await loc.handle.evaluateHandle(LABEL_PROXY);
  const label = h.asElement() as ElementHandle<Element> | null;
  if (!label) {
    await h.dispose();
    return undefined;
  }
  return { el: label, subject: loc.handle };
}

// ---------------------------------------------------------------- 元素动作

const click: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & Click;
  ctx.wait = 'action';
  const loc = await locate(ctx, a.target, fx);
  ctx.locator = loc.via;
  try {
    const info = await loc.handle.evaluate(INFO);
    if (info.click === 'option-select') return await clickOption(ctx, loc, a);
    if (info.click === 'option-datalist') return await clickDatalistOption(ctx, loc, fx);
    requireAction(info, 'click');
    const who = await labelProxy(loc, info);
    try {
      await clickElement(ctx, loc, {
        button: a.button,
        count: a.double ? 2 : 1,
        modifiers: a.modifiers,
        who,
      });
    } finally {
      await who?.el.dispose().catch(() => {});
    }
  } finally {
    await loc.handle.dispose().catch(() => {});
  }
};

/**
 * 点下拉框里的选项：单选的原生下拉弹层不在页面内，改为按选项选择（见 selectOption）；
 * 多选下拉框的选项在页面里有真实位置，直接可信点击，Ctrl/Meta 切换、Shift 连选、无修饰键替换都是浏览器原生行为。
 */
async function clickOption(ctx: Ctx, loc: Located, a: Click): Promise<void> {
  const h = await loc.handle.evaluateHandle(OPTION_OWNER);
  const select = (await h.getProperty('select')).asElement() as ElementHandle<Element> | null;
  const index = (await (await h.getProperty('index')).jsonValue()) as number;
  const multiple = (await (await h.getProperty('multiple')).jsonValue()) as boolean;
  await h.dispose();
  if (!select) fail('not_actionable', '选项不在下拉框内');
  try {
    if (multiple) {
      await clickElement(ctx, loc, {
        button: a.button,
        count: a.double ? 2 : 1,
        modifiers: a.modifiers,
      });
    } else await selectOption(ctx, sameEl(loc, select), '', index);
  } finally {
    await select.dispose().catch(() => {});
  }
}

/** 点 datalist 的建议项：等于在关联的输入框里填入该项的值。 */
async function clickDatalistOption(ctx: Ctx, loc: Located, fx: Effects): Promise<void> {
  const h = await loc.handle.evaluateHandle(DATALIST_INPUT);
  const input = (await h.getProperty('input')).asElement() as ElementHandle<Element> | null;
  const value = (await (await h.getProperty('value')).jsonValue()) as string;
  await h.dispose();
  if (!input) fail('not_actionable', '找不到使用该 datalist 的输入框');
  ctx.wait = 'input';
  try {
    await fillElement(ctx, sameEl(loc, input), value, fx);
  } finally {
    await input.dispose().catch(() => {});
  }
}

const hover: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & { target: Target };
  ctx.wait = 'input';
  const loc = await locate(ctx, a.target, fx);
  ctx.locator = loc.via;
  try {
    // 悬停不改变页面数据，不限制元素类型（CSS :hover 菜单常不带 aria-haspopup）
    ctx.dispatched = true;
    await actionable(ctx, loc, { move: true });
  } finally {
    await loc.handle.dispose().catch(() => {});
  }
};

function toBool(v: string | number | boolean): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'on', 'yes', 'checked'].includes(s)) return true;
  if (['false', '0', 'off', 'no', 'unchecked', ''].includes(s)) return false;
  throw new ObactError('invalid_params', `复选框/单选框的值应为布尔值：${v}`, { value: v });
}

/** 聚焦：先用页面脚本聚焦；被拒绝时（如跨域 iframe）用可信点击聚焦。 */
async function focusElement(ctx: Ctx, loc: Located, point: { x: number; y: number }) {
  if (await loc.handle.evaluate(FOCUS)) return;
  const p = page(ctx);
  await mouseSafe(p, () => p.mouse.click(point.x, point.y));
  if (!(await loc.handle.evaluate(IS_FOCUSED))) fail('not_actionable', '无法聚焦目标元素');
}

/**
 * 填写一个元素（FR-12）：
 * - 文本框、textarea、contenteditable：聚焦 → 全选 → Backspace 删除 → CDP Input.insertText 写入（可信输入事件）；
 * - 复选/单选：按布尔值必要时点击（隐藏的原生控件改点 label）；单选框不能点成未选中；
 * - 下拉框：按选项文本或值选择（见 selectOption）；多选下拉框的值用逗号分隔多项（见 selectMulti）；
 * - 日期、时间、颜色、滑块：无法逐字输入，用原生 value 设置器写值并派发 input/change。
 */
async function fillElement(
  ctx: Ctx,
  loc: Located,
  value: string | number | boolean,
  _fx: Effects,
): Promise<void> {
  const p = page(ctx);
  const info = await loc.handle.evaluate(INFO);
  requireAction(info, 'fill');
  switch (info.fill) {
    case 'text':
    case 'editable': {
      const { point } = await actionable(ctx, loc);
      ctx.dispatched = true;
      await focusElement(ctx, loc, point);
      const sel = await loc.handle.evaluate(FOCUS_SELECT_ALL);
      if (!sel.focused) fail('not_actionable', '无法聚焦目标元素');
      if (sel.hadContent) await p.keyboard.press('Backspace');
      const text = String(value);
      if (text) await p.keyboard.sendCharacter(text);
      return;
    }
    case 'value': {
      await actionable(ctx, loc);
      ctx.dispatched = true;
      const want = String(value);
      const r = await loc.handle.evaluate(SET_NATIVE, want);
      if (!r.ok) {
        const fmt: Record<string, string> = {
          date: 'YYYY-MM-DD',
          time: 'HH:MM',
          'datetime-local': 'YYYY-MM-DDTHH:MM',
          month: 'YYYY-MM',
          week: 'YYYY-Www',
          color: '#rrggbb',
        };
        // 浏览器把不合法的值净化成空串（日期等）或别的值（颜色变黑、滑块被夹进范围）：都没有写进页面
        fail(
          'invalid_params',
          r.got === ''
            ? `值格式不符：${info.type} 需要 ${fmt[info.type] ?? '有效的值'}`
            : `值不被接受：${info.type} 会把“${want}”调整为“${r.got}”（格式不符或超出范围）`,
          { value: want, actual: r.got },
        );
      }
      return;
    }
    case 'check': {
      const want = toBool(value);
      if (info.checked === want) return;
      if (info.type === 'radio' && !want) {
        fail('not_actionable', '单选框不能通过点击取消选中，请选择同组的另一项');
      }
      const who = await labelProxy(loc, info);
      try {
        await clickElement(ctx, loc, { who });
      } finally {
        await who?.el.dispose().catch(() => {});
      }
      while ((await loc.handle.evaluate(CHECKED)) !== want) {
        if (Date.now() >= ctx.deadline) fail('not_actionable', '点击后勾选状态没有变化');
        await sleep(30);
      }
      return;
    }
    case 'select':
      if (info.multiple) return selectMulti(ctx, loc, String(value));
      return selectOption(ctx, loc, String(value), null);
    default:
      fail('not_actionable', '该元素不可直接填写（不是输入框或可编辑区域）', { role: info.role });
  }
}

/** 按选项文本或值找下拉框的目标选项（index 给定时直接用下标）；选项可能异步加载，找不到时在期限内轮询。 */
async function planOption(ctx: Ctx, loc: Located, want: string, index: number | null) {
  let plan = await loc.handle.evaluate(SELECT_PLAN, want, index);
  while (plan.index < 0) {
    if (Date.now() >= ctx.deadline) {
      fail('not_found', `下拉框中没有选项“${want}”，可选：${plan.labels.join('、')}`, {
        value: want,
        options: plan.labels,
      });
    }
    await sleep(100);
    plan = await loc.handle.evaluate(SELECT_PLAN, want, index);
  }
  if (plan.disabled) fail('not_actionable', '该选项已禁用', { index: plan.index });
  return plan;
}

/**
 * 单选下拉框选择：按选项文本或值找到目标（index 给定时直接用下标）。
 * 先用键盘方式：页面脚本聚焦后按 Home/方向键移到目标项，最后一次按键产生可信的 input/change 事件
 * （原生下拉弹层不在页面内，无法用可信鼠标点选）；中间项的事件在按键期间被暂扣，页面只收到目标项这一组；
 * 未生效时（如 macOS 上方向键会打开弹层）按 Escape 关闭弹层，再用页面脚本选中并派发 input/change。
 */
async function selectOption(
  ctx: Ctx,
  loc: Located,
  want: string,
  index: number | null,
): Promise<void> {
  const p = page(ctx);
  await actionable(ctx, loc);
  const plan = await planOption(ctx, loc, want, index);
  if (plan.index === plan.current) return;
  ctx.dispatched = true;
  if (await loc.handle.evaluate(FOCUS)) {
    const keys: KeyInput[] = plan.home ? ['Home'] : [];
    for (let i = 0; i < Math.abs(plan.steps); i++)
      keys.push(plan.steps > 0 ? 'ArrowDown' : 'ArrowUp');
    const last = keys.pop() as KeyInput;
    if (keys.length) {
      const hold = await loc.handle.evaluateHandle(HOLD_EVENTS);
      try {
        for (const k of keys) await p.keyboard.press(k);
      } finally {
        await hold.evaluate((h) => h.stop()).catch(() => {});
        await hold.dispose().catch(() => {});
      }
    }
    await p.keyboard.press(last);
    // 最后一次按键的 change 可能让页面跳转（onchange 里导航）：读不到选中项就当作已经生效
    if ((await loc.handle.evaluate(SELECTED_INDEX).catch(() => plan.index)) === plan.index) return;
    await p.keyboard.press('Escape');
  }
  await loc.handle.evaluate(SELECT_APPLY, [plan.index]);
}

/**
 * 多选下拉框填写：值按逗号（半角或全角）分隔多个选项，选中恰好这些项、其余取消，只派发一组 input/change；
 * 整个值本身就是某个选项的文本或值时按单个处理（选项文本里可以有逗号）；值为空时取消全部。
 * 逐项可信点击（Ctrl/Meta/Shift）请用 click 点选项。
 */
async function selectMulti(ctx: Ctx, loc: Located, want: string): Promise<void> {
  await actionable(ctx, loc);
  const whole = await loc.handle.evaluate(SELECT_PLAN, want, null);
  const wants =
    whole.index >= 0
      ? [want]
      : want
          .split(/[,，]/)
          .map((w) => w.trim())
          .filter(Boolean);
  const indexes: number[] = [];
  for (const w of wants) indexes.push((await planOption(ctx, loc, w, null)).index);
  ctx.dispatched = true;
  await loc.handle.evaluate(SELECT_APPLY, indexes);
}

const fill: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & Fill;
  ctx.wait = 'input';
  const loc = await locate(ctx, a.target, fx);
  ctx.locator = loc.via;
  try {
    await fillElement(ctx, loc, a.value, fx);
  } finally {
    await loc.handle.dispose().catch(() => {});
  }
};

const fillForm: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & FillForm;
  ctx.wait = 'input';
  for (const [i, item] of a.elements.entries()) {
    try {
      const loc = await locate(ctx, item.target, fx);
      if (i === 0) ctx.locator = loc.via;
      try {
        await fillElement(ctx, loc, item.value, fx);
      } finally {
        await loc.handle.dispose().catch(() => {});
      }
    } catch (e) {
      if (!(e instanceof ObactError)) throw e;
      throw new ObactError(e.code, `第 ${i + 1} 项：${e.message}`, { ...e.details, index: i });
    }
  }
};

const typeText: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & TypeText;
  const p = page(ctx);
  ctx.wait = 'input';
  if (a.target) {
    const loc = await locate(ctx, a.target, fx);
    ctx.locator = loc.via;
    try {
      requireAction(await loc.handle.evaluate(INFO), 'type_text');
      const { point } = await actionable(ctx, loc);
      ctx.dispatched = true;
      // 新聚焦的元素把光标放到末尾，键入接在原有内容后面；已有焦点的元素保持用户放的光标和选区
      const fresh = !(await loc.handle.evaluate(HAS_FOCUS));
      await focusElement(ctx, loc, point);
      if (fresh && !(await loc.handle.evaluate(CARET_END))) await p.keyboard.press('ArrowRight');
    } finally {
      await loc.handle.dispose().catch(() => {});
    }
  }
  ctx.dispatched = true;
  // 逐字键入：有键位的字符产生完整的 keydown/keypress/input/keyup，其余（如中文）用 insertText
  await p.keyboard.type(a.text);
};

const pressKey: Handler = async (ctx) => {
  const a = ctx.action as Action & PressKey;
  const p = page(ctx);
  ctx.wait = 'input';
  const kb = p.keyboard as unknown as { charIsKey?: (k: string) => boolean };
  const combo = parseKeyCombo(a.key, (k) => (kb.charIsKey ? kb.charIsKey(k) : true));
  ctx.dispatched = true;
  await pressCombo(p, combo);
};

/** 拖拽端点：目标 → 可操作性检查后的中心点；坐标 → 校验在视口内。 */
async function dragEnd(
  ctx: Ctx,
  end: Target | PointT,
  fx: Effects,
  role: 'from' | 'to',
): Promise<{ x: number; y: number; loc?: Located }> {
  if (Array.isArray(end)) {
    const [x, y] = end as [number, number];
    await checkInViewport(ctx, x, y);
    return { x, y };
  }
  const loc = await locate(ctx, end as Target, fx);
  if (role === 'from') {
    const info = await loc.handle.evaluate(INFO);
    // 拖拽库常用 pointer 事件实现，不一定带 draggable：可点击的元素也允许作为起点
    if (!info.actions.includes('drag') && !info.actions.includes('click'))
      requireAction(info, 'drag');
  }
  const r = await actionable(ctx, loc, { hitTest: role === 'from' });
  return { x: r.point.x, y: r.point.y, loc: r.loc };
}

/**
 * 拖拽（FR-32）：按下 → 分步移动 → 抬起。HTML5 拖放（Chrome 由真实鼠标序列触发 dragstart/drop）
 * 和 pointer 事件实现的拖拽库都能响应。
 */
const drag: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & Drag;
  const p = page(ctx);
  ctx.wait = 'action';
  const from = await dragEnd(ctx, a.from, fx, 'from');
  const to = await dragEnd(ctx, a.to, fx, 'to');
  try {
    if (from.loc && to.loc) {
      // 终点滚动到视口后，重新确认起点；两者不能同时可见时报错
      const r = await actionable(ctx, from.loc);
      from.x = r.point.x;
      from.y = r.point.y;
      const still = await to.loc.handle.evaluate(PROBE, null, false);
      if (!still.inView) fail('not_actionable', '拖拽的起点和终点无法同时显示在视口内');
      const again = await actionable(ctx, to.loc, { hitTest: false });
      to.x = again.point.x;
      to.y = again.point.y;
    }
    ctx.locator = from.loc?.via ?? to.loc?.via ?? 'coord';
    ctx.dispatched = true;
    await mouseSafe(p, () => p.mouse.move(from.x, from.y));
    await p.mouse.down();
    try {
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.min(25, Math.max(8, Math.ceil(dist / 15)));
      for (let i = 1; i <= steps; i++) {
        ctx.alive();
        await p.mouse.move(
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps,
        );
      }
    } finally {
      await p.mouse.up().catch(() => {});
    }
  } finally {
    await from.loc?.handle.dispose().catch(() => {});
    await to.loc?.handle.dispose().catch(() => {});
  }
};

/**
 * 上传（FR-12）：文件路径限制在 filesRoot 内。
 * - 文件输入框（或关联它的 label）：CDP DOM.setFileInputFiles，浏览器派发可信的 input/change；
 * - 其他可点击元素（自绘上传按钮）：可信点击后拦截弹出的文件选择框并选入文件。
 */
const uploadFile: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & UploadFile;
  const p = page(ctx);
  ctx.wait = 'action';
  const root = ctx.opts.filesRoot;
  if (!root) fail('invalid_params', '未配置 filesRoot（上传文件的工作区根目录）');
  const files = a.files.map((f) => resolveInside(root, f, true));
  const loc = await locate(ctx, a.target, fx);
  ctx.locator = loc.via;
  try {
    const info = await loc.handle.evaluate(INFO);
    if (info.isFileInput || info.labelFile) {
      let input = loc.handle;
      if (info.labelFile) {
        const h = await loc.handle.evaluateHandle((el) => (el as HTMLLabelElement).control);
        input = h.asElement() as ElementHandle<Element>;
      }
      const st = await input.evaluate((el) => ({
        disabled: (el as HTMLInputElement).disabled,
        multiple: (el as HTMLInputElement).multiple,
      }));
      if (st.disabled) fail('not_actionable', '文件输入框已禁用');
      if (files.length > 1 && !st.multiple) {
        fail('invalid_params', '该文件输入框只接受一个文件', { files: a.files });
      }
      ctx.dispatched = true;
      await (input as ElementHandle<HTMLInputElement>).uploadFile(...files);
      if (input !== loc.handle) await input.dispose().catch(() => {});
      return;
    }
    if (!info.actions.includes('click')) requireAction(info, 'upload_file');
    const chooserP = p
      .waitForFileChooser({ timeout: Math.max(500, ctx.deadline - Date.now()) })
      .catch(() => null);
    await clickElement(ctx, loc);
    const chooser = await chooserP;
    if (!chooser) fail('not_actionable', '点击后没有出现文件选择框（该元素不是上传控件）');
    if (files.length > 1 && !chooser.isMultiple()) {
      await chooser.cancel().catch(() => {});
      fail('invalid_params', '该上传控件只接受一个文件', { files: a.files });
    }
    await chooser.accept(files);
  } finally {
    await loc.handle.dispose().catch(() => {});
  }
};

/**
 * 滚动：给 target 则把鼠标移到元素上滚轮（滚动容器 data-obact-kind=scroll 用它）；给 at 则在该坐标滚轮；
 * 都不给则在视口中央滚轮（与用户滚动页面一致）。默认滚动可见高度的 80%。滚轮在合成器线程异步生效，
 * 派发后等滚动位置变化并稳定（若很快没有变化，视为已到边界）。
 */
const scroll: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & Scroll;
  const p = page(ctx);
  ctx.wait = 'action';
  let x: number;
  let y: number;
  let amount: number;
  let stateFrame = p.mainFrame();
  let fx0: number;
  let fy0: number;
  let loc: Located | undefined;
  try {
    if (a.target) {
      loc = await locate(ctx, a.target, fx);
      ctx.locator = loc.via;
      const r = await actionable(ctx, loc, { move: true });
      x = r.point.x;
      y = r.point.y;
      fx0 = r.point.fx;
      fy0 = r.point.fy;
      stateFrame = r.loc.frame;
      amount = await r.loc.handle.evaluate(SCROLL_AMOUNT);
    } else {
      if (a.at) {
        [x, y] = a.at as [number, number];
        await checkInViewport(ctx, x, y);
        ctx.locator = 'coord';
      } else {
        const vp = await p.mainFrame().evaluate(() => [innerWidth, innerHeight]);
        x = Math.floor((vp[0] as number) / 2);
        y = Math.floor((vp[1] as number) / 2);
      }
      fx0 = x;
      fy0 = y;
      await mouseSafe(p, () => p.mouse.move(x, y));
      amount = await p.mainFrame().evaluate(SCROLL_AMOUNT, null);
    }
    const dx = a.dx ?? 0;
    const dy = a.dx === undefined && a.dy === undefined ? amount : (a.dy ?? 0);
    const read = () =>
      stateFrame.evaluate(SCROLL_STATE, fx0, fy0).catch(() => [] as number[]) as Promise<number[]>;
    const before = await read();
    ctx.dispatched = true;
    await p.mouse.wheel({ deltaX: dx, deltaY: dy });
    const start = Date.now();
    let last = before;
    let changedAt = 0;
    while (Date.now() - start < 1500) {
      await sleep(16);
      const now = await read();
      const same = now.length === last.length && now.every((v, i) => v === last[i]);
      if (!same) changedAt = Date.now();
      else if (changedAt && Date.now() - changedAt >= 32) break;
      else if (!changedAt && Date.now() - start >= 150) break;
      last = now;
    }
  } finally {
    await loc?.handle.dispose().catch(() => {});
  }
};

const clickAt: Handler = async (ctx) => {
  const a = ctx.action as Action & ClickAt;
  const p = page(ctx);
  ctx.wait = 'action';
  ctx.locator = 'coord';
  await checkInViewport(ctx, a.x, a.y);
  ctx.dispatched = true;
  await withModifiers(p, a.modifiers, () =>
    mouseSafe(p, () =>
      p.mouse.click(a.x, a.y, { button: a.button ?? 'left', count: a.double ? 2 : 1 }),
    ),
  );
};

const mouseMove: Handler = async (ctx) => {
  const a = ctx.action as Action & MouseMove;
  const p = page(ctx);
  ctx.wait = 'input';
  ctx.locator = 'coord';
  await checkInViewport(ctx, a.x, a.y);
  ctx.dispatched = true;
  await mouseSafe(p, () => p.mouse.move(a.x, a.y));
};

// ---------------------------------------------------------------- 页面动作

const handleDialog: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & HandleDialog;
  const p = page(ctx);
  ctx.wait = 'action';
  const d = pendingOf(ctx.st, p);
  if (!d) fail('invalid_params', '没有待处理的对话框');
  dropPending(ctx.st, d);
  ctx.dispatched = true;
  try {
    // prompt 不给文本时与用户直接点“确定”一致：采用页面给的默认值
    if (a.action === 'accept') await d.dialog.accept(a.prompt_text ?? d.dialog.defaultValue());
    else await d.dialog.dismiss();
  } catch (e) {
    fail('invalid_params', `对话框已关闭：${(e as Error).message}`);
  }
  ctx.dialogs.push({ type: d.type, message: d.message, handled: a.action });
  // 被对话框打断的输入派发此时才返回
  const inflight = ctx.st.inflight.get(p);
  if (inflight) {
    ctx.st.inflight.delete(p);
    await within(inflight, 1000, null);
  }
  // 对话框关闭后页面脚本才继续运行：从这里开始记录页面变化，并把这一步算作页面有变化
  if (!p.isClosed()) await fx.track(p.mainFrame());
  ctx.changed = true;
};

async function navError(e: unknown, what: string): Promise<never> {
  if (e instanceof ObactError) throw e;
  const msg = String((e as Error)?.message ?? e);
  if ((e as Error)?.name === 'TimeoutError') fail('navigation_failed', `${what}超时：${msg}`);
  fail('navigation_failed', `${what}失败：${msg.split('\n')[0]}`);
}

const navigatePage: Handler = async (ctx) => {
  const a = ctx.action as Action & NavigatePage;
  const p = page(ctx);
  ctx.wait = 'none';
  const type = a.type ?? 'url';
  const opt = { waitUntil: 'domcontentloaded' as const, timeout: ctx.timeout };
  let resp: HTTPResponse | null = null;
  if (type === 'url') {
    let url: URL;
    try {
      url = new URL(a.url as string, p.url().startsWith('http') ? p.url() : undefined);
    } catch {
      fail('invalid_params', `URL 无效：${a.url}`, { url: a.url });
    }
    if (url.protocol === 'javascript:') fail('invalid_params', '不允许 javascript: 地址');
    ctx.dispatched = true;
    ctx.navigated = true;
    resp = await p.goto(url.href, opt).catch((e) => navError(e, '打开页面'));
  } else if (type === 'reload') {
    ctx.dispatched = true;
    ctx.navigated = true;
    resp = await p.reload(opt).catch((e) => navError(e, '刷新'));
  } else {
    const delta = type === 'back' ? -1 : 1;
    const cdp = await p.createCDPSession();
    try {
      const h = await cdp.send('Page.getNavigationHistory');
      if (!h.entries[h.currentIndex + delta]) {
        fail('navigation_failed', type === 'back' ? '没有可后退的页面' : '没有可前进的页面');
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
    ctx.dispatched = true;
    ctx.navigated = true;
    resp = await (type === 'back' ? p.goBack(opt) : p.goForward(opt)).catch((e) =>
      navError(e, type === 'back' ? '后退' : '前进'),
    );
  }
  ctx.data = { url: p.url(), status: resp?.status() ?? null };
};

const selectPage: Handler = async (ctx) => {
  ctx.wait = 'none';
  ctx.dispatched = true;
  await page(ctx).bringToFront();
};

const closePage: Handler = async (ctx) => {
  const p = page(ctx);
  ctx.wait = 'none';
  ctx.dispatched = true;
  ctx.st.pending = ctx.st.pending.filter((d) => d.page !== p);
  await p.close({ runBeforeUnload: false });
  ctx.s.refs.dropPage(ctx.pageId);
};

const SHOT_TYPES: Record<string, 'png' | 'jpeg' | 'webp'> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
};

/** 截图保存路径：给定 path 时限制在工作区（filesRoot，未配置时为 outDir）内；否则在 outDir 下自动命名。 */
export function shotPath(ctx: Ctx, path?: string): { path: string; type: 'png' | 'jpeg' | 'webp' } {
  const outDir = ctx.opts.outDir ?? join(tmpdir(), 'obact-shots');
  let full: string;
  if (path) full = resolveInside(ctx.opts.filesRoot ?? outDir, path, false);
  else full = join(outDir, `${ctx.pageId || 'page'}-${ctx.seq}-${Date.now()}.png`);
  let type = SHOT_TYPES[extname(full).toLowerCase()];
  if (!type) {
    full += '.png';
    type = 'png';
  }
  mkdirSync(dirname(full), { recursive: true });
  return { path: full, type };
}

const takeScreenshot: Handler = async (ctx, fx) => {
  const a = ctx.action as Action & TakeScreenshot;
  const p = page(ctx);
  ctx.wait = 'none';
  const out = shotPath(ctx, a.path);
  if (a.target) {
    const loc = await locate(ctx, a.target, fx);
    ctx.locator = loc.via;
    try {
      await actionable(ctx, loc, { hitTest: false, stable: false });
      ctx.dispatched = true;
      await loc.handle.screenshot({ path: out.path as `${string}.png`, type: out.type });
    } finally {
      await loc.handle.dispose().catch(() => {});
    }
  } else {
    ctx.dispatched = true;
    await p.screenshot({
      path: out.path as `${string}.png`,
      type: out.type,
      fullPage: !!a.full_page,
    });
  }
  ctx.screenshot = out.path;
};

const evaluateScript: Handler = async (ctx) => {
  const a = ctx.action as Action & EvaluateScript;
  const p = page(ctx);
  ctx.wait = 'none';
  const expr = `(${a.function.trim()}).apply(null, ${JSON.stringify(a.args ?? [])})`;
  const TIMEOUT = Symbol('timeout');
  ctx.dispatched = true;
  let v: unknown;
  try {
    v = await within(p.mainFrame().evaluate(expr), ctx.timeout, TIMEOUT);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/Target closed|Session closed|detached/i.test(msg)) throw e;
    fail('script_error', `脚本出错：${msg.split('\n')[0]}`);
  }
  if (v === TIMEOUT) fail('timeout', `脚本执行超过 ${ctx.timeout} 毫秒`);
  ctx.data = v === undefined ? null : v;
};

/** new_page 没有动作前的页面，单独处理（见 index.ts）。 */
export async function newPage(ctx: Ctx): Promise<void> {
  const a = ctx.action as Action & NewPage;
  if (a.pageId && ctx.s.pages.has(a.pageId)) {
    fail('invalid_params', `pageId 已被使用：${a.pageId}`, { pageId: a.pageId });
  }
  ctx.dispatched = true;
  const id = await ctx.s.pages.newPage({ pageId: a.pageId });
  const p = ctx.s.pages.get(id);
  watchPage(ctx.st, p);
  ctx.newPages.push(id);
  ctx.pageId = id;
  ctx.page = p;
  if (a.url) {
    ctx.navigated = true;
    let url: string;
    try {
      url = new URL(a.url).href;
    } catch {
      fail('invalid_params', `URL 无效：${a.url}`, { url: a.url });
    }
    const resp = await p
      .goto(url, { waitUntil: 'domcontentloaded', timeout: ctx.timeout })
      .catch((e) => navError(e, '打开页面'));
    ctx.data = { pageId: id, url: p.url(), status: resp?.status() ?? null };
  } else ctx.data = { pageId: id };
}

/** 各 op 的处理函数（new_page、wait_for、assert、extract 在 index.ts）。 */
export const HANDLERS: Record<string, Handler> = {
  click,
  hover,
  fill,
  fill_form: fillForm,
  type_text: typeText,
  press_key: pressKey,
  drag,
  upload_file: uploadFile,
  handle_dialog: handleDialog,
  scroll,
  click_at: clickAt,
  mouse_move: mouseMove,
  navigate_page: navigatePage,
  select_page: selectPage,
  close_page: closePage,
  take_screenshot: takeScreenshot,
  evaluate_script: evaluateScript,
};
