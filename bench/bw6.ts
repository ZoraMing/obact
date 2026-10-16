// BW-6 定位可靠性（PRD 9.4；9.2 “定位可靠性”：动态 id、类名等场景全部通过，定位器失效时一律转人工，误点为 0）。
//
// 做法：录制器在 M3 才有，这里用“observe 选中元素 → generateLocator 存下定位器”代替录制；
// 录制一次，刷新或改版后只用存下的定位器回放（act 的目标是定位器，不用编号）。
// 每次回放按页面上的真实事件（夹具自带的点击记录、Lab 页面里装的事件记录）判定为三类之一：
//   命中   动作成功，且落在语义相同的元素上；
//   转人工 动作报错（not_found、not_unique、obscured 等），页面上没有任何事件；
//   误点   动作成功但落在别的元素上，或报错之前页面已经收到了事件。
// 通过标准：动态属性场景全部命中；改版后误点为 0（要么点中语义相同的元素，要么报错转人工）；
// 每一项还要与“期望”一致（期望由夹具的设计决定，见各场景的注释）。
//
// 场景（默认跑本地）：
//   动态属性     dynamic-attrs：刷新后 id 与类名全变（换 seed、不带 seed、reload）
//   Shadow DOM   structure：开放、嵌套、封闭的 Shadow Root
//   隐藏层       overlays：点一次后元素被透明层盖住，再点必须报 obscured
//   遮挡         overlays：透明引导层、Cookie 提示条、定时广告；无规则转人工，有规则（onObscured）处理后命中
//   动画按钮     timing：等位置稳定再点；一直在动的按钮转人工
//   滚动到可见   virtual-table 的滚动容器、Lab 订单列表视口外的行
//   改版夹具     redesign：原版录制，v1~v6 回放（18 个元素 × 6 个改版）
//   Lab 改版     订单列表的 faults.redesign 1~4
// --live：UI Testing Playground（dynamicid、classattr、hiddenlayers、overlapped、animation、shadowdom、scrollbars）。
//   本容器访问不了公开站点：按站点公开的页面结构写成，只做了类型检查，未实测。
//
// 用法：
//   node bench/bw6.ts            本地全部场景
//   node bench/bw6.ts --live     只跑公开站点（未实测）
//   node bench/bw6.ts --all      两者都跑
// 结果表打印到终端，同时写到 bench/out/bw6-report.md 与 bw6-results.json。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type ActOptions,
  act,
  generateLocator,
  generateLocatorForHandle,
  launchBrowser,
  observe,
  Session,
} from '@obact/core';
import type { Action, ActResult, Locator, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { type FixtureServer, startFixtures } from '../fixtures/server.ts';
import { createLab, type Lab } from '../lab/src/app.ts';
import auth from '../lab/src/modules/auth.ts';
import { viewOf } from '../lab/src/modules/orders/view.ts';
import orders from '../lab/src/modules/orders.ts';
import { testChrome } from '../tools/browser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, 'out');

/** UI Testing Playground 的地址（--live 用）。 */
export const LIVE_BASE = 'http://www.uitestingplayground.com';
export const LIVE_NOTE =
  '未实测：本环境访问不了公开站点，按站点公开的页面结构写成，只做了类型检查，需要在能上网的机器上跑一遍确认';

// ---------------------------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------------------------

export type Outcome = 'hit' | 'manual' | 'wrong';
export const OUTCOME_LABEL: Record<Outcome, string> = {
  hit: '命中',
  manual: '转人工',
  wrong: '误点',
};

export type Item = {
  /** 场景分组：动态属性、Shadow DOM、隐藏层、遮挡、动画按钮、滚动到可见、改版夹具、Lab 改版、公开站点。 */
  group: string;
  /** 回放时的页面状态：如“刷新 seed=12”“v3 改层级”。 */
  scenario: string;
  element: string;
  expected: Outcome;
  outcome: Outcome;
  /** 命中时的定位方式（locator_used）。 */
  via: string | null;
  /** 转人工时的错误码。 */
  code: string | null;
  /** 转人工的错误码不在允许范围内（如 internal、timeout）。 */
  unexpected: boolean;
  detail: string;
  /** 公开站点的项目（未实测）。 */
  live?: boolean;
};

export type Summary = {
  total: number;
  hit: number;
  manual: number;
  wrong: number;
  /** 与期望不一致的项数。 */
  mismatched: number;
  /** 转人工的错误码不在允许范围内的项数。 */
  unexpected: number;
  byGroup: Record<string, { hit: number; manual: number; wrong: number; total: number }>;
};

export type Bw6Report = {
  /** 本地场景的结果。 */
  items: Item[];
  summary: Summary;
  /** 公开站点的结果（未实测时 items 为空）。 */
  live: { requested: boolean; reachable: boolean; note: string; items: Item[]; summary: Summary };
  /** 动态属性场景全部命中、误点为 0、与期望一致、没有意外错误码。 */
  pass: boolean;
  /** 不通过的原因（通过时为空）。 */
  failures: string[];
  reportPath: string;
  jsonPath: string;
};

export type RunOptions = {
  /** 本地场景，默认 true。 */
  local?: boolean;
  /** 公开站点场景（未实测），默认 false。 */
  live?: boolean;
  /** 结果输出目录，默认 bench/out。 */
  outDir?: string;
  chromePath?: string;
  /** 公开站点的地址，默认 LIVE_BASE；测试用桩站点时改它。 */
  liveBase?: string;
  /** 不向终端打印。 */
  quiet?: boolean;
};

/** 报这些错误码都算“转人工”：定位器失效或页面状态不允许操作，没有点出去。 */
const MANUAL_CODES = new Set([
  'not_found',
  'not_unique',
  'obscured',
  'not_actionable',
  'landing_mismatch',
]);

// ---------------------------------------------------------------------------------------------
// 环境：夹具服务、Lab、浏览器、会话
// ---------------------------------------------------------------------------------------------

type Env = {
  fixtures: FixtureServer | null;
  lab: Lab | null;
  browser: Browser;
  session: Session;
  /** 新开标签页打开夹具路径，返回 pageId。 */
  open(path: string): Promise<string>;
  /** 执行动作并校验返回值符合契约。 */
  run(a: Action, opts?: ActOptions): Promise<ActResult>;
  close(): Promise<void>;
};

const contracts = new Contracts();

async function startEnv(o: { local: boolean; chromePath?: string }): Promise<Env> {
  const chromePath = o.chromePath ?? process.env.CHROME_PATH ?? (await testChrome());
  const fixtures = o.local ? await startFixtures() : null;
  const lab = o.local ? await createLab({ modules: [auth, orders] }) : null;
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-bw6-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
  });
  const session = await Session.attach(browser);
  return {
    fixtures,
    lab,
    browser,
    session,
    async open(path) {
      if (!fixtures) throw new Error('没有启动本地夹具服务');
      const pageId = await session.pages.newPage();
      await session.pages.get(pageId).goto(fixtures.base + path, { waitUntil: 'load' });
      return pageId;
    },
    async run(a, opts) {
      const r = await act(session, a, opts);
      contracts.assert('act-result', r);
      return r;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await lab?.close();
      await fixtures?.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

const win = (id: string, env: Env) => env.session.pages.get(id);

/** 动作必须成功（录制、准备步骤用）。 */
async function must(env: Env, a: Action, opts?: ActOptions): Promise<ActResult> {
  const r = await env.run(a, opts);
  if (r.status !== 'ok') throw new Error(`${a.op} 失败：${r.error?.code} ${r.error?.message}`);
  return r;
}

const closePage = (env: Env, pageId: string) => env.run({ op: 'close_page', pageId });

// ---------------------------------------------------------------------------------------------
// 录制：observe 选中元素 → generateLocator 存下定位器
// ---------------------------------------------------------------------------------------------

type Rec = { locator: Locator; role: string; name: string };

type Query = { name: string; role?: string; within?: string; top?: boolean };

/** 在 observe 结果里选一个元素（相当于录制时用户点的那个）；找不到或有歧义直接报错。 */
function pick(ob: ObserveResult, q: Query): ObservedElement {
  const list = ob.elements.filter(
    (e) =>
      e.name === q.name &&
      (q.role === undefined || e.role === q.role) &&
      (q.within === undefined || e.within === q.within) &&
      (!q.top || !e.frame?.length),
  );
  if (list.length !== 1) {
    throw new Error(`录制时选不到唯一元素 ${JSON.stringify(q)}（找到 ${list.length} 个）`);
  }
  return list[0] as ObservedElement;
}

/** 把编号转成持久定位器存下；生成不了唯一定位器就是夹具或内核的问题，直接报错。 */
async function record(env: Env, pageId: string, e: ObservedElement): Promise<Rec> {
  const g = await generateLocator(env.session, pageId, e.ref);
  if (!g.unique) {
    throw new Error(`录制时生成不了唯一定位器：${e.role} "${e.name}" ${JSON.stringify(g.locator)}`);
  }
  return { locator: g.locator, role: e.role, name: e.name };
}

// ---------------------------------------------------------------------------------------------
// 回放与判定
// ---------------------------------------------------------------------------------------------

/** 页面上的事件记录：每次 drain 返回上次之后新增的事件键。 */
type Probe = { drain(): Promise<string[]> };

/** 把几个记录合在一起。 */
function combine(...ps: Probe[]): Probe {
  return {
    async drain() {
      return (await Promise.all(ps.map((p) => p.drain()))).flat();
    },
  };
}

/** 页面里只增不减的数组（window[name]）：每个条目转成事件键。 */
async function listProbe<T>(
  env: Env,
  pageId: string,
  name: string,
  key: (x: T) => string,
): Promise<Probe> {
  const read = () =>
    win(pageId, env).evaluate(
      (n) => (window as unknown as Record<string, unknown[]>)[n] ?? [],
      name,
    ) as Promise<T[]>;
  let cursor = (await read()).length;
  return {
    async drain() {
      const all = await read();
      const out = all.slice(cursor).map(key);
      cursor = all.length;
      return out;
    },
  };
}

/** 页面里会被覆盖的状态（输入框的值、状态栏文字）：值变了就产生一个事件键。 */
function stateProbe(env: Env, pageId: string, read: () => unknown, label: string): Probe {
  let last: string | null = null;
  return {
    async drain() {
      const v = String(await win(pageId, env).evaluate(read));
      if (last === null) {
        last = v;
        return [];
      }
      if (v === last) return [];
      last = v;
      return [`${label}:${v}`];
    },
  };
}

/** 改版夹具的事件记录：window.__events 里是 { type, key, tag }；key 为空表示落在没有身份的地方。 */
async function redesignProbe(env: Env, pageId: string): Promise<Probe> {
  const page = win(pageId, env);
  await page.evaluate(() => (window as unknown as { __events: unknown[] }).__events.splice(0));
  return {
    async drain() {
      const ev = await page.evaluate(() =>
        (window as unknown as { __events: { key: string | null; tag: string }[] }).__events.splice(
          0,
        ),
      );
      return ev.map((e) => e.key ?? `(${e.tag})`);
    },
  };
}

type Trial = {
  group: string;
  scenario: string;
  element: string;
  expected: Outcome;
  action: Action;
  opts?: ActOptions;
  /** 动作成功时页面上必须出现的事件键。 */
  expect: string[];
  /** 允许出现的事件键（默认等于 expect）；出现其他键就是落在了别的元素上。 */
  allow?: string[];
  /** 动作报错时允许存在的事件键（如规则自己执行的动作）。 */
  benign?: string[];
  /** 期望转人工时允许的错误码。 */
  codes?: string[];
};

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 回放一次并判定：命中、转人工、误点。 */
async function play(env: Env, probe: Probe, t: Trial): Promise<Item> {
  await probe.drain();
  const r = await env.run(t.action, t.opts);
  // 点击触发了 confirm / alert：消掉，免得挡住后面的动作
  const pending = r.effects.dialogs.filter((d) => d.handled === 'pending');
  if (pending.length) {
    await env.run({
      op: 'handle_dialog',
      pageId: (t.action as { pageId: string }).pageId,
      action: t.action.op === 'click' && pending[0]?.type === 'alert' ? 'accept' : 'dismiss',
    });
  }
  const events = await probe.drain();
  const allow = new Set(t.allow ?? t.expect);
  const base = {
    group: t.group,
    scenario: t.scenario,
    element: t.element,
    expected: t.expected,
    via: null as string | null,
    code: null as string | null,
    unexpected: false,
  };
  if (r.status === 'ok') {
    const missing = t.expect.filter((k) => !events.includes(k));
    const stray = events.filter((k) => !allow.has(k));
    if (!missing.length && !stray.length) {
      return {
        ...base,
        outcome: 'hit',
        via: r.locator_used ?? null,
        detail: `${r.locator_used ?? ''}${events.length ? `；事件 ${events.join('、')}` : ''}`,
      };
    }
    return {
      ...base,
      outcome: 'wrong',
      via: r.locator_used ?? null,
      detail: `动作成功但页面事件不符：${events.length ? events.join('、') : '（无事件）'}，期望 ${t.expect.join('、') || '（无）'}`,
    };
  }
  const code = r.error?.code ?? 'internal';
  const stray = events.filter((k) => !(t.benign ?? []).includes(k));
  if (stray.length) {
    return {
      ...base,
      outcome: 'wrong',
      code,
      detail: `报错 ${code}，但页面已收到事件：${stray.join('、')}`,
    };
  }
  const allowedCode = MANUAL_CODES.has(code) && (!t.codes || t.codes.includes(code));
  return {
    ...base,
    outcome: 'manual',
    code,
    unexpected: !allowedCode,
    detail: `${code}：${short(r.error?.message ?? '')}`,
  };
}

// ---------------------------------------------------------------------------------------------
// 场景一：动态属性（dynamic-attrs）
// ---------------------------------------------------------------------------------------------

type DynLog = { op: string; order: string | null };

/** 页面上所有 id 与类名（除挂载点 #root 外全部是动态生成的）。 */
const pageTokens = (env: Env, pageId: string) =>
  win(pageId, env).evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll('*')) {
      if (el.id && el.id !== 'root') out.add(el.id);
      for (const c of el.classList) out.add(c);
    }
    return [...out];
  });

async function dynamicAttrs(env: Env): Promise<Item[]> {
  const group = '动态属性';
  const items: Item[] = [];
  const pageId = await env.open('/dynamic-attrs/?seed=11');
  const ob = await observe(env.session, { pageId });
  const row = (no: string) => `tr[data-row-key='${no}']`;
  const rowBtn = (name: string, no: string) =>
    record(env, pageId, pick(ob, { name, within: row(no) }));
  // [data-op 记录的操作名, 按钮名称, 订单号]：同名按钮靠业务主键（订单号）消歧
  const plan: [string, string, string][] = [
    ['编辑', '编辑', 'SO-24003'],
    ['删除', '删除', 'SO-24005'],
    ['编辑', '编辑', 'SO-24001'],
    ['删除', '删除', 'SO-24006'],
    ['查看', '详情', 'SO-24002'],
    ['编辑', '编辑', 'SO-24004'],
  ];
  const rows = await Promise.all(plan.map(([, name, no]) => rowBtn(name, no)));
  const search = await record(env, pageId, pick(ob, { name: '按订单号或客户搜索' }));
  const query = await record(env, pageId, pick(ob, { name: '查询' }));
  const refresh = await record(env, pageId, pick(ob, { name: '刷新' }));
  const create = await record(env, pageId, pick(ob, { name: '新建订单' }));
  const before = await pageTokens(env, pageId);

  const base = env.fixtures?.base ?? '';
  const phases: { label: string; nav: Action }[] = [
    {
      label: '换 seed=12',
      nav: { op: 'navigate_page', pageId, url: `${base}/dynamic-attrs/?seed=12` },
    },
    {
      label: '换 seed=31337',
      nav: { op: 'navigate_page', pageId, url: `${base}/dynamic-attrs/?seed=31337` },
    },
    {
      label: '不带 seed（随机）',
      nav: { op: 'navigate_page', pageId, url: `${base}/dynamic-attrs/` },
    },
    { label: 'reload（随机）', nav: { op: 'navigate_page', pageId, type: 'reload' } },
  ];
  for (const ph of phases) {
    await must(env, ph.nav);
    const now = await pageTokens(env, pageId);
    const kept = now.filter((t) => before.includes(t)).length;
    const scenario = `刷新：${ph.label}（id、类名沿用 ${kept}/${now.length}）`;
    const probe = combine(
      await listProbe<DynLog>(env, pageId, '__log', (x) => `${x.op}|${x.order ?? ''}`),
      stateProbe(
        env,
        pageId,
        () =>
          (document.querySelector('input[placeholder="按订单号或客户搜索"]') as HTMLInputElement)
            .value,
        'value',
      ),
    );
    const t = (element: string, action: Action, expect: string[]): Trial => ({
      group,
      scenario,
      element,
      expected: 'hit',
      action,
      expect,
    });
    for (const [i, [op, name, no]] of plan.entries()) {
      items.push(
        await play(
          env,
          probe,
          t(`${name} ${no}`, { op: 'click', pageId, target: (rows[i] as Rec).locator }, [
            `${op}|${no}`,
          ]),
        ),
      );
    }
    items.push(
      await play(
        env,
        probe,
        t(
          '搜索框（填 SO-24003）',
          { op: 'fill', pageId, target: search.locator, value: 'SO-24003' },
          ['value:SO-24003'],
        ),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('查询', { op: 'click', pageId, target: query.locator }, ['查询“SO-24003”|']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('刷新图标按钮', { op: 'click', pageId, target: refresh.locator }, ['刷新|']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('新建订单', { op: 'click', pageId, target: create.locator }, ['新建|']),
      ),
    );
  }
  await closePage(env, pageId);
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景二：Shadow DOM（structure）
// ---------------------------------------------------------------------------------------------

async function shadowDom(env: Env): Promise<Item[]> {
  const group = 'Shadow DOM';
  const items: Item[] = [];
  const pageId = await env.open('/structure/');
  const ob = await observe(env.session, { pageId });
  // 开放（关注）、嵌套在开放里的开放（收藏）、封闭（金额、支付）
  const follow = await record(env, pageId, pick(ob, { name: '关注', top: true }));
  const star = await record(env, pageId, pick(ob, { name: '收藏', top: true }));
  const amount = await record(env, pageId, pick(ob, { name: '金额', top: true }));
  const pay = await record(env, pageId, pick(ob, { name: '支付', top: true }));
  // 前两轮刷新后直接回放（页面没有 observe 过）；第三轮先 observe 一次再回放
  for (const [round, label] of [
    '刷新（reload）直接回放',
    '再刷新（reload）直接回放',
    '刷新后先 observe 再回放',
  ].entries()) {
    await must(env, { op: 'navigate_page', pageId, type: 'reload' });
    if (round === 2) await observe(env.session, { pageId });
    const probe = await listProbe<string>(env, pageId, '__log', (x) => x);
    const t = (element: string, action: Action, expect: string[]): Trial => ({
      group,
      scenario: label,
      element,
      expected: 'hit',
      action,
      expect,
    });
    items.push(
      await play(
        env,
        probe,
        t('关注（开放 Shadow Root）', { op: 'click', pageId, target: follow.locator }, ['已关注']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('收藏（嵌套的开放 Shadow Root）', { op: 'click', pageId, target: star.locator }, [
          '已收藏',
        ]),
      ),
    );
    // 填写没有页面事件：金额由随后“支付”的记录核对（已支付 88 元）
    items.push(
      await play(
        env,
        probe,
        t(
          '金额（封闭 Shadow Root，填 88）',
          { op: 'fill', pageId, target: amount.locator, value: '88' },
          [],
        ),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t(
          '支付（封闭 Shadow Root，记录里的金额须为 88）',
          { op: 'click', pageId, target: pay.locator },
          ['已支付 88 元'],
        ),
      ),
    );
  }
  await closePage(env, pageId);
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景三、四：隐藏层、遮挡（overlays）
// ---------------------------------------------------------------------------------------------

const btn = (name: string) => ({ role: 'button', name });

/**
 * 弹窗规则（模拟 FR-23 的规则文件）：按命中元素决定处理动作，用 act 执行；没有命中返回 false。
 * 规则自己执行的动作会在页面上留下事件（点“接受全部”等），判定误点时按 benign 放过。
 */
function popupRules(
  env: Env,
  pageId: string,
  calls: string[],
): NonNullable<ActOptions['onObscured']> {
  return async (info) => {
    let name: string;
    let action: Action;
    if (/cookie-banner/.test(info.hit)) {
      name = 'cookie';
      action = { op: 'click', pageId, target: btn('接受全部') };
    } else if (/ad-backdrop|ad-dialog/.test(info.hit)) {
      name = 'ad';
      action = { op: 'click', pageId, target: btn('关闭广告') };
    } else if (/tour-mask/.test(info.hit)) {
      name = 'tour';
      action = { op: 'press_key', pageId, key: 'Escape' };
    } else return false;
    calls.push(name);
    return (await env.run(action)).status === 'ok';
  };
}

async function overlays(env: Env): Promise<Item[]> {
  const items: Item[] = [];
  const logKey = (x: string) => x;

  // —— 隐藏层：点一次后绿色按钮被透明层盖住（同 UI Testing Playground 的 Hidden Layers）
  {
    const group = '隐藏层';
    const first = await env.open('/overlays/');
    const ob = await observe(env.session, { pageId: first });
    const green = await record(env, first, pick(ob, { name: '绿色按钮' }));
    await closePage(env, first);

    const pageId = await env.open('/overlays/');
    const probe = await listProbe<string>(env, pageId, '__log', logKey);
    items.push(
      await play(env, probe, {
        group,
        scenario: '刷新后首次点击',
        element: '绿色按钮',
        expected: 'hit',
        action: { op: 'click', pageId, target: green.locator },
        expect: ['green'],
      }),
    );
    items.push(
      await play(env, probe, {
        group,
        scenario: '点击后被透明层盖住，再点',
        element: '绿色按钮',
        expected: 'manual',
        action: { op: 'click', pageId, target: green.locator, timeout_ms: 1500 },
        expect: [],
        codes: ['obscured'],
      }),
    );
    await closePage(env, pageId);
  }

  // —— 遮挡：透明引导层、Cookie 提示条、定时广告；先不处理（转人工），再用规则处理（命中）
  {
    const group = '遮挡';
    const first = await env.open('/overlays/');
    const ob = await observe(env.session, { pageId: first });
    const submit = await record(env, first, pick(ob, { name: '提交申请' }));
    const next = await record(env, first, pick(ob, { name: '下一步' }));
    const green = await record(env, first, pick(ob, { name: '绿色按钮' }));
    await closePage(env, first);

    const blocked = (
      element: string,
      scenario: string,
      pageId: string,
      target: Locator,
    ): Trial => ({
      group,
      scenario,
      element,
      expected: 'manual',
      action: { op: 'click', pageId, target, timeout_ms: 1500 },
      expect: [],
      codes: ['obscured'],
    });

    // 透明引导层盖住“提交申请”，按 Esc 关闭
    {
      const pageId = await env.open('/overlays/');
      const probe = await listProbe<string>(env, pageId, '__log', logKey);
      items.push(
        await play(env, probe, blocked('提交申请', '透明引导层，无规则', pageId, submit.locator)),
      );
      const calls: string[] = [];
      items.push(
        await play(env, probe, {
          group,
          scenario: '透明引导层，规则 Esc 关闭后重试',
          element: '提交申请',
          expected: 'hit',
          action: { op: 'click', pageId, target: submit.locator },
          opts: { onObscured: popupRules(env, pageId, calls) },
          expect: ['tour-closed', 'submit'],
          benign: ['tour-closed'],
        }),
      );
      await closePage(env, pageId);
    }
    // Cookie 提示条盖住“下一步”
    {
      const pageId = await env.open('/overlays/');
      const probe = await listProbe<string>(env, pageId, '__log', logKey);
      items.push(
        await play(env, probe, blocked('下一步', 'Cookie 提示条，无规则', pageId, next.locator)),
      );
      const calls: string[] = [];
      items.push(
        await play(env, probe, {
          group,
          scenario: 'Cookie 提示条，规则“接受全部”后重试',
          element: '下一步',
          expected: 'hit',
          action: { op: 'click', pageId, target: next.locator },
          opts: { onObscured: popupRules(env, pageId, calls) },
          expect: ['cookie-accept', 'next'],
          benign: ['cookie-accept'],
        }),
      );
      await closePage(env, pageId);
    }
    // 按 seed 定时弹出的广告层盖住“绿色按钮”：等广告出现（条件等待）后再点
    {
      const pageId = await env.open('/overlays/?ad=timer&seed=4');
      await must(env, {
        op: 'wait_for',
        pageId,
        until: [{ element_present: { role: 'dialog', name: '限时优惠' } }],
        timeout_ms: 3000,
      });
      const probe = await listProbe<string>(env, pageId, '__log', logKey);
      items.push(
        await play(env, probe, blocked('绿色按钮', '定时广告层，无规则', pageId, green.locator)),
      );
      const calls: string[] = [];
      items.push(
        await play(env, probe, {
          group,
          scenario: '定时广告层，规则“关闭广告”后重试',
          element: '绿色按钮',
          expected: 'hit',
          action: { op: 'click', pageId, target: green.locator },
          opts: { onObscured: popupRules(env, pageId, calls) },
          expect: ['ad-close', 'green'],
          benign: ['ad-close'],
        }),
      );
      await closePage(env, pageId);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景五：动画按钮（timing）
// ---------------------------------------------------------------------------------------------

async function animation(env: Env): Promise<Item[]> {
  const group = '动画按钮';
  const items: Item[] = [];
  const first = await env.open('/timing/');
  const ob = await observe(env.session, { pageId: first });
  const start = await record(env, first, pick(ob, { name: '开始动画' }));
  const target = await record(env, first, pick(ob, { name: '移动目标' }));
  const wobble = await record(env, first, pick(ob, { name: '摇摆按钮' }));
  await closePage(env, first);

  const pageId = await env.open('/timing/');
  const probe = combine(
    await listProbe<string>(env, pageId, '__log', (x) => x),
    stateProbe(
      env,
      pageId,
      () => (document.getElementById('anim-target') as HTMLElement).style.transform || 'idle',
      'transform',
    ),
  );
  const scenario = '刷新后回放';
  items.push(
    await play(env, probe, {
      group,
      scenario,
      element: '开始动画',
      expected: 'hit',
      action: { op: 'click', pageId, target: start.locator },
      expect: ['transform:translateX(320px)'],
    }),
  );
  // 目标在 1 秒内匀速平移：等位置稳定后才点，点下去时动画已结束
  items.push(
    await play(env, probe, {
      group,
      scenario,
      element: '移动目标（点击时须已停止移动）',
      expected: 'hit',
      action: { op: 'click', pageId, target: target.locator },
      expect: ['anim-target:still'],
    }),
  );
  // 一直在动的按钮永远不稳定：不能点
  items.push(
    await play(env, probe, {
      group,
      scenario,
      element: '摇摆按钮（一直在动）',
      expected: 'manual',
      action: { op: 'click', pageId, target: wobble.locator, timeout_ms: 800 },
      expect: [],
      codes: ['not_actionable'],
    }),
  );
  await closePage(env, pageId);
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景六：滚动到可见再点击
// ---------------------------------------------------------------------------------------------

async function scrollIntoView(env: Env): Promise<Item[]> {
  const group = '滚动到可见';
  const items: Item[] = [];
  // 虚拟滚动表格的滚动容器（高 480）：已渲染但被容器裁掉的行，要先滚动容器才能点。
  // 两种位置：按钮在视口外（常见的“滚动到可见”）；按钮几何上在视口内、却被容器裁掉（UI Testing Playground 的
  // Overlapped Element、Scrollbars 就是这一类：视口够高，页面不用滚，要滚的是容器）。
  const cases = [
    { row: 'R00018', height: null, inView: false, label: '在视口外，被滚动容器裁掉' },
    { row: 'R00017', height: 900, inView: true, label: '在视口内，但被滚动容器裁掉' },
  ];
  for (const c of cases) {
    const rowSel = `div[data-id='${c.row}']`;
    const openAt = async () => {
      const pageId = await env.session.pages.newPage();
      if (c.height) await win(pageId, env).setViewport({ width: 1280, height: c.height });
      await win(pageId, env).goto(`${env.fixtures?.base}/virtual-table/`, { waitUntil: 'load' });
      await must(env, {
        op: 'wait_for',
        pageId,
        until: [{ element_present: { role: 'button', name: '查看', within: rowSel } }],
      });
      return pageId;
    };
    const first = await openAt();
    const ob = await observe(env.session, { pageId: first });
    const view = await record(env, first, pick(ob, { name: '查看', within: rowSel }));
    await closePage(env, first);

    const pageId = await openAt();
    const where = await win(pageId, env).evaluate((sel) => {
      const b = (document.querySelector(`${sel} button`) as HTMLElement).getBoundingClientRect();
      const vp = (document.getElementById('viewport') as HTMLElement).getBoundingClientRect();
      return { clipped: b.top >= vp.bottom, inView: b.bottom <= innerHeight, vh: innerHeight };
    }, rowSel);
    // 点“查看”后页面上方的详情栏显示“当前查看：R00018 …”：取出订单号作为事件
    const probe = stateProbe(
      env,
      pageId,
      () => /R\d+/.exec(document.getElementById('detail')?.textContent ?? '')?.[0] ?? '',
      'viewed',
    );
    await probe.drain();
    const item = await play(env, probe, {
      group,
      scenario: `刷新后回放（视口高 ${where.vh}，按钮${c.label}）`,
      element: `第 ${Number(c.row.slice(1))} 行“查看”`,
      expected: 'hit',
      action: { op: 'click', pageId, target: view.locator },
      expect: [`viewed:${c.row}`],
    });
    if (item.outcome === 'hit' && !(where.clipped && where.inView === c.inView)) {
      item.outcome = 'wrong';
      item.detail = `前提不成立：按钮应${c.label}，实际 clipped=${where.clipped} inView=${where.inView}`;
    }
    items.push(item);
    await closePage(env, pageId);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景七：改版夹具（redesign）
// ---------------------------------------------------------------------------------------------

/** 原版上的全部可操作元素（data-x-key，只用来识别语义身份，定位器不使用）。 */
const KEYS = [
  'search',
  'search-btn',
  'help',
  'close',
  'notice-close',
  'create',
  'import',
  'export',
  'customer',
  'phone',
  'status',
  'remark',
  'urgent',
  'remove-apple',
  'remove-pear',
  'save',
  'cancel',
  'delete',
];

/**
 * 各改版的期望（与 fixtures/test/redesign.test.ts 一致），未列出的元素期望命中：
 * v1 改 id：CSS 失效，角色+名称兜底；v2 改文案：角色+名称失效，CSS 兜底；v3 改层级：两类都还有效；
 * v4 移动位置：工具栏 id 按位置编号，换顺序后 CSS 指向别的按钮（冲突转人工）；无名关闭图标挪出提示条，也不能退而点容器里别的按钮；
 * v5 id 挪用：两对元素互换 id，CSS 与角色+名称指向不同元素（冲突转人工）；v6 全面改版：两类都失效。
 */
const REDESIGN: { v: string; label: string; manual: string[] }[] = [
  { v: 'v0', label: '原版刷新', manual: [] },
  { v: 'v1', label: '改 id', manual: [] },
  { v: 'v2', label: '改文案', manual: [] },
  { v: 'v3', label: '改层级', manual: [] },
  { v: 'v4', label: '移动位置', manual: ['create', 'import', 'export', 'notice-close'] },
  { v: 'v5', label: 'id 挪用', manual: ['customer', 'phone', 'save', 'cancel'] },
  { v: 'v6', label: '全面改版', manual: KEYS },
];

async function redesignFixture(env: Env): Promise<Item[]> {
  const group = '改版夹具';
  const items: Item[] = [];
  const recs = new Map<string, Rec>();
  const first = await env.open('/redesign/v0.html');
  const ob = await observe(env.session, { pageId: first });
  for (const e of ob.elements) {
    const key = await win(first, env).evaluate(
      (attr, ref) =>
        document.querySelector(`[${attr}="${ref}"]`)?.getAttribute('data-x-key') ?? null,
      env.session.attr,
      e.ref,
    );
    if (key) recs.set(key, await record(env, first, e));
  }
  await closePage(env, first);
  const missing = KEYS.filter((k) => !recs.has(k));
  if (missing.length) throw new Error(`原版上没有录到：${missing.join('、')}`);

  for (const { v, label, manual } of REDESIGN) {
    const pageId = await env.open(`/redesign/${v}.html`);
    const probe = await redesignProbe(env, pageId);
    for (const key of KEYS) {
      const rec = recs.get(key) as Rec;
      const base = { pageId, target: rec.locator, timeout_ms: 400 };
      const action: Action =
        rec.role === 'textbox' || rec.role === 'searchbox'
          ? { op: 'fill', ...base, value: `值-${key}` }
          : rec.role === 'combobox'
            ? { op: 'fill', ...base, value: '已发货' }
            : { op: 'click', ...base };
      items.push(
        await play(env, probe, {
          group,
          scenario: `${v} ${label}`,
          element: `${key}（${rec.role} "${rec.name}"）`,
          expected: manual.includes(key) ? 'manual' : 'hit',
          action,
          expect: [key],
          codes: ['not_found', 'not_unique'],
        }),
      );
    }
    await closePage(env, pageId);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// 场景八：Lab 订单列表的改版（faults.redesign）与滚动到可见
// ---------------------------------------------------------------------------------------------

const LAB_SEED = 20260101;

type LabOrder = { id: string; status: string };

type LabCtx = {
  env: Env;
  space: string;
  cookie: string;
  setRedesign(r: number): Promise<void>;
  orders(): Promise<LabOrder[]>;
  /** 打开订单列表（按当前改版），等到加载完成，并装上事件记录。 */
  openOrders(r: number): Promise<{ pageId: string; probe: Probe }>;
};

/** 登录（HTTP）、把会话 cookie 交给浏览器；用固定种子重置，订单号可复现。 */
async function labContext(env: Env, space: string): Promise<LabCtx> {
  const lab = env.lab as Lab;
  const base = lab.url(space);
  await fetch(`${base}/_lab/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: LAB_SEED }),
  });
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'alice', password: 'alice123' }).toString(),
    redirect: 'manual',
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const [name, value] = cookie.split('=') as [string, string];
  if (name !== 'lab_session') throw new Error(`Lab 登录失败：HTTP ${r.status}`);
  await env.browser.setCookie({
    name,
    value,
    domain: '127.0.0.1',
    path: `/s/${space}/`,
    httpOnly: true,
  });
  const setRedesign = async (n: number) => {
    await fetch(`${base}/_lab/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redesign: n }),
    });
  };
  return {
    env,
    space,
    cookie,
    setRedesign,
    async orders() {
      const res = await fetch(`${base}/api/orders?page_size=500`, { headers: { cookie } });
      return ((await res.json()) as { items: LabOrder[] }).items;
    },
    async openOrders(n) {
      await setRedesign(n);
      const pageId = await env.session.pages.newPage();
      await env.session.pages.get(pageId).goto(`${base}/orders`, { waitUntil: 'load' });
      await must(env, { op: 'wait_for', pageId, until: [{ text_present: '共 200 条' }] });
      await installLabRecorder(env, pageId, n);
      return { pageId, probe: await listProbe<string>(env, pageId, '__bw6', (x) => x) };
    },
  };
}

/**
 * 在 Lab 订单页里装事件记录：把每次点击、输入落在哪个元素上记成语义键。
 * 语义键来自 Lab 自己的页面定义（viewOf：各改版的 id、类名），与定位器无关，用来判断有没有点错。
 */
async function installLabRecorder(env: Env, pageId: string, redesign: number): Promise<void> {
  const v = viewOf(redesign);
  await win(pageId, env).evaluate(
    (ids, cls) => {
      const w = window as unknown as { __bw6: string[] };
      w.__bw6 = [];
      const byId = new Map(Object.entries(ids).map(([k, id]) => [id, k]));
      const keyOf = (el: Element): string => {
        const h = el as HTMLElement;
        const known = byId.get(el.id);
        if (known) return known;
        if (el.classList.contains(cls.approve)) return `approve:${h.dataset.id}`;
        if (el.classList.contains(cls.check)) return `check:${h.dataset.id}`;
        if (el.classList.contains(cls.sort)) return `sort:${h.dataset.key}`;
        if (el.classList.contains(cls.page)) return `page:${h.dataset.page}`;
        return `(${el.tagName.toLowerCase()})`;
      };
      // 不记 change：文本框的 change 在失焦时才触发，会被算到下一个动作头上
      for (const type of ['click', 'input']) {
        document.addEventListener(
          type,
          (e) => {
            const t = e.target instanceof Element ? e.target : null;
            const el = t?.closest('button, input, select, a, textarea') ?? t;
            if (el) w.__bw6.push(keyOf(el));
          },
          true,
        );
      }
    },
    v.ids,
    v.cls,
  );
}

/** Lab 各元素在 faults.redesign 0~4 下的期望（原因见 labRedesign 里的注释）。 */
const LAB_EXPECT: Record<string, Outcome[]> = {
  // 改版：    0       1         2         3         4
  status: ['hit', 'hit', 'hit', 'hit', 'manual'],
  keyword: ['hit', 'hit', 'hit', 'hit', 'manual'],
  search: ['hit', 'hit', 'hit', 'hit', 'manual'],
  reset: ['hit', 'hit', 'hit', 'hit', 'manual'],
  batch: ['hit', 'hit', 'hit', 'hit', 'manual'],
  check: ['hit', 'manual', 'hit', 'manual', 'manual'],
  approve: ['hit', 'hit', 'hit', 'manual', 'manual'],
  sort: ['hit', 'hit', 'hit', 'manual', 'manual'],
  next: ['hit', 'hit', 'manual', 'hit', 'manual'],
};

const LAB_VARIANTS = ['0 原版刷新', '1 改 id 与类名', '2 改按钮文案', '3 表格改卡片', '4 全面改版'];

async function labRedesign(env: Env): Promise<Item[]> {
  const group = 'Lab 改版';
  const items: Item[] = [];
  const lab = await labContext(env, 'bw6-lab-redesign');
  const first20 = (await lab.orders()).slice(0, 20);
  const pending = first20.filter((o) => o.status === '待审核');
  const target = pending[1] as LabOrder;
  const tr = `tr[data-id='${target.id}']`;

  // 录制（原版）
  const rec = await lab.openOrders(0);
  const ob = await observe(env.session, { pageId: rec.pageId });
  const recs = {
    status: await record(env, rec.pageId, pick(ob, { role: 'combobox', name: '状态' })),
    keyword: await record(env, rec.pageId, pick(ob, { role: 'searchbox', name: '关键字' })),
    search: await record(env, rec.pageId, pick(ob, { role: 'button', name: '查询' })),
    reset: await record(env, rec.pageId, pick(ob, { role: 'button', name: '重置' })),
    batch: await record(env, rec.pageId, pick(ob, { role: 'button', name: '批量审核' })),
    check: await record(env, rec.pageId, pick(ob, { name: `选择订单 ${target.id}` })),
    approve: await record(env, rec.pageId, pick(ob, { role: 'button', name: '审核', within: tr })),
    sort: await record(env, rec.pageId, pick(ob, { role: 'button', name: '金额' })),
    next: await record(env, rec.pageId, pick(ob, { role: 'button', name: '下一页' })),
  };
  await closePage(env, rec.pageId);

  for (const [r, label] of LAB_VARIANTS.entries()) {
    const { pageId, probe } = await lab.openOrders(r);
    const t = (
      key: keyof typeof recs,
      element: string,
      action: Action,
      expect: string[],
    ): Trial => ({
      group,
      scenario: `redesign=${label}`,
      element,
      expected: (LAB_EXPECT[key] as Outcome[])[r] as Outcome,
      action: { ...action, timeout_ms: 400 } as Action,
      expect,
      codes: ['not_found', 'not_unique'],
    });
    const tgt = (k: keyof typeof recs) => (recs[k] as Rec).locator;
    items.push(
      await play(
        env,
        probe,
        t(
          'status',
          '状态筛选（选“已驳回”）',
          { op: 'fill', pageId, target: tgt('status'), value: '已驳回' },
          ['status'],
        ),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t(
          'keyword',
          '关键字（填 orion）',
          { op: 'fill', pageId, target: tgt('keyword'), value: 'orion' },
          ['keyword'],
        ),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('search', '查询按钮', { op: 'click', pageId, target: tgt('search') }, ['search']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('reset', '重置按钮', { op: 'click', pageId, target: tgt('reset') }, ['reset']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('check', `勾选订单 ${target.id}`, { op: 'click', pageId, target: tgt('check') }, [
          `check:${target.id}`,
        ]),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t(
          'approve',
          `订单 ${target.id} 的“审核”（点后出确认框，取消）`,
          { op: 'click', pageId, target: tgt('approve') },
          [`approve:${target.id}`],
        ),
      ),
    );
    // 批量审核：先在页面里直接勾上这一行（不走定位器；已勾上就不动），让按钮可用；再用存下的定位器点它。
    // 放在排序和翻页之前：此时这一行还在第一页
    const selected = await win(pageId, env).evaluate((id) => {
      const box = document.querySelector(`input[data-id="${id}"]`) as HTMLInputElement | null;
      if (box && !box.checked) box.click();
      return box?.checked ?? false;
    }, target.id);
    items.push(
      await play(
        env,
        probe,
        t(
          'batch',
          `批量审核按钮（点后出确认框，取消；已选中订单：${selected ? '是' : '否'}）`,
          { op: 'click', pageId, target: tgt('batch') },
          ['batch'],
        ),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('sort', '表头“金额”排序', { op: 'click', pageId, target: tgt('sort') }, ['sort:amount']),
      ),
    );
    items.push(
      await play(
        env,
        probe,
        t('next', '分页“下一页”', { op: 'click', pageId, target: tgt('next') }, ['page:next']),
      ),
    );
    await closePage(env, pageId);
  }
  return items;
}

/** 视口外的行：录制时滚动到可见，刷新后回到页面顶部，回放时要先滚动再点。 */
async function labScroll(env: Env): Promise<Item[]> {
  const group = '滚动到可见';
  const lab = await labContext(env, 'bw6-lab-scroll');
  const first20 = (await lab.orders()).slice(0, 20);
  const last = [...first20].reverse().find((o) => o.status === '待审核') as LabOrder;
  const tr = `tr[data-id='${last.id}']`;

  const rec = await lab.openOrders(0);
  await must(env, { op: 'scroll', pageId: rec.pageId, dy: 2000 });
  const ob = await observe(env.session, { pageId: rec.pageId });
  const approve = await record(
    env,
    rec.pageId,
    pick(ob, { role: 'button', name: '审核', within: tr }),
  );
  await closePage(env, rec.pageId);

  const { pageId, probe } = await lab.openOrders(0);
  const vh = (await observe(env.session, { pageId })).viewport.height;
  const top = await win(pageId, env).evaluate((sel) => {
    const b = document.querySelector(`${sel} button.row-approve`) as HTMLElement;
    return { below: b.getBoundingClientRect().top >= innerHeight, y: Math.round(scrollY) };
  }, tr);
  const item = await play(env, probe, {
    group,
    scenario: `刷新后回放（视口高 ${vh}，按钮${top.below ? '在视口下方' : '已在可见区'}）`,
    element: `订单 ${last.id} 的“审核”（第 ${first20.findIndex((o) => o.id === last.id) + 1} 行）`,
    expected: 'hit',
    action: { op: 'click', pageId, target: approve.locator },
    expect: [`approve:${last.id}`],
  });
  const scrolled = await win(pageId, env).evaluate(() => Math.round(scrollY));
  if (item.outcome === 'hit') {
    if (!top.below || scrolled <= top.y) {
      item.outcome = 'wrong';
      item.detail = `前提不成立：滚动前 y=${top.y}，滚动后 y=${scrolled}，按钮${top.below ? '' : '本来就在可见区'}`;
    } else item.detail = `${item.detail}；页面从 ${top.y} 滚动到 ${scrolled}`;
  }
  await closePage(env, pageId);
  return [item];
}

// ---------------------------------------------------------------------------------------------
// 公开站点（--live，未实测）：UI Testing Playground
// ---------------------------------------------------------------------------------------------

/** 公开站点各页面的结构（按站点公开的页面写成，未实测）。 */
async function livePlayground(env: Env, base: string): Promise<Item[]> {
  const group = '公开站点';
  const items: Item[] = [];
  const open = async (path: string) => {
    const pageId = await env.session.pages.newPage();
    await env.session.pages.get(pageId).goto(base + path, { waitUntil: 'load' });
    return pageId;
  };
  /** 用页面里的选择器取元素，再生成定位器（相当于录制时点中它）；支持 pierce/ 穿透 Shadow DOM。 */
  const recordSel = async (pageId: string, selector: string): Promise<Rec> => {
    const page = win(pageId, env);
    const h = await page.$(selector);
    if (!h) throw new Error(`找不到 ${selector}`);
    const g = await generateLocatorForHandle(env.session, pageId, page.mainFrame(), h);
    await h.dispose();
    if (!g.unique)
      throw new Error(`录制时生成不了唯一定位器：${selector} ${JSON.stringify(g.locator)}`);
    return { locator: g.locator, role: '', name: '' };
  };
  const reload = (pageId: string) => must(env, { op: 'navigate_page', pageId, type: 'reload' });
  /** 公开页面没有事件记录：只按 act 的结果判定（成功算命中，转人工的错误码算转人工），读不到误点。 */
  const trial = (
    element: string,
    scenario: string,
    expected: Outcome,
    action: Action,
    opts?: ActOptions,
  ): Promise<Item> =>
    play(
      env,
      { drain: async () => [] },
      {
        group,
        scenario,
        element,
        expected,
        action,
        opts,
        expect: [],
        codes: expected === 'manual' ? ['obscured', 'not_actionable'] : undefined,
      },
    ).then((i) => ({ ...i, live: true }));

  // dynamicid：按钮 id 每次加载都变
  {
    const p = await open('/dynamicid');
    const rec = await recordSel(p, 'button.btn-primary');
    await reload(p);
    items.push(
      await trial('Button with Dynamic ID', '刷新后', 'hit', {
        op: 'click',
        pageId: p,
        target: rec.locator,
      }),
    );
    await closePage(env, p);
  }
  // classattr：class 的顺序与组成会变，点击弹出 alert
  {
    const p = await open('/classattr');
    const rec = await recordSel(p, 'button.btn-primary');
    await reload(p);
    items.push(
      await trial('Primary 按钮（点后弹 alert）', '刷新后', 'hit', {
        op: 'click',
        pageId: p,
        target: rec.locator,
      }),
    );
    await closePage(env, p);
  }
  // hiddenlayers：第一次点绿色按钮后，蓝色层盖住它
  {
    const p = await open('/hiddenlayers');
    const rec = await recordSel(p, '#greenButton');
    await reload(p);
    items.push(
      await trial('绿色按钮', '刷新后首次点击', 'hit', {
        op: 'click',
        pageId: p,
        target: rec.locator,
      }),
    );
    items.push(
      await trial('绿色按钮', '被蓝色层盖住后再点', 'manual', {
        op: 'click',
        pageId: p,
        target: rec.locator,
        timeout_ms: 1500,
      }),
    );
    await closePage(env, p);
  }
  // overlapped：Name 输入框的一部分被 Id 输入框所在的层盖住，要滚动容器后才能填
  {
    const p = await open('/overlapped');
    const rec = await recordSel(p, '#name');
    await reload(p);
    items.push(
      await trial('Name 输入框（被部分盖住）', '刷新后', 'hit', {
        op: 'fill',
        pageId: p,
        target: rec.locator,
        value: 'obact',
      }),
    );
    await closePage(env, p);
  }
  // animation：先点“Start Animation”，再点移动中的目标
  {
    const p = await open('/animation');
    const start = await recordSel(p, '#animationButton');
    const moving = await recordSel(p, '#movingTarget');
    await reload(p);
    items.push(
      await trial('Start Animation', '刷新后', 'hit', {
        op: 'click',
        pageId: p,
        target: start.locator,
      }),
    );
    items.push(
      await trial('Moving Target', '动画中等稳定后点击', 'hit', {
        op: 'click',
        pageId: p,
        target: moving.locator,
      }),
    );
    await closePage(env, p);
  }
  // shadowdom：guid-generator 的 Shadow Root 里有 Generate 与 Copy 两个按钮
  {
    const p = await open('/shadowdom');
    const gen = await recordSel(p, 'pierce/#buttonGenerate');
    const copy = await recordSel(p, 'pierce/#buttonCopy');
    await reload(p);
    items.push(
      await trial('Generate（Shadow DOM）', '刷新后', 'hit', {
        op: 'click',
        pageId: p,
        target: gen.locator,
      }),
    );
    items.push(
      await trial('Copy（Shadow DOM）', '刷新后', 'hit', {
        op: 'click',
        pageId: p,
        target: copy.locator,
      }),
    );
    await closePage(env, p);
  }
  // scrollbars：Hiding Button 在滚动容器里，要滚动到可见再点
  {
    const p = await open('/scrollbars');
    const rec = await recordSel(p, '#hidingButton');
    await reload(p);
    items.push(
      await trial('Hiding Button', '刷新后（滚动到可见再点）', 'hit', {
        op: 'click',
        pageId: p,
        target: rec.locator,
      }),
    );
    await closePage(env, p);
  }
  return items;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// 汇总与输出
// ---------------------------------------------------------------------------------------------

function summarize(items: Item[]): Summary {
  const s: Summary = {
    total: items.length,
    hit: 0,
    manual: 0,
    wrong: 0,
    mismatched: 0,
    unexpected: 0,
    byGroup: {},
  };
  for (const i of items) {
    s[i.outcome]++;
    if (i.outcome !== i.expected) s.mismatched++;
    if (i.unexpected) s.unexpected++;
    const g = s.byGroup[i.group] ?? { hit: 0, manual: 0, wrong: 0, total: 0 };
    s.byGroup[i.group] = g;
    g[i.outcome]++;
    g.total++;
  }
  return s;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function itemsTable(items: Item[]): string[] {
  const lines = [
    '| # | 分组 | 回放场景 | 元素 | 期望 | 结果 | 说明 |',
    '|--:|---|---|---|---|---|---|',
  ];
  items.forEach((i, k) => {
    const mark = i.outcome === i.expected ? '' : ' ⚠ 与期望不符';
    lines.push(
      `| ${k + 1} | ${i.group} | ${esc(i.scenario)} | ${esc(i.element)} | ${OUTCOME_LABEL[i.expected]} | **${OUTCOME_LABEL[i.outcome]}**${mark} | ${esc(i.detail)} |`,
    );
  });
  return lines;
}

function summaryTable(s: Summary): string[] {
  const lines = ['| 分组 | 项数 | 命中 | 转人工 | 误点 |', '|---|--:|--:|--:|--:|'];
  for (const [g, v] of Object.entries(s.byGroup)) {
    lines.push(`| ${g} | ${v.total} | ${v.hit} | ${v.manual} | ${v.wrong} |`);
  }
  lines.push(`| **合计** | ${s.total} | ${s.hit} | ${s.manual} | ${s.wrong} |`);
  return lines;
}

/** 改版回放的矩阵：每个改版一行，列出命中、转人工、误点的数量。 */
function variantMatrix(items: Item[], group: string): string[] {
  const rows = new Map<string, { hit: number; manual: number; wrong: number }>();
  for (const i of items.filter((x) => x.group === group)) {
    const r = rows.get(i.scenario) ?? { hit: 0, manual: 0, wrong: 0 };
    r[i.outcome]++;
    rows.set(i.scenario, r);
  }
  const lines = ['| 改版 | 命中 | 转人工 | 误点 |', '|---|--:|--:|--:|'];
  for (const [k, r] of rows) lines.push(`| ${esc(k)} | ${r.hit} | ${r.manual} | ${r.wrong} |`);
  return lines;
}

function judge(items: Item[], s: Summary): string[] {
  const failures: string[] = [];
  const dyn = items.filter((i) => i.group === '动态属性');
  const dynBad = dyn.filter((i) => i.outcome !== 'hit');
  if (!dyn.length) failures.push('没有动态属性场景的结果');
  if (dynBad.length) failures.push(`动态属性场景有 ${dynBad.length} 项没有命中`);
  if (s.wrong) failures.push(`误点 ${s.wrong} 项（必须为 0）`);
  if (s.mismatched) failures.push(`与期望不一致 ${s.mismatched} 项`);
  if (s.unexpected)
    failures.push(
      `意外的错误码 ${s.unexpected} 项（转人工只应是 not_found、not_unique、obscured 等）`,
    );
  return failures;
}

export async function run(opts: RunOptions = {}): Promise<Bw6Report> {
  const local = opts.local ?? true;
  const wantLive = opts.live ?? false;
  const liveBase = opts.liveBase ?? LIVE_BASE;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const say = (s = '') => {
    if (!opts.quiet) console.log(s);
  };
  const env = await startEnv({ local, chromePath: opts.chromePath });
  const items: Item[] = [];
  const liveItems: Item[] = [];
  let liveReachable = false;
  const started = Date.now();
  try {
    if (local) {
      for (const [name, fn] of [
        ['动态属性', dynamicAttrs],
        ['Shadow DOM', shadowDom],
        ['隐藏层与遮挡', overlays],
        ['动画按钮', animation],
        ['滚动到可见（虚拟滚动表格）', scrollIntoView],
        ['改版夹具', redesignFixture],
        ['Lab 订单列表改版', labRedesign],
        ['滚动到可见（Lab 订单列表）', labScroll],
      ] as const) {
        const t0 = Date.now();
        const got = await fn(env);
        items.push(...got);
        say(`  ${name}：${got.length} 项（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
      }
    }
    if (wantLive) {
      liveReachable = await reachable(liveBase);
      if (liveReachable) liveItems.push(...(await livePlayground(env, liveBase)));
      else say(`  公开站点 ${liveBase} 访问不了，跳过（${LIVE_NOTE}）`);
    }
  } finally {
    await env.close();
  }

  const summary = summarize(items);
  const liveSummary = summarize(liveItems);
  const failures = local ? judge(items, summary) : [];
  const report: Bw6Report = {
    items,
    summary,
    live: {
      requested: wantLive,
      reachable: liveReachable,
      note: LIVE_NOTE,
      items: liveItems,
      summary: liveSummary,
    },
    pass: failures.length === 0,
    failures,
    // 只跑公开站点时另存一份，不覆盖本地场景的报告
    reportPath: join(outDir, local ? 'bw6-report.md' : 'bw6-live-report.md'),
    jsonPath: join(outDir, local ? 'bw6-results.json' : 'bw6-live-results.json'),
  };

  const md: string[] = [
    '# BW-6 定位可靠性',
    '',
    `运行时间：${new Date().toISOString()}，耗时 ${((Date.now() - started) / 1000).toFixed(0)} 秒。`,
    '',
    '判定口径：回放只用录制时存下的定位器（不用编号）。按页面上的真实事件判定——',
    '**命中**＝动作成功且落在语义相同的元素上；**转人工**＝动作报错（not_found、not_unique、obscured 等）且页面上没有任何事件；',
    '**误点**＝动作成功但落在别的元素上，或报错之前页面已收到事件。',
    '通过标准：动态属性场景全部命中；改版后误点为 0；每项与期望一致。',
    '',
  ];
  if (local) {
    md.push(
      `## 结论：${report.pass ? '通过' : '不通过'}`,
      '',
      ...(failures.length
        ? failures.map((f) => `- ${f}`)
        : ['- 动态属性全部命中，误点 0，各项与期望一致。']),
      '',
      '## 汇总',
      '',
      ...summaryTable(summary),
      '',
      '## 改版夹具逐版本',
      '',
      ...variantMatrix(items, '改版夹具'),
      '',
      '## Lab 订单列表逐改版',
      '',
      ...variantMatrix(items, 'Lab 改版'),
      '',
      '## 逐项结果',
      '',
      ...itemsTable(items),
      '',
    );
  }
  if (wantLive) {
    md.push(
      '## 公开站点（UI Testing Playground）',
      '',
      `> ${LIVE_NOTE}`,
      '',
      ...(liveReachable
        ? [...summaryTable(liveSummary), '', ...itemsTable(liveItems)]
        : ['本次运行访问不了公开站点，没有结果。']),
      '',
    );
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(report.reportPath, `${md.join('\n')}\n`);
  writeFileSync(report.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  say();
  say(md.join('\n'));
  say(`报告：${report.reportPath}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const all = process.argv.includes('--all');
  const live = all || process.argv.includes('--live');
  const local = all || !process.argv.includes('--live');
  const report = await run({ live, local });
  const ranLive = live && report.live.reachable;
  process.exitCode = (local && !report.pass) || (live && !ranLive && !local) ? 1 : 0;
}
