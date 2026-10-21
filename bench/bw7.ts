// BW-7 弹窗与页面结构（PRD 9.4，不含“存为规则”）：处理弹窗、对话框、frame 和新窗口，全部通过。
//
// 用法：
//   node bench/bw7.ts                本地：Lab 干扰层 /noise/entry-ad、overlays、forms-files、structure 夹具，
//                                    Lab 复杂结构与订单后台导出
//   node bench/bw7.ts --live         公开站点 https://the-internet.herokuapp.com/ 的 entry_ad、javascript_alerts、
//                                    frames/nested_frames、shadowdom、upload、download、windows
//   node bench/bw7.ts --only L1,L4   只跑指定编号的场景（调试用）
//   node bench/bw7.ts --out 目录     报告写到指定目录（默认 bench/out）
//   BENCH_TRACE=1                    把每个动作的耗时打印到标准错误
// 输出：逐项结果表（场景、步骤数、结果、耗时、失败原因）打印到终端，并写到 bench/out/bw7-<local|live>.md 与 .json。
// 编程调用：import { run } from './bw7.ts'；run() 返回报告，pass 为 true 表示全部场景通过。
//
// 弹窗处理：广告层、Cookie 提示条、引导遮罩都用 act 的 onObscured 回调处理。这里的回调是脚本里写死的“规则表”，
// 每条规则按命中元素决定处理动作；规则文件、人工接管与“存为规则”属于 M3，不在本脚本范围内。
// 等待方式：全部落在后置检查、wait_for、定位器轮询与事件上（下载靠浏览器的下载事件，上报靠网络响应），
// 脚本里不出现睡眠与定时器等待，场景 S0 会扫描本文件自己确认这一点。
//
// --live 说明（未实测）：本文件的公开站点部分按站点公开的页面结构编写（选择器、文案取自站点页面），
// 写作时所在的容器访问不了公开站点，所以基本只做过类型检查：bench/test/bw3-7.test.ts 只对一页复刻的 iframe
// 桩页回归了场景 V4，其余 --live 场景没有任何测试执行过，也没有对真实站点跑过。真实站点改版后以实际运行为准；
// 首次真实运行在 .github/workflows/live.yml。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ActOptions, act, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult, Assertion, ObserveResult } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { reportCsv } from '../fixtures/api/forms-files.ts';
import { type FixtureServer, startFixtures } from '../fixtures/server.ts';
import { createLab, type Lab } from '../lab/src/app.ts';
import auth from '../lab/src/modules/auth.ts';
import noise from '../lab/src/modules/noise.ts';
import orders from '../lab/src/modules/orders.ts';
import structure from '../lab/src/modules/structure.ts';
import { testChrome } from '../tools/browser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** BENCH_TRACE=1：把每个动作的耗时打印到标准错误（定位慢步骤用）。 */
const TRACE = process.env.BENCH_TRACE === '1';
const SUITE = 'BW-7';

/** 公开站点的根地址；可用 RunOptions.sites 覆盖（bench/test 的 V4 用它指向本地 iframe 桩页）。 */
export type Sites = { internet: string };
export const LIVE_SITES: Sites = { internet: 'https://the-internet.herokuapp.com' };

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
// 运行环境、步骤计数、结果表。这一段与 bw3.ts 基本相同：bench 下只能动各自的文件，所以各带一份。
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
      lab = await createLab({ modules: [auth, noise, orders, structure] });
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

/** 一次下载的结果。 */
type Download = { file: string; suggested: string; url: string };

/** 一个场景的运行上下文：封装 act / observe 并计步，失败时抛出带步骤说明的错误。 */
class T {
  steps = 0;
  readonly notes: string[] = [];
  readonly env: Env;
  readonly #opened: string[] = [];
  readonly #cleanups: (() => Promise<void> | void)[] = [];

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

  /** 登记动作打开的新标签页（点击链接、window.open），场景结束时自动关闭。 */
  adopt(pageId: string | undefined): string {
    if (!pageId) throw new Error('动作没有打开新标签页');
    this.#opened.push(pageId);
    return pageId;
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

  /** 取值：为空就抛错，否则原样返回（同时让类型收窄）。 */
  must<V>(v: V | null | undefined | false, msg: string): V {
    if (!v) throw new Error(msg);
    return v;
  }

  eq(actual: unknown, expected: unknown, what: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${what}：期望 ${e}，实际 ${a}`);
  }

  note(s: string): void {
    this.notes.push(s);
  }

  /** 场景专用的临时目录（上传文件、下载落盘），结束时删除。 */
  tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'obact-bw7-'));
    this.#cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /**
   * 接管浏览器的下载：文件落到 dir（按 guid 命名），用下载事件判断开始与完成。
   * 先调用 next() 拿到“下一次下载”的 promise，再做触发下载的动作，最后 await；上限由 AbortSignal 兜底。
   */
  async downloads(dir: string): Promise<{ next(ms?: number): Promise<Download> }> {
    const cdp = await this.env.browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: dir,
      eventsEnabled: true,
    });
    this.#cleanups.push(async () => {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await cdp.detach().catch(() => {});
    });
    return {
      next(ms = 15_000) {
        const signal = AbortSignal.timeout(ms);
        return new Promise<Download>((resolve, reject) => {
          let begun: { guid: string; suggestedFilename: string; url: string } | null = null;
          const finish = (fn: () => void) => {
            cdp.off('Browser.downloadWillBegin', onBegin);
            cdp.off('Browser.downloadProgress', onProgress);
            signal.removeEventListener('abort', onAbort);
            fn();
          };
          const onBegin = (e: { guid: string; suggestedFilename: string; url: string }) => {
            begun ??= e;
          };
          const onProgress = (e: { guid: string; state: string }) => {
            const b = begun;
            if (!b || e.guid !== b.guid) return;
            if (e.state === 'completed') {
              finish(() =>
                resolve({ file: join(dir, e.guid), suggested: b.suggestedFilename, url: b.url }),
              );
            } else if (e.state === 'canceled') finish(() => reject(new Error('下载被取消')));
          };
          const onAbort = () => finish(() => reject(new Error(`等待下载超时（${ms} 毫秒）`)));
          cdp.on('Browser.downloadWillBegin', onBegin);
          cdp.on('Browser.downloadProgress', onProgress);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
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
    for (const fn of this.#cleanups) await Promise.resolve(fn()).catch(() => {});
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
    `# ${SUITE} 弹窗与页面结构（${mode === 'live' ? '公开站点' : '本地'}）`,
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
    '步骤数 = act 动作数（含弹窗规则里执行的动作） + observe 次数。',
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
// 公共：弹窗规则、Lab 控制接口、页面上报的等待
// ---------------------------------------------------------------------------------------------

const btn = (name: string) => ({ role: 'button', name });
/** 检查项列表（契约要求至少一项）。 */
function checks(items: Assertion[]): [Assertion, ...Assertion[]] {
  if (items.length === 0) throw new Error('检查项不能为空');
  return items as [Assertion, ...Assertion[]];
}
const link = (name: string) => ({ role: 'link', name });
const logOf = (t: T, pageId: string) =>
  t.eval(pageId, () => (window as unknown as { __log: string[] }).__log);
const textOf = (t: T, pageId: string, selector: string) =>
  t.page(pageId).$eval(selector, (e) => e.textContent ?? '');

/** 一条弹窗规则：点击被遮挡时，按命中元素的描述匹配，匹配上就执行处理动作。 */
type PopupRule = { name: string; hit: RegExp; handle(pageId: string): Action };

/** 把规则表变成 act 的 onObscured 回调；calls 记录依次触发的规则名。处理成功返回 true，act 随后重试。 */
function popupRules(
  t: T,
  pageId: string,
  rules: PopupRule[],
  calls: string[],
): NonNullable<ActOptions['onObscured']> {
  return async (info) => {
    const rule = rules.find((r) => r.hit.test(info.hit));
    if (!rule) return false;
    calls.push(rule.name);
    return (await t.tryAct(rule.handle(pageId))).status === 'ok';
  };
}

const RULE_LAB_AD: PopupRule = {
  name: 'ad',
  hit: /noise-ad/,
  handle: (pageId) => ({ op: 'click', pageId, target: btn('关闭') }),
};
const RULE_COOKIE: PopupRule = {
  name: 'cookie',
  hit: /cookie-banner/,
  handle: (pageId) => ({ op: 'click', pageId, target: btn('接受全部') }),
};
const RULE_OVERLAY_AD: PopupRule = {
  name: 'ad',
  hit: /ad-backdrop|ad-dialog/,
  handle: (pageId) => ({ op: 'click', pageId, target: btn('关闭广告') }),
};
const RULE_TOUR: PopupRule = {
  name: 'tour',
  hit: /tour-mask/,
  handle: (pageId) => ({ op: 'press_key', pageId, key: 'Escape' }),
};

/** Lab 的三个控制接口（重置、故障开关、状态）。 */
function labControl(lab: Lab, space: string) {
  const u = (p: string) => `${lab.url(space)}/_lab/${p}`;
  return {
    reset: async () =>
      (
        await fetch(u('reset'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).json(),
    state: async () =>
      (await (await fetch(u('state'))).json()) as { modules: Record<string, unknown> },
  };
}

type NoiseState = { ad_shown: number; ad_closed: number; entry_ad_loads: number };
type StructureState = {
  counts: Record<string, number>;
  frames: Record<string, { count: number; email: string }>;
  events: { type: string; detail: Record<string, string> }[];
};

/** 等页面上报某类事件的请求拿到响应（先调用，再做动作，最后 await）。 */
function reported(t: T, pageId: string, type: string) {
  return t
    .page(pageId)
    .waitForResponse(
      (r) =>
        r.url().endsWith('/api/structure/event') &&
        (r.request().postData() ?? '').includes(`"type":"${type}"`),
      { timeout: 10_000 },
    );
}

/** 在某个 frame 里填邮箱并点“提交”，后置检查等顶层页面显示提交状态。 */
async function submitIn(t: T, pageId: string, frame: string[], email: string, status: string) {
  await t.act({
    op: 'fill',
    pageId,
    target: { role: 'textbox', name: '邮箱', frame },
    value: email,
  });
  await t.act({
    op: 'click',
    pageId,
    target: { role: 'button', name: '提交', frame },
    post: [{ text_present: status }],
  });
}

// ---------------------------------------------------------------------------------------------
// 本地场景
// ---------------------------------------------------------------------------------------------

/** 夹具 structure 与 Lab 复杂结构共用的 frame 选择器链（顶层到目标 frame）。 */
const FRAMES = {
  same: ['#same-frame'],
  cross: ['#cross-frame'],
  nested: ['#nested-frame', '#inner-frame'],
  outer: ['#nested-frame'],
  shadow: ['iframe[title="组件内框架"]'],
};

/** 等四个 frame 都加载出“提交”按钮。 */
const framesLoaded = (pageId: string): Action => ({
  op: 'wait_for',
  pageId,
  until: checks(
    [FRAMES.same, FRAMES.cross, FRAMES.nested, FRAMES.shadow].map((frame) => ({
      element_present: { css: '#submit', frame },
    })),
  ),
  timeout_ms: 10_000,
});

const localScenarios: Scenario[] = [
  {
    id: 'L1',
    name: 'Entry Ad：Lab /noise/entry-ad，onObscured 规则关广告；再加载一次仍自动处理',
    async run(t) {
      const space = 'bw7-entry';
      const ctl = labControl(t.lab, space);
      await ctl.reset();
      const url = `${t.lab.url(space)}/noise/entry-ad`;
      for (const round of [1, 2]) {
        const p = await t.open(url);
        // 广告层约 500 毫秒后出现：等“关闭”按钮可见
        await t.act({
          op: 'wait_for',
          pageId: p,
          until: [{ element_present: btn('关闭') }],
          timeout_ms: 5000,
        });
        if (round === 1) {
          // 不处理广告时：点页面按钮报 obscured，既没点到广告，也没点穿到下面的按钮
          const blocked = await t.tryAct({
            op: 'click',
            pageId: p,
            target: btn('继续阅读'),
            timeout_ms: 1500,
          });
          t.eq(blocked.error?.code, 'obscured', '广告没关时点“继续阅读”');
          t.eq(await textOf(t, p, '#entry-result'), '', '没有点穿到下面的按钮');
        }
        const calls: string[] = [];
        await t.act(
          {
            op: 'click',
            pageId: p,
            target: btn('继续阅读'),
            post: [{ text_present: '已继续阅读' }],
          },
          { onObscured: popupRules(t, p, [RULE_LAB_AD], calls) },
        );
        t.eq(calls, ['ad'], `第 ${round} 次加载触发的规则`);
        await t.act({
          op: 'assert',
          pageId: p,
          checks: [{ element_absent: { css: '#noise-ad' } }],
        });
        await t.act({ op: 'close_page', pageId: p });
      }
      const s = (await ctl.state()).modules.noise as NoiseState;
      t.eq(
        [s.entry_ad_loads, s.ad_shown, s.ad_closed],
        [2, 2, 2],
        '服务端记账：加载、弹出、关闭各 2 次',
      );
    },
  },
  {
    id: 'L2',
    name: 'Entry Ad：overlays 夹具的定时广告，弹出后挡住按钮，规则关闭后重试成功',
    async run(t) {
      const p = await t.open(`${t.fx}/overlays/?ad=timer&seed=4`);
      await t.act({
        op: 'wait_for',
        pageId: p,
        until: [{ element_present: { role: 'dialog', name: '限时优惠' } }],
        timeout_ms: 5000,
      });
      const calls: string[] = [];
      await t.act(
        {
          op: 'click',
          pageId: p,
          target: btn('绿色按钮'),
          post: [{ text_present: '绿色按钮已点击' }],
        },
        { onObscured: popupRules(t, p, [RULE_OVERLAY_AD], calls) },
      );
      t.eq(calls, ['ad'], '触发的规则');
      t.eq(await logOf(t, p), ['ad-close', 'green'], '点击记录：先关广告，再点绿色按钮');
    },
  },
  {
    id: 'L3',
    name: '广告在流程中途弹出（overlays，ad=click）：Cookie 条、引导遮罩、广告逐个由规则处理',
    async run(t) {
      // 广告在第几次点击后弹出由 seed 决定：seed=1 在 2 次点击后，seed=5 在 4 次点击后
      const cases: [string, string[]][] = [
        ['1', ['cookie', 'ad', 'tour']],
        ['5', ['cookie', 'tour', 'ad']],
      ];
      for (const [seed, order] of cases) {
        const p = await t.open(`${t.fx}/overlays/?ad=click&seed=${seed}`);
        const calls: string[] = [];
        const opts = {
          onObscured: popupRules(t, p, [RULE_COOKIE, RULE_OVERLAY_AD, RULE_TOUR], calls),
        };
        const steps: Action[] = [
          { op: 'fill', pageId: p, target: { role: 'textbox', name: '姓名' }, value: '李四' },
          {
            op: 'click',
            pageId: p,
            target: btn('保存草稿'),
            post: [{ text_present: '草稿已保存' }],
          },
          {
            op: 'click',
            pageId: p,
            target: btn('下一步'),
            post: [{ text_present: '已进入第 2 步' }],
          },
          {
            op: 'fill',
            pageId: p,
            target: { role: 'textbox', name: '电话' },
            value: '13900000000',
          },
          {
            op: 'click',
            pageId: p,
            target: btn('提交申请'),
            post: [{ text_present: '申请已提交：李四 13900000000' }],
          },
          {
            op: 'click',
            pageId: p,
            target: btn('绿色按钮'),
            post: [{ text_present: '绿色按钮已点击' }],
          },
        ];
        for (const step of steps) await t.act(step, opts);
        t.eq(calls, order, `seed=${seed} 规则触发顺序`);
        const log = await logOf(t, p);
        const overlays = [
          'layer',
          'tour-mask',
          'cookie-banner',
          'ad-backdrop',
          'ad-dialog',
          'ad-cta',
        ];
        t.eq(
          log.filter((x) => overlays.includes(x)),
          [],
          `seed=${seed} 没有点到任何遮挡物`,
        );
        t.eq(
          log.filter((x) => ['draft', 'next', 'submit', 'green'].includes(x)),
          ['draft', 'next', 'submit', 'green'],
          `seed=${seed} 每个业务按钮各点一次`,
        );
        await t.act({ op: 'close_page', pageId: p });
      }
    },
  },
  {
    id: 'L4',
    name: 'JavaScript Alerts：alert、confirm（确定/取消）、prompt（输入/取消），forms-files 夹具',
    async run(t) {
      const p = await t.open(`${t.fx}/forms-files/`);
      const dialog = (r: ActResult) => {
        const d = r.effects.dialogs[0];
        return [d?.type, d?.message, d?.handled];
      };
      const a = await t.act({ op: 'click', pageId: p, target: btn('显示提示') });
      t.eq(dialog(a), ['alert', '操作已完成', 'pending'], 'alert 对话框');
      // 对话框没处理时页面被挂起：其他动作报 dialog_blocking
      const blocked = await t.tryAct({ op: 'click', pageId: p, target: btn('删除记录') });
      t.eq(blocked.error?.code, 'dialog_blocking', '对话框挂着时点别的按钮');
      await t.act({
        op: 'handle_dialog',
        pageId: p,
        action: 'accept',
        post: [{ text_present: '提示已关闭' }],
      });

      const cases: [string, string, string, Action, string][] = [
        [
          '删除记录',
          'confirm',
          '确定删除这条记录吗？',
          { op: 'handle_dialog', pageId: p, action: 'accept' },
          '确认结果：已删除',
        ],
        [
          '删除记录',
          'confirm',
          '确定删除这条记录吗？',
          { op: 'handle_dialog', pageId: p, action: 'dismiss' },
          '确认结果：已取消',
        ],
        [
          '重命名',
          'prompt',
          '请输入新名称',
          { op: 'handle_dialog', pageId: p, action: 'accept', prompt_text: '季度报表' },
          '新名称：季度报表',
        ],
        [
          '重命名',
          'prompt',
          '请输入新名称',
          { op: 'handle_dialog', pageId: p, action: 'dismiss' },
          '重命名已取消',
        ],
      ];
      for (const [button, type, message, handle, want] of cases) {
        const c = await t.act({ op: 'click', pageId: p, target: btn(button) });
        t.eq(dialog(c), [type, message, 'pending'], `${button} 弹出的对话框`);
        await t.act({ ...handle, post: [{ text_present: want }] } as Action);
        t.eq(await textOf(t, p, '#dialog-result'), want, `${button} 的处理结果`);
      }
    },
  },
  {
    id: 'L5',
    name: 'Frames：同源、跨域、Shadow Root 里的 iframe，按角色+名称加 frame 链操作（structure 夹具）',
    async run(t) {
      const p = await t.open(`${t.fx}/structure/`);
      await t.act(framesLoaded(p));
      // observe 看得到各 frame 里的元素：四个 frame 里各有一个“提交”，编号各不相同
      const ob = await t.observe(p);
      const submits = ob.elements.filter((e) => e.name === '提交').map((e) => e.ref);
      t.eq(new Set(submits).size, 4, 'observe 里四个 frame 的“提交”编号各不相同');

      await submitIn(t, p, FRAMES.same, 's@x.cn', '同源框架提交 1 次（s@x.cn）');
      await submitIn(t, p, FRAMES.cross, 'c@x.cn', '跨域框架提交 1 次（c@x.cn）');
      await submitIn(t, p, FRAMES.shadow, 'h@x.cn', '组件内框架提交 1 次（h@x.cn）');
      for (const [who, email] of [
        ['same', 's@x.cn'],
        ['cross', 'c@x.cn'],
        ['shadow', 'h@x.cn'],
      ] as const) {
        const frame = t.must(
          t
            .page(p)
            .frames()
            .find((f) => f.url().includes(`who=${who}`)),
          `找不到 ${who} 框架`,
        );
        t.eq(
          await frame.$eval('#result', (e) => e.textContent),
          `已提交 1 次：${email}`,
          `${who} 框架内的结果`,
        );
      }
    },
  },
  {
    id: 'L6',
    name: 'Nested Frames：同源外层嵌跨域内层，两级 frame 链（structure 夹具）',
    async run(t) {
      const p = await t.open(`${t.fx}/structure/`);
      await t.act(framesLoaded(p));
      await t.act({
        op: 'click',
        pageId: p,
        target: { role: 'button', name: '外层按钮', frame: FRAMES.outer },
        post: [{ text_present: '外层框架提交 1 次' }],
      });
      await submitIn(t, p, FRAMES.nested, 'n@x.cn', '嵌套框架提交 1 次（n@x.cn）');
      await submitIn(t, p, FRAMES.nested, 'n2@x.cn', '嵌套框架提交 2 次（n2@x.cn）');
      const inner = t.must(
        t
          .page(p)
          .frames()
          .find((f) => f.url().includes('who=nested')),
        '找不到内层框架',
      );
      t.eq(
        await inner.$eval('#result', (e) => e.textContent),
        '已提交 2 次：n2@x.cn',
        '内层框架里的结果',
      );
    },
  },
  {
    id: 'L7',
    name: 'Shadow DOM：开放、嵌套的开放、封闭的 Shadow Root，按角色+名称操作（structure 夹具）',
    async run(t) {
      const p = await t.open(`${t.fx}/structure/`);
      const ob = await t.observe(p);
      for (const name of ['关注', '收藏', '金额', '支付']) {
        t.check(
          ob.elements.some((e) => e.name === name),
          `observe 里没有 Shadow DOM 内的“${name}”`,
        );
      }
      await t.act({ op: 'click', pageId: p, target: btn('关注') });
      await t.act({ op: 'click', pageId: p, target: btn('收藏') });
      await t.act({
        op: 'fill',
        pageId: p,
        target: { role: 'textbox', name: '金额' },
        value: '88',
      });
      await t.act({
        op: 'click',
        pageId: p,
        target: btn('支付'),
        post: [{ text_present: '已支付 88 元' }],
      });
      t.eq(await logOf(t, p), ['已关注', '已收藏', '已支付 88 元'], '点击记录');
    },
  },
  {
    id: 'L8',
    name: 'Lab 复杂结构：Shadow DOM 与跨域、嵌套 frame，操作后与服务端账本对账',
    async run(t) {
      const space = 'bw7-structure';
      const ctl = labControl(t.lab, space);
      await ctl.reset();
      const p = await t.open(`${t.lab.url(space)}/structure`);
      // 页面就绪标记：脚本已就绪，四个 frame 都加载完
      await t.act({
        op: 'wait_for',
        pageId: p,
        until: [
          {
            expr: "document.body.dataset.structureReady === '1' && document.documentElement.dataset.framesReady === '4'",
          },
        ],
        timeout_ms: 10_000,
      });
      // 先观察再操作（封闭 Shadow Root 里的“金额”要等 observe 把它挂出来后，角色定位器才找得到）
      await t.observe(p);
      const follow = reported(t, p, 'follow');
      await t.act({ op: 'click', pageId: p, target: btn('关注') });
      await follow;
      const favorite = reported(t, p, 'favorite');
      await t.act({ op: 'click', pageId: p, target: btn('收藏') });
      await favorite;
      await t.act({
        op: 'fill',
        pageId: p,
        target: { role: 'textbox', name: '金额' },
        value: '88',
      });
      const pay = reported(t, p, 'pay');
      await t.act({
        op: 'click',
        pageId: p,
        target: btn('支付'),
        post: [{ text_present: '已支付 88 元' }],
      });
      await pay;

      const cross = reported(t, p, 'frame_submit');
      await submitIn(t, p, FRAMES.cross, 'c@x.cn', '跨域框架提交 1 次（c@x.cn）');
      await cross;
      const nested = reported(t, p, 'frame_submit');
      await submitIn(t, p, FRAMES.nested, 'n@x.cn', '嵌套框架提交 1 次（n@x.cn）');
      await nested;

      const s = (await ctl.state()).modules.structure as StructureState;
      t.eq(
        [s.counts.follow, s.counts.favorite, s.counts.pay, s.counts.frame_submit],
        [1, 1, 1, 2],
        '账本里各类事件的次数',
      );
      t.eq(s.events.find((e) => e.type === 'pay')?.detail, { amount: '88' }, '支付金额');
      t.eq(
        [s.frames.cross?.email, s.frames.nested?.email],
        ['c@x.cn', 'n@x.cn'],
        '各 frame 最近一次提交的邮箱',
      );
    },
  },
  {
    id: 'L9',
    name: 'File Upload：文件输入框（多选）、自绘上传按钮、中文文件名；越出工作区被拒（forms-files）',
    async run(t) {
      const dir = t.tempDir();
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'report.txt'), '季度报告：一切正常。\n');
      writeFileSync(join(dir, '季度报告.txt'), '中文文件名的附件\n');
      writeFileSync(join(dir, 'sub', 'data.csv'), 'a,b\n'.repeat(300));
      writeFileSync(join(dir, 'avatar.png'), Buffer.alloc(2048, 7));
      const size = (f: string) => statSync(join(dir, f)).size;
      const opts = { filesRoot: dir };
      const p = await t.open(`${t.fx}/forms-files/`);

      await t.act(
        {
          op: 'upload_file',
          pageId: p,
          target: { role: 'button', name: '选择附件' },
          files: ['report.txt', 'sub/data.csv'],
          post: [{ text_present: 'data.csv（' }],
        },
        opts,
      );
      const items = await t.page(p).$$eval('#file-list li', (els) => els.map((e) => e.textContent));
      t.eq(
        items,
        [`report.txt（${size('report.txt')} 字节）`, `data.csv（${size('sub/data.csv')} 字节）`],
        '多选上传后页面列出的文件',
      );

      // 自绘按钮：点击后弹出文件选择框，选入文件
      await t.act(
        {
          op: 'upload_file',
          pageId: p,
          target: btn('上传头像'),
          files: ['avatar.png'],
          post: [{ text_present: '头像：avatar.png' }],
        },
        opts,
      );
      t.eq(
        await textOf(t, p, '#avatar-result'),
        `头像：avatar.png（${size('avatar.png')} 字节）`,
        '头像上传结果',
      );

      // 中文文件名
      await t.act(
        {
          op: 'upload_file',
          pageId: p,
          target: { css: '#attach' },
          files: ['季度报告.txt'],
          post: [{ text_present: '季度报告.txt（' }],
        },
        opts,
      );
      t.eq(
        await textOf(t, p, '#file-list'),
        `季度报告.txt（${size('季度报告.txt')} 字节）`,
        '中文文件名',
      );

      const outside = await t.tryAct(
        { op: 'upload_file', pageId: p, target: { css: '#attach' }, files: ['../outside.txt'] },
        opts,
      );
      t.eq(outside.error?.code, 'path_outside_workspace', '越出工作区的路径');
    },
  },
  {
    id: 'L10',
    name: 'File Download：点击下载链接，文件与接口一致、中文文件名（forms-files 下载接口）',
    async run(t) {
      const dir = t.tempDir();
      const tap = await t.downloads(dir);
      const p = await t.open(`${t.fx}/forms-files/`);
      const ob = await t.observe(p);
      const a = t.must(
        ob.elements.find((e) => e.role === 'link' && e.name === '下载订单报表（CSV）'),
        '元素表里没有下载链接',
      );
      t.check(
        a.href?.endsWith('/api/forms-files/report.csv?seed=1&rows=10'),
        `下载链接：${a.href}`,
      );
      const done = tap.next();
      const r = await t.act({ op: 'click', pageId: p, target: { ref: a.ref } });
      t.eq(r.effects.navigated, false, '下载不是导航');
      const d = await done;
      t.check(
        readFileSync(d.file).equals(Buffer.from(reportCsv(1, 10), 'utf8')),
        '下载的文件与接口内容一致（含 UTF-8 BOM）',
      );
      t.eq(d.suggested, '订单报表.csv', '浏览器取的文件名');
      t.check(/\/forms-files\/$/.test(t.page(p).url()), '页面没有跳走');
    },
  },
  {
    id: 'L11',
    name: 'File Download：Lab 订单后台“导出 CSV”（登录后下载），内容与接口逐字节一致',
    async run(t) {
      const space = 'bw7-export';
      await labControl(t.lab, space).reset();
      const dir = t.tempDir();
      const tap = await t.downloads(dir);
      const p = await t.open(`${t.lab.url(space)}/login?next=%2Forders`);
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
      await t.act({
        op: 'click',
        pageId: p,
        target: btn('登录'),
        post: [{ url_matches: '/orders$' }, { text_present: '共 200 条' }],
        timeout_ms: 10_000,
      });
      const ob = await t.observe(p);
      const a = t.must(
        ob.elements.find((e) => e.role === 'link' && e.name === '导出 CSV'),
        '元素表里没有“导出 CSV”链接',
      );
      const href = t.must(a.href, '“导出 CSV”链接没有 href');
      const done = tap.next();
      const r = await t.act({ op: 'click', pageId: p, target: link('导出 CSV') });
      t.eq(r.effects.navigated, false, '下载不是导航');
      const d = await done;
      // 用页面的登录会话取同一个接口，作为期望内容
      const cookie = t.must(
        (await t.env.browser.cookies()).find((c) => c.name === 'lab_session'),
        '浏览器里没有 Lab 的会话 cookie',
      );
      const want = Buffer.from(
        await (
          await fetch(href, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
        ).arrayBuffer(),
      );
      const got = readFileSync(d.file);
      t.check(got.equals(want), `下载内容与接口不一致（${got.length} 与 ${want.length} 字节）`);
      t.eq([...got.subarray(0, 3)], [0xef, 0xbb, 0xbf], '以 UTF-8 BOM 开头');
      t.eq(got.toString('utf8').split('\r\n').filter(Boolean).length, 201, '表头加 200 条订单');
      t.eq(d.suggested, 'orders.csv', '文件名');
    },
  },
  {
    id: 'L12',
    name: 'Multiple Windows：链接（target=_blank）与 window.open 各开一个新标签页，切换、操作、关闭',
    async run(t) {
      const p = await t.open(`${t.fx}/structure/`);
      const a = await t.act({ op: 'click', pageId: p, target: link('在新标签页打开报表') });
      t.eq(a.effects.new_pages.length, 1, '点链接新开的标签页数');
      const w1 = t.adopt(a.effects.new_pages[0]);
      // 新标签页到了前台，原页面成了后台标签页：先切回再点（对后台标签页点击要多等好几秒，见测试里的 todo）
      await t.act({ op: 'select_page', pageId: p });
      const b = await t.act({ op: 'click', pageId: p, target: btn('弹出窗口') });
      t.eq(b.effects.new_pages.length, 1, 'window.open 新开的标签页数');
      const w2 = t.adopt(b.effects.new_pages[0]);
      t.eq(new Set([p, w1, w2]).size, 3, '三个标签页的 pageId 各不相同');
      const registered = t.env.session.pages.list().map((x) => x.pageId);
      t.check(
        [p, w1, w2].every((id) => registered.includes(id)),
        '新标签页都已登记',
      );

      for (const [id, from] of [
        [w1, 'link'],
        [w2, 'open'],
      ] as const) {
        await t.act({
          op: 'wait_for',
          pageId: id,
          until: [{ text_present: `打开方式：${from}` }, { title_matches: '报表' }],
          timeout_ms: 5000,
        });
        await t.act({ op: 'select_page', pageId: id });
        await t.act({
          op: 'click',
          pageId: id,
          target: btn('确认收到'),
          post: [{ text_present: `已确认（来自 ${from}）` }],
        });
      }
      await t.act({ op: 'close_page', pageId: w2 });
      await t.act({ op: 'close_page', pageId: w1 });
      await t.act({ op: 'select_page', pageId: p });
      await t.act({ op: 'assert', pageId: p, checks: [{ title_matches: '页面结构' }] });
      const left = t.env.session.pages.list().map((x) => x.pageId);
      t.check(!left.includes(w1) && !left.includes(w2), '关闭后的标签页已从登记里移除');
    },
  },
  {
    id: 'L13',
    name: 'Multiple Windows：Lab 复杂结构的新标签页（链接与 window.open），确认动作与账本对账',
    async run(t) {
      const space = 'bw7-windows';
      const ctl = labControl(t.lab, space);
      await ctl.reset();
      const p = await t.open(`${t.lab.url(space)}/structure`);
      const opened = reported(t, p, 'open_window');
      const a = await t.act({ op: 'click', pageId: p, target: link('在新标签页打开报表') });
      const w1 = t.adopt(a.effects.new_pages[0]);
      await t.act({ op: 'select_page', pageId: p });
      const b = await t.act({ op: 'click', pageId: p, target: btn('弹出窗口') });
      const w2 = t.adopt(b.effects.new_pages[0]);
      await opened;
      for (const [id, from] of [
        [w1, 'link'],
        [w2, 'open'],
      ] as const) {
        await t.act({
          op: 'wait_for',
          pageId: id,
          until: [{ text_present: `打开方式：${from}` }],
          timeout_ms: 5000,
        });
        await t.act({ op: 'select_page', pageId: id });
        const ack = reported(t, id, 'report_ack');
        await t.act({
          op: 'click',
          pageId: id,
          target: btn('确认收到'),
          post: [{ text_present: `已确认（来自 ${from}）` }],
        });
        await ack;
      }
      const s = (await ctl.state()).modules.structure as StructureState;
      t.eq(
        [s.counts.open_window, s.counts.report_ack],
        [1, 2],
        '账本里 window.open 与确认收到的次数',
      );
      t.eq(
        s.events
          .filter((e) => e.type === 'report_ack')
          .map((e) => e.detail.from)
          .sort(),
        ['link', 'open'],
        '两个新标签页各确认一次',
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// 公开站点场景：The Internet（https://the-internet.herokuapp.com/）
// ---------------------------------------------------------------------------------------------

const liveScenarios = (sites: Sites): Scenario[] => {
  const ti = sites.internet;
  return [
    {
      id: 'V1',
      site: 'internet',
      name: 'Entry Ad（/entry_ad）：模态框遮住页面，规则点 Close 后重试；重新开启并刷新后仍由规则处理',
      async run(t) {
        const p = await t.open(`${ti}/entry_ad`, 30_000);
        // 模态框是整页遮罩 #modal，里面的“Close”是 .modal-footer 下的段落，点它关闭
        const close = { css: '.modal-footer p' };
        const rules: PopupRule[] = [
          {
            name: 'entry-ad',
            hit: /modal/i,
            handle: (pageId) => ({ op: 'click', pageId, target: close }),
          },
        ];
        for (const round of [1, 2]) {
          // 模态框在页面打开约半秒后弹出：等“Close”可见
          await t.act({
            op: 'wait_for',
            pageId: p,
            until: [{ element_present: close }],
            timeout_ms: 15_000,
          });
          // 模态框挡着页面：点正文里的“click here”（重新开启广告）报遮挡，规则关掉模态框后重试成功
          const calls: string[] = [];
          await t.act(
            { op: 'click', pageId: p, target: { css: '#restart-ad' } },
            { onObscured: popupRules(t, p, rules, calls) },
          );
          t.eq(calls, ['entry-ad'], `第 ${round} 次加载触发的规则`);
          // 刷新页面：点过“click here”后广告被重新开启，刷新后会再弹一次
          if (round === 1)
            await t.act({ op: 'navigate_page', pageId: p, type: 'reload', timeout_ms: 30_000 });
        }
      },
    },
    {
      id: 'V2',
      site: 'internet',
      name: 'JavaScript Alerts（/javascript_alerts）：JS Alert、Confirm（确定/取消）、Prompt（输入/取消）',
      async run(t) {
        const p = await t.open(`${ti}/javascript_alerts`, 30_000);
        const cases: [string, string, string, Action, string][] = [
          [
            'Click for JS Alert',
            'alert',
            'I am a JS Alert',
            { op: 'handle_dialog', pageId: p, action: 'accept' },
            'You successfully clicked an alert',
          ],
          [
            'Click for JS Confirm',
            'confirm',
            'I am a JS Confirm',
            { op: 'handle_dialog', pageId: p, action: 'accept' },
            'You clicked: Ok',
          ],
          [
            'Click for JS Confirm',
            'confirm',
            'I am a JS Confirm',
            { op: 'handle_dialog', pageId: p, action: 'dismiss' },
            'You clicked: Cancel',
          ],
          [
            'Click for JS Prompt',
            'prompt',
            'I am a JS prompt',
            { op: 'handle_dialog', pageId: p, action: 'accept', prompt_text: 'Obact' },
            'You entered: Obact',
          ],
          [
            'Click for JS Prompt',
            'prompt',
            'I am a JS prompt',
            { op: 'handle_dialog', pageId: p, action: 'dismiss' },
            'You entered: null',
          ],
        ];
        for (const [button, type, message, handle, want] of cases) {
          const c = await t.act({ op: 'click', pageId: p, target: btn(button) });
          const d = c.effects.dialogs[0];
          t.eq(
            [d?.type, d?.message, d?.handled],
            [type, message, 'pending'],
            `${button} 弹出的对话框`,
          );
          await t.act({ ...handle, post: [{ text_present: want }] } as Action);
          t.eq(await textOf(t, p, '#result'), want, `${button} 的结果`);
        }
      },
    },
    {
      id: 'V3',
      site: 'internet',
      name: 'Frames 与 Nested Frames（/frames → /nested_frames）：frameset 里的四个框架',
      async run(t) {
        const p = await t.open(`${ti}/frames`, 30_000);
        await t.act({
          op: 'click',
          pageId: p,
          target: link('Nested Frames'),
          post: [{ url_matches: '/nested_frames$' }],
          timeout_ms: 15_000,
        });
        // <frameset> 里：顶部 frame 再分左、中、右三个 frame，底部一个 frame
        const top = 'frame[name="frame-top"]';
        const chains: [string, string[], string][] = [
          ['LEFT', [top, 'frame[name="frame-left"]'], 'body'],
          ['MIDDLE', [top, 'frame[name="frame-middle"]'], '#content'],
          ['RIGHT', [top, 'frame[name="frame-right"]'], 'body'],
          ['BOTTOM', ['frame[name="frame-bottom"]'], 'body'],
        ];
        // 逐个按 frame 链定位：四个框架都能进去，里面的文字对得上
        await t.act({
          op: 'wait_for',
          pageId: p,
          until: checks(chains.map(([, frame, css]) => ({ element_present: { css, frame } }))),
          timeout_ms: 15_000,
        });
        for (const [word, frame, css] of chains) {
          await t.act({
            op: 'assert',
            pageId: p,
            checks: [{ element_present: { css, frame } }, { text_present: word }],
          });
        }
        const inner = await t.eval(p, () => document.querySelectorAll('frame').length);
        t.eq(inner, 2, '顶层 frameset 的直接子框架数');
      },
    },
    {
      id: 'V4',
      site: 'internet',
      name: 'iFrame（/iframe）：富文本编辑器在 iframe 里，往里填内容',
      async run(t) {
        const p = await t.open(`${ti}/iframe`, 30_000);
        const editor = { css: '#tinymce', frame: ['#mce_0_ifr'] };
        await t.act({
          op: 'wait_for',
          pageId: p,
          until: [{ element_present: editor }],
          timeout_ms: 30_000,
        });
        await t.act({ op: 'fill', pageId: p, target: editor, value: 'Hello from Obact' });
        // 读回编辑器里的内容：在页面的各 frame 里找 #tinymce
        let got = '';
        for (const f of t.page(p).frames()) {
          const h = await f.$('#tinymce');
          if (h) got = await h.evaluate((e) => (e as HTMLElement).innerText.trim());
        }
        t.eq(got, 'Hello from Obact', '编辑器里的内容');
      },
    },
    {
      id: 'V5',
      site: 'internet',
      name: 'Shadow DOM（/shadowdom）：自定义元素的 Shadow Root 与插槽内容',
      async run(t) {
        const p = await t.open(`${ti}/shadowdom`, 30_000);
        const slotted = ["Let's have some different text!", 'In a list!'];
        await t.act({
          op: 'assert',
          pageId: p,
          checks: checks(slotted.map((text_present) => ({ text_present }))),
        });
        const shadows = await t.eval(p, () =>
          [...document.querySelectorAll('my-paragraph')].map((e) => !!e.shadowRoot),
        );
        t.eq(shadows, [true, true], '两个 my-paragraph 都有 Shadow Root');
        const ob = await t.observe(p);
        for (const text of slotted) {
          t.check(
            JSON.stringify(ob.text_md ?? ob.snapshot_text ?? '').includes(text),
            `observe 的文本里没有“${text}”`,
          );
        }
      },
    },
    {
      id: 'V6',
      site: 'internet',
      name: 'File Upload（/upload）：选择文件并提交，页面显示上传的文件名',
      async run(t) {
        const dir = t.tempDir();
        writeFileSync(join(dir, 'obact-upload.txt'), 'Obact BW-7 upload\n');
        const p = await t.open(`${ti}/upload`, 30_000);
        await t.act(
          {
            op: 'upload_file',
            pageId: p,
            target: { css: 'input[type="file"]' },
            files: ['obact-upload.txt'],
          },
          { filesRoot: dir },
        );
        await t.act({
          op: 'click',
          pageId: p,
          target: { css: '#file-submit' },
          post: [{ text_present: 'File Uploaded!' }],
          timeout_ms: 30_000,
        });
        t.eq(
          (await textOf(t, p, '#uploaded-files')).trim(),
          'obact-upload.txt',
          '页面显示的文件名',
        );
      },
    },
    {
      id: 'V7',
      site: 'internet',
      name: 'File Download（/download）：点击第一个下载链接，文件落盘且文件名与链接一致',
      async run(t) {
        const dir = t.tempDir();
        const tap = await t.downloads(dir);
        const p = await t.open(`${ti}/download`, 30_000);
        const ob = await t.observe(p);
        const a = t.must(
          ob.elements.find((e) => e.role === 'link' && e.href?.includes('/download/')),
          '页面上没有下载链接',
        );
        const done = tap.next(30_000);
        const r = await t.act({ op: 'click', pageId: p, target: { ref: a.ref } });
        t.eq(r.effects.navigated, false, '下载不是导航');
        const d = await done;
        t.check(statSync(d.file).size > 0, '下载的文件是空的');
        t.eq(
          d.suggested,
          decodeURIComponent(basename(new URL(a.href ?? '').pathname)),
          '文件名与链接一致',
        );
        t.note(`下载 ${d.suggested}（${statSync(d.file).size} 字节）`);
      },
    },
    {
      id: 'V8',
      site: 'internet',
      name: 'Multiple Windows（/windows）：点链接新开标签页，切换、核对、关闭后回到原页面',
      async run(t) {
        const p = await t.open(`${ti}/windows`, 30_000);
        const r = await t.act({ op: 'click', pageId: p, target: link('Click Here') });
        t.eq(r.effects.new_pages.length, 1, '新开的标签页数');
        const w = t.adopt(r.effects.new_pages[0]);
        await t.act({
          op: 'wait_for',
          pageId: w,
          until: [{ text_present: 'New Window' }, { title_matches: 'New Window' }],
          timeout_ms: 15_000,
        });
        await t.act({ op: 'select_page', pageId: w });
        await t.act({ op: 'close_page', pageId: w });
        await t.act({ op: 'select_page', pageId: p });
        await t.act({
          op: 'assert',
          pageId: p,
          checks: [{ text_present: 'Opening a new window' }, { url_matches: '/windows$' }],
        });
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
  const files = { md: join(outDir, `bw7-${mode}.md`), json: join(outDir, `bw7-${mode}.json`) };
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
