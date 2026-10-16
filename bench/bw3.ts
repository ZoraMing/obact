// BW-3 延迟与异步（PRD 9.4）：全部用后置检查驱动等待，流程里没有固定延时，全部通过。
//
// 用法：
//   node bench/bw3.ts                本地：fixtures 的 timing、fast-response、polling 夹具 + Lab 订单列表（注入 delay_ms）
//   node bench/bw3.ts --live         公开站点：quotes.toscrape.com/js-delayed，以及 uitestingplayground.com 的
//                                    loaddelay、ajax、clientdelay、progressbar
//   node bench/bw3.ts --only L2,L3   只跑指定编号的场景（调试用）
//   node bench/bw3.ts --out 目录     报告写到指定目录（默认 bench/out）
//   BENCH_TRACE=1                    把每个动作的耗时打印到标准错误
// 输出：逐项结果表（场景、步骤数、结果、耗时、失败原因）打印到终端，并写到 bench/out/bw3-<local|live>.md 与 .json。
// 编程调用：import { run } from './bw3.ts'；run() 返回报告，pass 为 true 表示全部场景通过。
//
// 等待方式：每一步的等待都落在 act 的后置检查（post）、wait_for 或定位器的轮询上，条件一满足就继续；
// 脚本里不出现睡眠与定时器等待，场景 S0 会扫描本文件自己确认这一点。
//
// --live 说明（未实测）：本文件的公开站点部分按站点公开的页面结构编写（选择器、文案、延迟时长取自站点页面），
// 写作时所在的容器访问不了公开站点，所以只做过类型检查，以及在 bench/test/bw3-7.test.ts 里对一套按同样结构
// 复刻的本地桩页（延迟缩短）跑通了脚本逻辑；没有对真实站点跑过。真实站点改版后以实际运行为准。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ActOptions, act, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult, ObserveResult } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { resultFor } from '../fixtures/api/fast-response.ts';
import { type FixtureServer, startFixtures } from '../fixtures/server.ts';
import { createLab, type Lab } from '../lab/src/app.ts';
import auth from '../lab/src/modules/auth.ts';
import orders from '../lab/src/modules/orders.ts';
import { testChrome } from '../tools/browser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** BENCH_TRACE=1：把每个动作的耗时打印到标准错误（定位慢步骤用）。 */
const TRACE = process.env.BENCH_TRACE === '1';
const SUITE = 'BW-3';

/** 公开站点的根地址；测试里指向本地桩页。 */
export type Sites = { quotes: string; playground: string };
export const LIVE_SITES: Sites = {
  quotes: 'https://quotes.toscrape.com',
  playground: 'http://www.uitestingplayground.com',
};

export type RunOptions = {
  /** 在公开站点上运行（默认本地）。 */
  live?: boolean;
  /** 公开站点的地址覆盖（测试用）。 */
  sites?: Partial<Sites>;
  /** 报告目录，默认 bench/out。 */
  outDir?: string;
  /** 打印结果表。 */
  print?: boolean;
  /** 只跑这些编号的场景。 */
  only?: string[];
};

export type Row = {
  id: string;
  scenario: string;
  /** act 动作数 + observe 次数。 */
  steps: number;
  ok: boolean;
  ms: number;
  error?: string;
  /** 补充说明（实测耗时、计数等），写在结果表之后。 */
  notes: string[];
};

export type Report = {
  suite: string;
  mode: 'local' | 'live';
  startedAt: string;
  rows: Row[];
  pass: boolean;
  markdown: string;
  files: { md: string; json: string };
};

// ---------------------------------------------------------------------------------------------
// 运行环境、步骤计数、结果表。这一段与 bw7.ts 相同：bench 下只能动各自的文件，所以各带一份。
// ---------------------------------------------------------------------------------------------

type Env = {
  session: Session;
  browser: Browser;
  /** 夹具服务（仅本地）。 */
  fx?: FixtureServer;
  /** Lab（仅本地）。 */
  lab?: Lab;
  close(): Promise<void>;
};

async function startEnv(local: boolean): Promise<Env> {
  const chromePath = (await testChrome()) ?? '';
  if (!chromePath) throw new Error('未找到浏览器：请设置 CHROME_PATH');
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-bench-'));
  let fx: FixtureServer | undefined;
  let lab: Lab | undefined;
  let browser: Browser | undefined;
  let session: Session | undefined;
  const close = async () => {
    await session?.close({ closeBrowser: true }).catch(() => {});
    if (!session) await browser?.close().catch(() => {});
    await lab?.close().catch(() => {});
    await fx?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  };
  try {
    if (local) {
      fx = await startFixtures();
      lab = await createLab({ modules: [auth, orders] });
    }
    browser = await launchBrowser({
      profileDir,
      chromePath,
      mode: process.env.HEADED === '1' ? 'headed' : 'headless',
    });
    session = await Session.attach(browser);
  } catch (e) {
    await close();
    throw e;
  }
  return { session, browser, fx, lab, close };
}

/** 一个场景的运行上下文：封装 act / observe 并计步，失败时抛出带步骤说明的错误。 */
class T {
  steps = 0;
  readonly notes: string[] = [];
  readonly env: Env;
  readonly #opened: string[] = [];

  constructor(env: Env) {
    this.env = env;
  }

  get fx(): string {
    if (!this.env.fx) throw new Error('当前不是本地模式，没有夹具服务');
    return this.env.fx.base;
  }

  get lab(): Lab {
    if (!this.env.lab) throw new Error('当前不是本地模式，没有 Lab');
    return this.env.lab;
  }

  /** 执行动作，不论成败都返回结果（用于验证“应当失败”的步骤）。 */
  async tryAct(action: Action, opts?: ActOptions): Promise<ActResult> {
    this.steps++;
    const r = await act(this.env.session, action, opts);
    if (TRACE)
      console.error(`  [步骤 ${this.steps}] ${action.op} ${r.status} ${r.duration_ms} 毫秒`);
    return r;
  }

  /** 执行动作；status 为 error 时抛错。 */
  async act(action: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await this.tryAct(action, opts);
    if (r.status !== 'ok') throw new Error(failure(this.steps, action, r));
    return r;
  }

  async observe(pageId: string): Promise<ObserveResult> {
    this.steps++;
    return observe(this.env.session, { pageId });
  }

  /** 用 new_page 动作打开标签页，场景结束时自动关闭。 */
  async open(url: string, timeoutMs = 10_000): Promise<string> {
    const r = await this.act({ op: 'new_page', url, timeout_ms: timeoutMs });
    const id = r.effects.new_pages[0];
    if (!id) throw new Error(`new_page 没有返回 pageId：${url}`);
    this.#opened.push(id);
    return id;
  }

  page(pageId: string) {
    return this.env.session.pages.get(pageId);
  }

  /** 在页面里求值，只用来读状态做核对（不计步骤）。 */
  eval<R>(pageId: string, fn: () => R): Promise<Awaited<R>> {
    return this.page(pageId).evaluate(fn);
  }

  check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(msg);
  }

  eq(actual: unknown, expected: unknown, what: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${what}：期望 ${e}，实际 ${a}`);
  }

  /** 耗时在 [lo, hi] 之内：下限说明确实等到了条件，上限说明条件一满足就返回、没有多等。 */
  between(ms: number, lo: number, hi: number, what: string): void {
    if (ms < lo || ms > hi) throw new Error(`${what}：耗时 ${ms} 毫秒，应在 ${lo}~${hi} 毫秒之间`);
  }

  note(s: string): void {
    this.notes.push(s);
  }

  async cleanup(): Promise<void> {
    for (const id of this.#opened) {
      if (this.env.session.pages.has(id)) {
        await this.env.session.pages
          .get(id)
          .close({ runBeforeUnload: false })
          .catch(() => {});
      }
    }
  }
}

function failure(step: number, a: Action, r: ActResult): string {
  const target = 'target' in a && a.target ? ` ${JSON.stringify(a.target)}` : '';
  const bad = (r.assertions ?? [])
    .filter((x) => !x.pass)
    .map((x) => x.detail)
    .filter(Boolean);
  return `步骤 ${step}（${a.op}${target}）：${r.error?.code} ${r.error?.message}${bad.length ? `（${bad.join('；')}）` : ''}`;
}

type Scenario = {
  id: string;
  name: string;
  /** 公开站点场景所属的站点（开跑前先探测可达）。 */
  site?: keyof Sites;
  run(t: T): Promise<void>;
};

async function runScenario(env: Env, s: Scenario): Promise<Row> {
  const t = new T(env);
  const t0 = Date.now();
  let error: string | undefined;
  try {
    await s.run(t);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await t.cleanup();
  }
  return {
    id: s.id,
    scenario: s.name,
    steps: t.steps,
    ok: !error,
    ms: Date.now() - t0,
    error,
    notes: t.notes,
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function renderMarkdown(
  mode: 'local' | 'live',
  startedAt: string,
  rows: Row[],
  extra: string[],
): string {
  const passed = rows.filter((r) => r.ok).length;
  const lines = [
    `# ${SUITE} 延迟与异步（${mode === 'live' ? '公开站点' : '本地'}）`,
    '',
    `时间：${startedAt}　结果：${passed}/${rows.length} 通过`,
    ...extra,
    '',
    '| 编号 | 场景 | 步骤数 | 结果 | 耗时 | 失败原因 |',
    '|---|---|--:|---|--:|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${cell(r.scenario)} | ${r.steps} | ${r.ok ? '通过' : '失败'} | ${secs(r.ms)} | ${cell(r.error ?? '')} |`,
    ),
    '',
    '步骤数 = act 动作数 + observe 次数。',
  ];
  const detail = rows.filter((r) => r.notes.length);
  if (detail.length) {
    lines.push('', '## 明细', '');
    for (const r of detail) for (const n of r.notes) lines.push(`- ${r.id}：${n}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 探测站点是否可达（任何 HTTP 响应都算可达）；不可达返回原因。 */
async function unreachable(url: string): Promise<string | null> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return null;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    return `${err.cause?.code ?? err.cause?.message ?? err.message}`;
  }
}

/** 本文件里不允许出现的固定延时写法（用拼接避免扫描时匹配到这里自己）。 */
const FIXED_DELAY = [
  ['sle', 'ep\\s*\\('],
  ['set', 'Timeout\\s*\\('],
  ['set', 'Interval\\s*\\('],
  ['waitFor', 'Timeout\\s*\\('],
  ['timers', '/promises'],
].map(([a, b]) => new RegExp((a as string) + (b as string)));

const noFixedDelay: Scenario = {
  id: 'S0',
  name: '脚本自检：本文件里没有固定延时',
  async run(t) {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const hits = src
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => FIXED_DELAY.some((re) => re.test(line)));
    t.check(hits.length === 0, `发现固定延时写法：${hits.map((h) => `第 ${h.n} 行`).join('、')}`);
    t.note(`扫描 ${src.length} 行，没有睡眠、定时器、waitFor 固定毫秒数的写法`);
  },
};

// ---------------------------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------------------------

const btn = (name: string) => ({ role: 'button', name });
/** 订单的“待审核”状态。 */
const PENDING = '待审核';
const logOf = (t: T, pageId: string) =>
  t.eval(pageId, () => (window as unknown as { __log: string[] }).__log);

/** Lab 的三个控制接口（重置、故障开关、状态）。 */
function labControl(lab: Lab, space: string) {
  const u = (p: string) => `${lab.url(space)}/_lab/${p}`;
  const post = async (p: string, body: unknown) =>
    (
      await fetch(u(p), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  return {
    reset: () => post('reset', {}),
    faults: (f: Record<string, unknown>) => post('faults', f),
    state: async () =>
      (await (await fetch(u('state'))).json()) as {
        modules: { orders: { counts: Record<string, number>; changed_ids: string[] } };
        submissions: { op: string; count: number }[];
      },
  };
}

/** fast-response 页面上显示的文字（金额带千分位）。 */
function shown(r: { n: number; order_id: string; amount: number }): string {
  const [int, frac] = r.amount.toFixed(2).split('.') as [string, string];
  return `第 ${r.n} 次查询：订单 ${r.order_id}，金额 ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac} 元`;
}

type PollState = { polls: number; inflight: number; pushes: number; wsOpen: boolean };

const localScenarios: Scenario[] = [
  {
    id: 'L1',
    name: '客户端延迟：点击后 800 毫秒才渲染出按钮（timing）',
    async run(t) {
      const p = await t.open(`${t.fx}/timing/`);
      const r = await t.act({
        op: 'click',
        pageId: p,
        target: btn('显示延迟按钮'),
        post: [{ element_present: btn('延迟按钮') }],
        timeout_ms: 5000,
      });
      t.between(r.duration_ms, 700, 3500, '后置检查等到按钮出现');
      t.note(`后置检查等到延迟按钮：${r.duration_ms} 毫秒（页面延迟 800 毫秒）`);
      await t.act({
        op: 'click',
        pageId: p,
        target: btn('延迟按钮'),
        post: [{ expr: "window.__log.includes('delayed')" }],
      });
      t.eq(await logOf(t, p), ['delayed'], '点击记录');
    },
  },
  {
    id: 'L2',
    name: 'AJAX 数据：骨架屏 + 慢接口 1.5 秒（timing）',
    async run(t) {
      // 后置检查在期限内等不到时如实报 assertion_failed，并且期限一到就返回，没有多等
      const a = await t.open(`${t.fx}/timing/?delay=1500`);
      const early = await t.tryAct({
        op: 'click',
        pageId: a,
        target: btn('加载订单'),
        post: [{ text_present: 'SO-31002' }],
        timeout_ms: 400,
      });
      t.check(
        early.status === 'error' && early.error?.code === 'assertion_failed',
        `期限内没等到结果应报 assertion_failed：${early.status} ${early.error?.code}`,
      );
      t.between(early.duration_ms, 350, 1500, '期限一到就返回');
      // 同一次请求的结果稍后到达：wait_for 条件等待
      await t.act({
        op: 'wait_for',
        pageId: a,
        until: [{ element_absent: { css: '[aria-busy="true"]' } }, { text_present: 'SO-31002' }],
        timeout_ms: 5000,
      });
      await t.act({
        op: 'click',
        pageId: a,
        target: { role: 'button', name: '查看', within: "tr[data-key='SO-31002']" },
      });
      t.eq(await logOf(t, a), ['view:SO-31002'], '同名“查看”按钮靠所在行消歧');

      // 全程用后置检查：骨架消失且真实内容出现
      const b = await t.open(`${t.fx}/timing/?delay=1500`);
      const r = await t.act({
        op: 'click',
        pageId: b,
        target: btn('加载订单'),
        post: [{ element_absent: { css: '[aria-busy="true"]' } }, { text_present: 'SO-31002' }],
        timeout_ms: 8000,
      });
      t.between(r.duration_ms, 1300, 4500, '后置检查等到接口返回');
      t.note(`加载订单到内容出现：${r.duration_ms} 毫秒（接口延迟 1500 毫秒）`);
      // 骨架里禁用的“全部导出”不能被点；等真实按钮替换上来再点
      await t.act({ op: 'click', pageId: b, target: btn('加载订单') });
      await t.act({ op: 'click', pageId: b, target: btn('全部导出'), timeout_ms: 8000 });
      t.eq((await logOf(t, b)).at(-1), 'export-all', '点到的是真实按钮，不是骨架里的');
    },
  },
  {
    id: 'L3',
    name: '进度条：等到“导出完成”；走到 50% 时停止（timing）',
    async run(t) {
      const a = await t.open(`${t.fx}/timing/`);
      const r = await t.act({
        op: 'click',
        pageId: a,
        target: btn('开始导出'),
        post: [{ text_present: '导出完成' }],
        timeout_ms: 10_000,
      });
      t.between(r.duration_ms, 1500, 6000, '后置检查等到进度条走完');
      t.note(`开始导出到“导出完成”：${r.duration_ms} 毫秒（进度条约 2 秒走完）`);
      await t.act({ op: 'click', pageId: a, target: btn('下载报表') });
      t.eq(await logOf(t, a), ['download'], '点击记录');

      const b = await t.open(`${t.fx}/timing/`);
      await t.act({ op: 'click', pageId: b, target: btn('开始导出') });
      await t.act({
        op: 'wait_for',
        pageId: b,
        until: [{ expr: "document.getElementById('progress').value >= 50" }],
        timeout_ms: 8000,
      });
      await t.act({ op: 'click', pageId: b, target: btn('停止') });
      const stopped = Number(/^stopped:(\d+)$/.exec((await logOf(t, b))[0] ?? '')?.[1]);
      t.check(stopped >= 50 && stopped < 95, `停在 ${stopped}%，应在 50% 到 95% 之间`);
      t.note(`条件等待到 50% 后点“停止”，停在 ${stopped}%`);
    },
  },
  {
    id: 'L4',
    name: '快速响应：约 20 毫秒的接口，后置检查不错过响应（fast-response）',
    async run(t) {
      const p = await t.open(`${t.fx}/fast-response/?seed=4`);
      const bodies: Promise<unknown>[] = [];
      t.page(p).on('response', (res) => {
        if (res.url().includes('/api/fast-response/data')) bodies.push(res.json());
      });
      const ms: number[] = [];
      for (const n of [1, 2, 3]) {
        const want = resultFor(4, n);
        const r = await t.act({
          op: 'click',
          pageId: p,
          target: btn('查询订单'),
          post: [{ text_present: shown(want) }],
        });
        t.between(r.duration_ms, 0, 3000, `第 ${n} 次查询`);
        ms.push(r.duration_ms);
      }
      t.eq(
        await Promise.all(bodies),
        [1, 2, 3].map((n) => ({ ...resultFor(4, n), delay_ms: 20 })),
        '每次点击的接口响应都在，且与页面显示一致',
      );
      t.note(`三次查询耗时 ${ms.join('、')} 毫秒`);

      // 接口 300 毫秒：耗时跟随接口，结果一出现就返回
      const q = await t.open(`${t.fx}/fast-response/?seed=4&delay=300`);
      const r = await t.act({
        op: 'click',
        pageId: q,
        target: btn('查询订单'),
        post: [{ text_present: shown(resultFor(4, 1)) }],
      });
      t.between(r.duration_ms, 300, 3000, '接口 300 毫秒时');
      t.note(`接口 300 毫秒时的查询耗时 ${r.duration_ms} 毫秒`);
    },
  },
  {
    id: 'L5',
    name: '常驻请求：每秒轮询 + WebSocket 推送下，动作不等网络空闲（polling）',
    async run(t) {
      // hold=2500：每次轮询 2.5 秒才返回，任何时刻都有请求挂着；WebSocket 每 200 毫秒推送一条
      const p = await t.open(`${t.fx}/polling/?hold=2500`);
      await t.act({
        op: 'wait_for',
        pageId: p,
        until: [
          {
            expr: 'window.fixtureState.wsOpen && window.fixtureState.pushes >= 3 && window.fixtureState.inflight >= 2',
          },
        ],
        timeout_ms: 8000,
      });
      const state = () =>
        t.eval(p, () => ({ ...(window as unknown as { fixtureState: PollState }).fixtureState }));
      const before = await state();
      const t0 = Date.now();
      const steps: [string, Action][] = [
        [
          '点击',
          {
            op: 'click',
            pageId: p,
            target: btn('保存草稿'),
            post: [{ text_present: '已保存 1 次' }],
          },
        ],
        [
          '填写标题',
          { op: 'fill', pageId: p, target: { role: 'textbox', name: '标题' }, value: '巡检' },
        ],
        ['填写备注', { op: 'fill', pageId: p, target: { css: '#note' }, value: '机房 A' }],
        [
          '选择优先级',
          { op: 'fill', pageId: p, target: { role: 'combobox', name: '优先级' }, value: '高' },
        ],
        [
          '提交',
          {
            op: 'click',
            pageId: p,
            target: btn('提交'),
            post: [{ text_present: '已提交：标题=巡检，备注=机房 A，优先级=高' }],
          },
        ],
      ];
      const ms: string[] = [];
      for (const [name, action] of steps) {
        const r = await t.act(action);
        t.between(r.duration_ms, 0, 3000, name);
        ms.push(`${name} ${r.duration_ms}`);
      }
      const total = Date.now() - t0;
      t.check(
        total < 10_000,
        `五个动作合计 ${total} 毫秒：每个动作都在等 5 秒的稳定等待上限，说明动作在等网络空闲`,
      );
      const after = await state();
      t.check(after.inflight >= 1, '动作结束时仍有轮询请求挂着：没有等网络空闲');
      t.check(after.pushes > before.pushes, '动作期间 WebSocket 推送仍在继续');
      t.note(
        `各动作耗时（毫秒）：${ms.join('，')}；合计 ${total}；推送 ${before.pushes} → ${after.pushes}`,
      );

      // WebSocket 往返：后置检查等到服务器回显
      await t.act({
        op: 'fill',
        pageId: p,
        target: { css: '#title' },
        value: '你好，服务器',
      });
      const r = await t.act({
        op: 'click',
        pageId: p,
        target: btn('发送到服务器'),
        post: [{ text_present: '服务器回显：你好，服务器' }],
      });
      t.between(r.duration_ms, 0, 3000, 'WebSocket 往返');
      t.note(`WebSocket 往返 ${r.duration_ms} 毫秒`);
    },
  },
  {
    id: 'L6',
    name: '加载延迟：Lab 订单后台，接口注入 1.2 秒延迟（登录、加载、筛选、批量审核）',
    async run(t) {
      const space = 'bw3-orders';
      const ctl = labControl(t.lab, space);
      await ctl.reset();
      await ctl.faults({ delay_ms: 1200 });
      const base = t.lab.url(space);
      const p = await t.open(`${base}/login?next=%2Forders`);
      await t.act({
        op: 'fill',
        pageId: p,
        target: { role: 'textbox', name: '账号' },
        value: 'alice',
      });
      await t.act({
        op: 'fill',
        pageId: p,
        target: { role: 'textbox', name: '密码' },
        value: 'alice123',
      });
      // 登录后列表要等接口 1.2 秒才渲染：后置检查等到“共 200 条”
      const login = await t.act({
        op: 'click',
        pageId: p,
        target: btn('登录'),
        post: [{ url_matches: '/orders$' }, { text_present: '共 200 条' }],
        timeout_ms: 10_000,
      });
      t.between(login.duration_ms, 1000, 6000, '登录后等到订单列表');
      t.note(`登录到列表渲染：${login.duration_ms} 毫秒（接口延迟 1200 毫秒）`);

      // 筛选在前端完成，点“查询”后后置检查等到条数
      const pending = (await ctl.state()).modules.orders.counts[PENDING] ?? 0;
      t.check(pending >= 2, `待审核订单应不少于 2 条：${pending}`);
      await t.act({
        op: 'fill',
        pageId: p,
        target: { role: 'combobox', name: '状态' },
        value: '待审核',
      });
      await t.act({
        op: 'click',
        pageId: p,
        target: btn('查询'),
        post: [{ text_present: `共 ${pending} 条` }],
      });

      // 勾选前两条待审核订单 → 批量审核 → confirm 对话框 → 提交（接口同样延迟 1.2 秒）
      const ob = await t.observe(p);
      const picks = ob.elements
        .filter((e) => e.role === 'checkbox' && /^选择订单 \d+$/.test(e.name))
        .slice(0, 2)
        .map((e) => e.name);
      t.eq(picks.length, 2, '列表里至少有两条可勾选的订单');
      for (const name of picks) {
        await t.act({ op: 'click', pageId: p, target: { role: 'checkbox', name } });
      }
      const click = await t.act({ op: 'click', pageId: p, target: btn('批量审核') });
      t.eq(
        click.effects.dialogs,
        [{ type: 'confirm', message: '确认批量审核选中的 2 条订单？', handled: 'pending' }],
        '弹出确认对话框',
      );
      const done = await t.act({
        op: 'handle_dialog',
        pageId: p,
        action: 'accept',
        post: [{ text_present: '已审核 2 条' }],
        timeout_ms: 8000,
      });
      t.between(done.duration_ms, 1000, 5000, '确认后等到审核结果');
      t.note(`确认到“已审核 2 条”：${done.duration_ms} 毫秒（接口延迟 1200 毫秒）`);

      // 对账：服务端只改了这两条，提交只有一次
      const want = picks.map((n) => n.replace('选择订单 ', '')).sort();
      const st = await ctl.state();
      t.eq([...st.modules.orders.changed_ids].sort(), want, '服务端改动的订单');
      t.eq(
        st.submissions.filter((s) => s.op === 'approve').map((s) => s.count),
        [1],
        '审核提交次数',
      );

      // 刷新：列表再次经过 1.2 秒延迟，后置检查等到
      const reload = await t.act({
        op: 'navigate_page',
        pageId: p,
        type: 'reload',
        post: [{ text_present: '共 200 条' }],
        timeout_ms: 8000,
      });
      t.between(reload.duration_ms, 1000, 5000, '刷新后等到列表');
    },
  },
];

const liveScenarios = (sites: Sites): Scenario[] => {
  const q = sites.quotes;
  const pg = sites.playground;
  const quoteCount = (t: T, p: string) =>
    t.eval(p, () => document.querySelectorAll('div.quote').length);
  const firstQuote = (t: T, p: string) =>
    t.eval(p, () => document.querySelector('div.quote span.text')?.textContent ?? '');
  const firstAuthor = (t: T, p: string) =>
    t.eval(p, () => document.querySelector('div.quote small.author')?.textContent ?? '');
  return [
    {
      id: 'V1',
      site: 'quotes',
      name: 'Quotes /js-delayed：名言由脚本延迟渲染，翻到下一页',
      async run(t) {
        const p = await t.open(`${q}/js-delayed/`, 30_000);
        // 页面打开约 10 秒后才渲染名言：wait_for 等到第一条出现
        const r = await t.act({
          op: 'wait_for',
          pageId: p,
          until: [{ element_present: { css: 'div.quote' } }],
          timeout_ms: 30_000,
        });
        t.note(`等到名言出现：${r.duration_ms} 毫秒`);
        t.eq(await quoteCount(t, p), 10, '第 1 页名言条数');
        t.eq(await firstAuthor(t, p), 'Albert Einstein', '第 1 页第一条的作者');
        const first = await firstQuote(t, p);
        // 翻页后的新页面同样延迟渲染：后置检查等到地址变化且名言出现
        await t.act({
          op: 'click',
          pageId: p,
          target: { css: 'li.next a' },
          post: [{ url_matches: '/js-delayed/page/2/' }, { element_present: { css: 'div.quote' } }],
          timeout_ms: 30_000,
        });
        t.eq(await quoteCount(t, p), 10, '第 2 页名言条数');
        t.check((await firstQuote(t, p)) !== first, '第 2 页的第一条应与第 1 页不同');
      },
    },
    {
      id: 'V2',
      site: 'playground',
      name: 'UI Testing Playground：加载延迟（/loaddelay）',
      async run(t) {
        // 页面本身要加载好几秒，之后才出现按钮：打开页面的超时放宽，点击靠定位器轮询等到按钮
        const p = await t.open(`${pg}/loaddelay`, 30_000);
        const r = await t.act({
          op: 'click',
          pageId: p,
          target: btn('Button Appearing After Delay'),
          timeout_ms: 15_000,
        });
        t.note(`等到按钮并点击：${r.duration_ms} 毫秒`);
      },
    },
    {
      id: 'V3',
      site: 'playground',
      name: 'UI Testing Playground：AJAX 数据（/ajax）',
      async run(t) {
        const p = await t.open(`${pg}/ajax`);
        const r = await t.act({
          op: 'click',
          pageId: p,
          target: btn('Button Triggering AJAX Request'),
          post: [{ text_present: 'Data loaded with AJAX get request.' }],
          timeout_ms: 25_000,
        });
        t.note(`点击到数据出现：${r.duration_ms} 毫秒`);
      },
    },
    {
      id: 'V4',
      site: 'playground',
      name: 'UI Testing Playground：客户端延迟（/clientdelay）',
      async run(t) {
        const p = await t.open(`${pg}/clientdelay`);
        const r = await t.act({
          op: 'click',
          pageId: p,
          target: btn('Button Triggering Client Side Logic'),
          post: [{ text_present: 'Data calculated on the client side.' }],
          timeout_ms: 25_000,
        });
        t.note(`点击到数据出现：${r.duration_ms} 毫秒`);
      },
    },
    {
      id: 'V5',
      site: 'playground',
      name: 'UI Testing Playground：进度条走到 75% 时停止（/progressbar）',
      async run(t) {
        const p = await t.open(`${pg}/progressbar`);
        await t.act({ op: 'click', pageId: p, target: btn('Start') });
        const r = await t.act({
          op: 'wait_for',
          pageId: p,
          until: [
            {
              expr: "Number(document.getElementById('progressBar').getAttribute('aria-valuenow')) >= 75",
            },
          ],
          timeout_ms: 60_000,
        });
        await t.act({ op: 'click', pageId: p, target: btn('Stop') });
        const value = await t.eval(p, () =>
          Number(document.getElementById('progressBar')?.getAttribute('aria-valuenow')),
        );
        t.check(value >= 75, `停止时进度 ${value}%，应不低于 75%`);
        t.note(`等到 75%：${r.duration_ms} 毫秒；停止时 ${value}%`);
      },
    },
  ];
};

// ---------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------

export async function run(opts: RunOptions = {}): Promise<Report> {
  const mode = opts.live ? 'live' : 'local';
  const sites: Sites = { ...LIVE_SITES, ...opts.sites };
  const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const want = (s: Scenario) => !opts.only || opts.only.includes(s.id);
  const list = [noFixedDelay, ...(opts.live ? liveScenarios(sites) : localScenarios)].filter(want);

  const env = await startEnv(!opts.live);
  const rows: Row[] = [];
  try {
    const down = new Map<string, string | null>();
    for (const s of list) {
      if (s.site && !down.has(s.site)) down.set(s.site, await unreachable(sites[s.site]));
      const why = s.site ? down.get(s.site) : null;
      if (why) {
        rows.push({
          id: s.id,
          scenario: s.name,
          steps: 0,
          ok: false,
          ms: 0,
          error: `站点不可达：${sites[s.site as keyof Sites]}（${why}）`,
          notes: [],
        });
        continue;
      }
      rows.push(await runScenario(env, s));
    }
  } finally {
    await env.close();
  }

  const extra = opts.live
    ? [
        `站点：${Object.entries(sites)
          .map(([k, v]) => `${k}=${v}`)
          .join('，')}`,
      ]
    : [];
  const markdown = renderMarkdown(mode, startedAt, rows, extra);
  const outDir = opts.outDir ?? join(HERE, 'out');
  mkdirSync(outDir, { recursive: true });
  const files = { md: join(outDir, `bw3-${mode}.md`), json: join(outDir, `bw3-${mode}.json`) };
  const pass = rows.length > 0 && rows.every((r) => r.ok);
  const report: Report = { suite: SUITE, mode, startedAt, rows, pass, markdown, files };
  writeFileSync(files.md, markdown);
  writeFileSync(files.json, `${JSON.stringify({ ...report, markdown: undefined }, null, 2)}\n`);
  if (opts.print) console.log(markdown);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const only = arg('--only')?.split(',').filter(Boolean);
  const report = await run({
    live: process.argv.includes('--live'),
    print: true,
    only,
    outDir: arg('--out'),
  });
  console.log(`报告：${report.files.md}`);
  process.exit(report.pass ? 0 : 1);
}
