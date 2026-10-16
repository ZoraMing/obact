// Lab 模块：干扰层（PRD 9.3；FR-13、FR-23；BW-7 的 Entry Ad）。
// 两部分：协议层（fetch，不需要浏览器）测页面标记、演示开关、Cookie 与广告的状态、随机弹窗的概率与可复现、提交接口的幂等与故障；
// 浏览器层（observe + act）测五种干扰：Cookie 提示条挡住按钮、透明遮挡层、布局偏移、Entry Ad、随机弹窗（popup_rate），
// 最后是所有干扰叠在一起完成一次提交。测试里没有固定延时：等待都是条件等待（act 的 wait_for、expr 检查、轮询）。
//
// 这里只装配 noise 和一个测试用的普通页面（other），不加载 lab/src/modules 下的其他模块：
// 并行开发时别的模块写到一半不会连累本文件。other 页用来证明随机弹窗对“任意 Lab 页面”生效。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { type ActOptions, act, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { createLab, type Lab } from '../src/app.ts';
import { type LabModule, page } from '../src/core.ts';
import noise, { AD_DELAY_MS, MASK_MS, type NoiseData, SHIFT_MS } from '../src/modules/noise.ts';
import { CHROME, control, SKIP } from './helpers.ts';

const contracts = new Contracts();

/** 测试用的普通页面：一个“继续”按钮。随机弹窗来自 noise 的 shell 钩子，不是这个模块的东西。 */
const other: LabModule = {
  name: 'other',
  title: '其他页',
  nav: '/other',
  init(space) {
    space.data.other = {};
  },
  routes(r) {
    r.get('/other', (ctx) =>
      ctx.html(
        page(
          ctx,
          [other],
          '其他页',
          `<h1>其他页</h1>
<p><button type="button" id="other-go">继续</button></p>
<p id="other-result" role="status"></p>
<script>
  document.getElementById('other-go').addEventListener('click', function () {
    document.getElementById('other-result').textContent = '已继续';
  });
</script>`,
        ),
      ),
    );
  },
};

let lab: Lab;
before(async () => {
  lab = await createLab({ modules: [noise, other] });
});
after(async () => {
  await lab?.close();
});

const noiseState = async (space: string) =>
  (await control(lab, space).state()).modules.noise as NoiseData;

/** 条件等待（协议层用）：条件成立即返回，超时报错。 */
async function until(cond: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const get = (space: string, path: string) => fetch(`${lab.url(space)}${path}`);
const getText = async (space: string, path: string) => (await get(space, path)).text();
const post = (space: string, path: string, body?: unknown, signal?: AbortSignal) =>
  fetch(`${lab.url(space)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
/** HTML 里广告层的个数。 */
const adCount = (html: string) => (html.match(/id="noise-ad"/g) ?? []).length;

// ---------------------------------------------------------------------------------------------
// 协议层
// ---------------------------------------------------------------------------------------------

describe('干扰层：协议层', () => {
  test('模块信息、默认常量与初始状态', async () => {
    assert.equal(noise.name, 'noise');
    assert.equal(noise.title, '干扰层');
    assert.equal(noise.nav, '/noise');
    assert.equal(AD_DELAY_MS, 500);
    assert.equal(MASK_MS, 1500);
    assert.equal(SHIFT_MS, 300);
    assert.deepEqual(await noiseState('n-init'), {
      ad_shown: 0,
      ad_closed: 0,
      ad_dismissed: false,
      entry_ad_loads: 0,
      cookie_accepted: false,
      form_submits: 0,
      names: [],
    });
  });

  test('/noise 页面：标题、导航、表单、Cookie 提示条、遮挡层与偏移的默认参数；默认不弹广告', async () => {
    const res = await get('n-page', '/noise');
    assert.equal(res.status, 200, '页面不需要登录');
    const html = await res.text();
    assert.match(html, /<title>干扰层 - Obact Lab<\/title>/);
    assert.match(html, /<h1>干扰层<\/h1>/);
    assert.match(html, /<a href="\/s\/n-page\/noise">干扰层<\/a>/, '导航里有“干扰层”');
    assert.match(html, /<label for="noise-name">姓名<\/label>/);
    assert.match(html, /<button type="submit" id="noise-submit"[^>]*>提交<\/button>/);
    assert.match(html, /id="noise-cookie"[^>]*role="region"/);
    assert.match(html, /<button type="button" id="noise-cookie-accept"[^>]*>接受<\/button>/);
    assert.match(html, /id="noise-blocker"/);
    assert.match(html, /data-mask-ms="1500"/);
    assert.match(html, /data-shift-mode="timer" data-shift-ms="300"/);
    assert.match(html, /在线客服/);
    assert.equal(adCount(html), 0, 'popup_rate 为 0 时不弹广告');
    assert.equal((await noiseState('n-page')).ad_shown, 0);
  });

  test('演示开关：cookie、mask、mask_ms、shift、shift_ms、shift=hover；非法值取默认', async () => {
    const p = (q: string) => getText('n-params', `/noise${q}`);
    assert.doesNotMatch(await p('?cookie=0'), /id="noise-cookie"/);
    assert.match(await p('?cookie=1'), /id="noise-cookie"/);
    const noMask = await p('?mask=0');
    assert.doesNotMatch(noMask, /id="noise-blocker"/);
    assert.match(noMask, /data-mask-ms="0"/);
    assert.doesNotMatch(await p('?mask_ms=0'), /id="noise-blocker"/);
    assert.match(await p('?mask_ms=60000'), /data-mask-ms="60000"/);
    for (const bad of ['abc', '-5', '1.5', '9999999']) {
      assert.match(await p(`?mask_ms=${bad}`), /data-mask-ms="1500"/, `mask_ms=${bad} 取默认值`);
      assert.match(await p(`?shift_ms=${bad}`), /data-shift-ms="300"/, `shift_ms=${bad} 取默认值`);
    }
    assert.match(await p('?shift=0'), /data-shift-mode="off"/);
    assert.match(await p('?shift=hover'), /data-shift-mode="hover"/);
    assert.match(await p('?shift_ms=900'), /data-shift-mode="timer" data-shift-ms="900"/);
  });

  test('Cookie 接受：按空间记住，页面不再输出提示条；空间之间互不影响；reset 后恢复', async () => {
    const c = control(lab, 'n-cookie');
    assert.match(await getText('n-cookie', '/noise'), /id="noise-cookie"/);
    const r = await post('n-cookie', '/noise/cookie-accept');
    assert.equal(r.status, 200);
    assert.equal((await noiseState('n-cookie')).cookie_accepted, true);
    assert.doesNotMatch(await getText('n-cookie', '/noise'), /id="noise-cookie"/, '接受后不再显示');
    assert.match(await getText('n-cookie-2', '/noise'), /id="noise-cookie"/, '另一个空间仍显示');
    assert.equal((await noiseState('n-cookie-2')).cookie_accepted, false);
    await c.reset();
    assert.equal((await noiseState('n-cookie')).cookie_accepted, false);
    assert.match(await getText('n-cookie', '/noise'), /id="noise-cookie"/);
  });

  test('Entry Ad 页：每次加载都有广告层（特别优惠 + 关闭），不受 popup_rate 与“已关闭”影响，也不叠加随机弹窗', async () => {
    const html = await getText('n-entry', '/noise/entry-ad');
    assert.match(html, /<title>入口广告 - Obact Lab<\/title>/);
    assert.equal(adCount(html), 1);
    assert.match(html, /<h2 id="noise-ad-title">特别优惠<\/h2>/);
    assert.match(html, /<button type="button" class="noise-ad-close"[^>]*>关闭<\/button>/);
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /data-delay="500"/);
    assert.match(html, /<button type="button" id="entry-continue"[^>]*>继续阅读<\/button>/);
    let s = await noiseState('n-entry');
    assert.equal(s.entry_ad_loads, 1);
    assert.equal(s.ad_shown, 1);

    // 关掉广告以后，随机弹窗停了，Entry Ad 页仍然每次都弹
    await post('n-entry', '/noise/ad-close');
    assert.equal(adCount(await getText('n-entry', '/noise/entry-ad')), 1);
    // popup_rate=1 时仍然只有一个广告层、只计一次
    await control(lab, 'n-entry').faults({ popup_rate: 1 });
    assert.equal(adCount(await getText('n-entry', '/noise/entry-ad')), 1);
    s = await noiseState('n-entry');
    assert.equal(s.entry_ad_loads, 3);
    assert.equal(s.ad_shown, 3, '每次加载计一次');
    assert.equal(s.ad_closed, 1);
  });

  test('popup_rate=1：任意 Lab 页面（首页、/noise、其他模块的页面、404）都带广告层；关闭后本空间不再弹出，其他空间不受影响', async () => {
    const c = control(lab, 'n-pop');
    for (const path of ['/', '/noise', '/other', '/nothing-here']) {
      assert.equal(adCount(await getText('n-pop', path)), 0, `popup_rate 为 0：${path} 不弹`);
    }
    await c.faults({ popup_rate: 1 });
    for (const path of ['/', '/noise', '/other', '/nothing-here']) {
      assert.equal(adCount(await getText('n-pop', path)), 1, `popup_rate 为 1：${path} 要弹`);
    }
    let s = await noiseState('n-pop');
    assert.equal(s.ad_shown, 4);
    assert.equal(s.ad_closed, 0);
    assert.equal(s.ad_dismissed, false);

    assert.equal((await post('n-pop', '/noise/ad-close')).status, 200);
    s = await noiseState('n-pop');
    assert.equal(s.ad_closed, 1);
    assert.equal(s.ad_dismissed, true);
    for (const path of ['/', '/noise', '/other']) {
      assert.equal(adCount(await getText('n-pop', path)), 0, `关闭后 ${path} 不再弹`);
    }
    assert.equal((await noiseState('n-pop')).ad_shown, 4, '没再输出广告层');

    await control(lab, 'n-pop-2').faults({ popup_rate: 1 });
    assert.equal(adCount(await getText('n-pop-2', '/other')), 1, '另一个空间照样弹');

    await c.reset();
    await c.faults({ popup_rate: 1 });
    assert.equal(adCount(await getText('n-pop', '/other')), 1, 'reset 后恢复弹出');
    assert.equal((await noiseState('n-pop')).ad_closed, 0);
  });

  test('0 < popup_rate < 1：由空间的随机序列决定，同种子可复现；popup_rate 为 0 时不消耗随机数', async () => {
    const c = control(lab, 'n-rng');
    const seq = async (n: number) => {
      const out: boolean[] = [];
      for (let i = 0; i < n; i++) out.push(adCount(await getText('n-rng', '/other')) > 0);
      return out;
    };
    await c.faults({ popup_rate: 0.5 });
    const a = await seq(40);
    assert.ok(a.includes(true) && a.includes(false), `一半的概率应当有弹有不弹：${a.join()}`);

    await c.reset();
    for (let i = 0; i < 5; i++) await getText('n-rng', '/other'); // popup_rate 为 0：不消耗随机数
    await c.faults({ popup_rate: 0.5 });
    assert.deepEqual(await seq(40), a, '同一个种子，序列相同');

    await c.reset();
    await c.faults({ popup_rate: 0.5 });
    await post('n-rng', '/noise/ad-close');
    for (let i = 0; i < 5; i++) await getText('n-rng', '/other'); // 已关闭：同样不消耗
    const s = await noiseState('n-rng');
    assert.equal(s.ad_shown, 0, '关闭之后再没有输出广告层');
  });

  test('提交接口：幂等键去重、姓名记录、无键也计数、非法请求体 400', async () => {
    const c = control(lab, 'n-submit');
    const r1 = await post('n-submit', '/api/noise/submit', { name: '张三', key: 'k1' });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, key: 'k1', duplicate: false, form_submits: 1 });
    const r2 = await post('n-submit', '/api/noise/submit', { name: '张三', key: 'k1' });
    assert.deepEqual(await r2.json(), { ok: true, key: 'k1', duplicate: true, form_submits: 1 });
    await post('n-submit', '/api/noise/submit', { name: '李四' });
    await post('n-submit', '/api/noise/submit', { name: '王'.repeat(80), key: 'k2' });
    const s = await c.state();
    const n = s.modules.noise as NoiseData;
    assert.equal(n.form_submits, 3);
    assert.deepEqual(n.names, ['张三', '李四', '王'.repeat(50)], '姓名最多保留 50 个字');
    assert.equal(s.submissions.find((x) => x.key === 'k1')?.count, 2, '重复提交体现在提交记录里');
    assert.equal(s.submissions.find((x) => x.key === 'k2')?.count, 1);
    assert.equal(s.submissions.length, 3);
    assert.ok(s.submissions.every((x) => x.op === 'noise.submit'));

    const bad = await fetch(`${lab.url('n-submit')}/api/noise/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{不是 JSON',
    });
    assert.equal(bad.status, 400);
    assert.equal((await noiseState('n-submit')).form_submits, 3);
  });

  test('故障：提交超时但已落库，重试同一个键不重复计数；接口故障不影响 Cookie 与广告', async () => {
    const c = control(lab, 'n-fault');
    await c.faults({ commit_timeout: true });
    await assert.rejects(
      post('n-fault', '/api/noise/submit', { name: '赵六', key: 'once' }, AbortSignal.timeout(300)),
    );
    await until(async () => (await noiseState('n-fault')).form_submits === 1, '提交已落库');
    await c.faults({ commit_timeout: false });
    const retry = await post('n-fault', '/api/noise/submit', { name: '赵六', key: 'once' });
    assert.equal(((await retry.json()) as { duplicate: boolean }).duplicate, true);
    const s = await c.state();
    assert.equal((s.modules.noise as NoiseData).form_submits, 1);
    assert.equal(s.submissions.find((x) => x.key === 'once')?.count, 2);

    await c.faults({ error_rate: 1 });
    assert.equal((await post('n-fault', '/api/noise/submit', { name: 'x', key: 'k' })).status, 500);
    assert.equal((await post('n-fault', '/noise/cookie-accept')).status, 200, '不在 /api/ 下');
    assert.equal((await post('n-fault', '/noise/ad-close')).status, 200);
    await c.faults({ error_rate: 0, drop_rate: 1 });
    assert.equal((await post('n-fault', '/noise/ad-close')).status, 200);
    const n = await noiseState('n-fault');
    assert.equal(n.cookie_accepted, true);
    assert.equal(n.ad_closed, 2);
    assert.equal(n.form_submits, 1, '被注入的 500 没有落库');
  });
});

// ---------------------------------------------------------------------------------------------
// 浏览器层
// ---------------------------------------------------------------------------------------------

describe('干扰层：页面（浏览器 + observe/act）', { skip: SKIP }, () => {
  let browser: Browser;
  let session: Session;
  let profileDir: string;

  before(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'obact-lab-noise-'));
    browser = await launchBrowser({
      profileDir,
      chromePath: CHROME,
      mode: process.env.HEADED === '1' ? 'headed' : 'headless',
    });
    session = await Session.attach(browser);
  });
  after(async () => {
    await session?.close({ closeBrowser: true });
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  /** 执行动作并校验返回值符合契约。 */
  async function run(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await act(session, a, opts);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await run(a, opts);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  /** 动作应当报 obscured，且点击点上是 hit 描述的元素；timeout_ms 压短，不让失败拖慢测试。 */
  async function obscured(a: Action, hit: RegExp): Promise<ActResult> {
    const r = await run({ ...a, timeout_ms: 1500 } as Action);
    assert.equal(r.status, 'error', `${a.op} 应被遮挡`);
    assert.equal(r.error?.code, 'obscured', r.error?.message);
    assert.match(String(r.error?.details?.hit), hit);
    return r;
  }
  async function obs(pageId: string) {
    const r = await observe(session, { pageId });
    contracts.assert('observe.Result', r);
    return r;
  }
  type Obs = Awaited<ReturnType<typeof obs>>;
  const find = (ob: Obs, role: string, name: string) =>
    ob.elements.find((e) => e.role === role && e.name === name);

  /** 在某空间下开新标签页，等到 load；返回 pageId。 */
  async function open(space: string, path: string): Promise<string> {
    const pageId = await session.pages.newPage();
    await session.pages.get(pageId).goto(lab.url(space) + path, { waitUntil: 'load' });
    return pageId;
  }
  const evaluate = <T>(pageId: string, fn: () => T) => session.pages.get(pageId).evaluate(fn);

  type Hooks = {
    clicks: string[];
    loadedAt: number | null;
    maskStartedAt: number | null;
    maskRemovedAt: number | null;
    shiftedAt: number | null;
  };
  type AdHooks = {
    scheduledAt: number;
    shownAt: number | null;
    closedAt: number | null;
    clicks: string[];
  };
  const hooks = (pageId: string) =>
    evaluate(pageId, () => {
      const n = (window as unknown as { __noise: Hooks & { shift: unknown } }).__noise;
      return {
        clicks: [...n.clicks],
        loadedAt: n.loadedAt,
        maskStartedAt: n.maskStartedAt,
        maskRemovedAt: n.maskRemovedAt,
        shiftedAt: n.shiftedAt,
      } as Hooks;
    });
  const adHooks = (pageId: string) =>
    evaluate(pageId, () => {
      const a = (window as unknown as { __noiseAd: AdHooks }).__noiseAd;
      return { ...a, clicks: [...a.clicks] } as AdHooks;
    });
  /** 某个选择器匹配到几个元素。 */
  const count = (pageId: string, css: string) =>
    session.pages.get(pageId).evaluate((sel) => document.querySelectorAll(sel).length, css);
  const text = (pageId: string, css: string) =>
    session.pages
      .get(pageId)
      .evaluate((sel) => document.querySelector(sel)?.textContent ?? null, css);
  const rectOf = (pageId: string, css: string) =>
    session.pages.get(pageId).evaluate((sel) => {
      const r = (document.querySelector(sel) as Element).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    }, css);

  const btn = (name: string) => ({ role: 'button', name });
  const adDialog = { role: 'dialog', name: '特别优惠' };
  /** 等广告层出现（500 毫秒后）。 */
  const waitAd = (pageId: string) =>
    ok({ op: 'wait_for', pageId, until: [{ element_present: adDialog }], timeout_ms: 5000 });

  /**
   * 弹窗规则（模拟 FR-23 的规则文件）：按命中元素决定处理动作，用 act 执行；没有命中返回 false。
   * calls 记录每次触发的规则名。
   */
  function rules(pageId: string, calls: string[]): NonNullable<ActOptions['onObscured']> {
    return async (info) => {
      assert.equal(info.pageId, pageId);
      let name: string;
      let action: Action;
      if (/noise-ad/.test(info.hit)) {
        name = 'ad';
        action = { op: 'click', pageId, target: btn('关闭') };
      } else if (/noise-cookie/.test(info.hit)) {
        name = 'cookie';
        action = { op: 'click', pageId, target: btn('接受') };
      } else if (/noise-blocker/.test(info.hit)) {
        // 透明遮挡层不用“处理”，等它自己消失（条件等待）
        name = 'blocker';
        action = {
          op: 'wait_for',
          pageId,
          until: [{ element_absent: { css: '#noise-blocker' } }],
          timeout_ms: 5000,
        };
      } else return false;
      calls.push(name);
      return (await run(action)).status === 'ok';
    };
  }

  // ---- 一、Cookie 提示条 ----

  test('Cookie 提示条：挡住“在线客服”和“隐私政策”，报 obscured 且不点到提示条；规则点“接受”后重试成功', async () => {
    const space = 'b-cookie';
    const pageId = await open(space, '/noise?mask=0&shift=0');
    const ob = await obs(pageId);
    assert.equal(find(ob, 'button', '在线客服')?.clickable, false, '客服按钮被提示条盖住');
    assert.equal(find(ob, 'link', '隐私政策')?.clickable, false, '页脚链接被盖住');
    assert.equal(find(ob, 'button', '接受')?.clickable, true, '提示条上的按钮可点');
    assert.equal(find(ob, 'button', '提交')?.clickable, true, '没有其他干扰时“提交”可点');

    const blocked = await obscured(
      { op: 'click', pageId, target: btn('在线客服') },
      /noise-cookie/,
    );
    const point = blocked.error?.details?.point as [number, number];
    const [x, y] = point;
    assert.ok(x > 0 && y > 0 && y < ob.viewport.height, '报出被挡的点');
    assert.deepEqual((await hooks(pageId)).clicks, [], '没有点到提示条，也没有点穿到客服按钮');
    assert.equal(await text(pageId, '#noise-chat-reply'), '');
    assert.equal((await noiseState(space)).cookie_accepted, false);

    // 规则：命中 Cookie 提示条就点“接受”
    const calls: string[] = [];
    const infos: { op: string; attempt: number; hit: string }[] = [];
    const handler = rules(pageId, calls);
    await ok(
      { op: 'click', pageId, target: btn('在线客服'), post: [{ text_present: '客服暂未上线' }] },
      {
        onObscured: async (info) => {
          infos.push({ op: info.op, attempt: info.attempt, hit: info.hit });
          return handler(info);
        },
      },
    );
    assert.deepEqual(calls, ['cookie']);
    assert.equal(infos.length, 1);
    assert.deepEqual([infos[0]?.op, infos[0]?.attempt], ['click', 1]);
    assert.match(infos[0]?.hit ?? '', /noise-cookie/);
    await ok({
      op: 'assert',
      pageId,
      checks: [{ element_absent: { role: 'region', name: 'Cookie 提示' } }],
    });
    assert.deepEqual((await hooks(pageId)).clicks, ['cookie-accept', 'chat']);
    assert.equal((await noiseState(space)).cookie_accepted, true);
    assert.equal((await noiseState('b-cookie-other')).cookie_accepted, false, '按空间记住');
    await run({ op: 'close_page', pageId });

    // 同一空间再次打开：不再有提示条，客服按钮直接可点
    const again = await open(space, '/noise?mask=0&shift=0');
    assert.equal(await count(again, '#noise-cookie'), 0);
    const ob2 = await obs(again);
    assert.equal(find(ob2, 'button', '接受'), undefined);
    assert.equal(find(ob2, 'button', '在线客服')?.clickable, true);
    const direct: string[] = [];
    await ok(
      {
        op: 'click',
        pageId: again,
        target: btn('在线客服'),
        post: [{ text_present: '客服暂未上线' }],
      },
      { onObscured: rules(again, direct) },
    );
    assert.deepEqual(direct, [], '没有遮挡，规则没有被触发');
    await run({ op: 'close_page', pageId: again });
  });

  test('Cookie 提示条：不带处理规则也能绕开——“提交”按钮不在提示条下面，可以直接完成表单', async () => {
    const space = 'b-cookie-form';
    const pageId = await open(space, '/noise?mask=0&shift=0');
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '张三' });
    await ok({
      op: 'click',
      pageId,
      target: btn('提交'),
      post: [{ text_present: '提交成功' }],
    });
    const s = await noiseState(space);
    assert.equal(s.form_submits, 1);
    assert.deepEqual(s.names, ['张三']);
    assert.equal(s.cookie_accepted, false, '没有碰提示条');
    assert.deepEqual((await hooks(pageId)).clicks, ['submit']);
    await run({ op: 'close_page', pageId });
  });

  // ---- 二、透明遮挡层 ----

  test('透明遮挡层：期间“提交”被盖住，报 obscured，不点到遮挡层，也不点穿到按钮；输入框不受影响', async () => {
    const space = 'b-mask';
    const pageId = await open(space, '/noise?cookie=0&shift=0&mask_ms=60000');
    const ob = await obs(pageId);
    assert.equal(find(ob, 'button', '提交')?.clickable, false, '“提交”被透明层盖住');
    assert.equal(find(ob, 'textbox', '姓名')?.clickable, true);

    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '李四' });
    await obscured({ op: 'click', pageId, target: btn('提交') }, /noise-blocker/);
    await obscured({ op: 'click', pageId, target: { css: '#noise-submit' } }, /noise-blocker/);
    assert.deepEqual((await hooks(pageId)).clicks, [], '遮挡层没有收到点击，按钮也没有');
    assert.equal(await text(pageId, '#noise-status'), '');
    assert.equal((await noiseState(space)).form_submits, 0);
    await run({ op: 'close_page', pageId });
  });

  test('透明遮挡层：默认前 1.5 秒；等它消失（规则里条件等待）后点击成功，点击记录里没有遮挡层', async () => {
    const space = 'b-mask-wait';
    const pageId = await open(space, '/noise?cookie=0&shift=0');
    const calls: string[] = [];
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '王五' });
    // 点击可能赶在遮挡层消失前（规则等它消失后重试）或之后（直接成功）：两种结果都必须点在按钮上
    await ok(
      { op: 'click', pageId, target: btn('提交'), post: [{ text_present: '提交成功' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.ok(
      calls.every((c) => c === 'blocker'),
      `只有遮挡层规则会触发：${calls.join()}`,
    );
    const h = await hooks(pageId);
    assert.deepEqual(h.clicks, ['submit'], '没有点到遮挡层');
    assert.ok(h.maskStartedAt !== null && h.maskRemovedAt !== null, '遮挡层已移除');
    const lasted = (h.maskRemovedAt as number) - (h.maskStartedAt as number);
    assert.ok(lasted >= 1450, `遮挡层持续约 1.5 秒：${lasted}`);
    assert.equal(await count(pageId, '#noise-blocker'), 0);
    const s = await noiseState(space);
    assert.equal(s.form_submits, 1);
    assert.deepEqual(s.names, ['王五']);
    await run({ op: 'close_page', pageId });
  });

  test('透明遮挡层：消失后“提交”恢复可点（observe 的 clickable 随之变化）', async () => {
    const pageId = await open('b-mask-observe', '/noise?cookie=0&shift=0&mask_ms=800');
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ element_absent: { css: '#noise-blocker' } }],
      timeout_ms: 5000,
    });
    assert.equal(find(await obs(pageId), 'button', '提交')?.clickable, true);
    await run({ op: 'close_page', pageId });
  });

  // ---- 三、布局偏移 ----

  test('布局偏移：横幅插在表单上方，把“提交”往下推；observe 的包围盒随之变化', async () => {
    const pageId = await open('b-shift', '/noise?cookie=0&mask=0&shift=hover');
    assert.equal(await count(pageId, '#noise-promo'), 0, 'hover 模式下鼠标没到之前不偏移');
    const box = async () => {
      const el = find(await obs(pageId), 'button', '提交');
      assert.ok(el, 'observe 里有“提交”');
      return el.bbox as number[];
    };
    const before = await box();
    const formTopBefore = (await rectOf(pageId, '#noise-form')).top;

    const moved = await evaluate(pageId, () =>
      (window as unknown as { __noise: { shift(): boolean } }).__noise.shift(),
    );
    assert.equal(moved, true);
    await ok({ op: 'wait_for', pageId, until: [{ element_present: { css: '#noise-promo' } }] });
    const after = await box();
    const dy = (after[1] as number) - (before[1] as number);
    assert.ok(dy >= 40, `按钮被往下推了 ${dy} 像素`);
    assert.equal(after[0], before[0], '水平位置不变');
    const promo = await rectOf(pageId, '#noise-promo');
    const form = await rectOf(pageId, '#noise-form');
    assert.ok(promo.bottom <= form.top + 1, '横幅在表单上方');
    assert.ok(
      Math.abs(form.top - formTopBefore - promo.height - 12) <= 1,
      '表单被推下去一个横幅的高度',
    );
    assert.equal(
      await evaluate(pageId, () =>
        (window as unknown as { __noise: { shift(): boolean } }).__noise.shift(),
      ),
      false,
      '只偏移一次',
    );
    assert.equal(await count(pageId, '#noise-promo'), 1);
    await run({ op: 'close_page', pageId });
  });

  test('布局偏移：默认加载后约 300 毫秒发生；无论点击赶在偏移之前还是之后，落点都是“提交”，不会点到横幅或其他控件', async () => {
    const space = 'b-shift-timer';
    const pageId = await open(space, '/noise?cookie=0&mask=0');
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '赵六' });
    await ok({ op: 'click', pageId, target: btn('提交'), post: [{ text_present: '提交成功' }] });
    assert.deepEqual(
      (await hooks(pageId)).clicks,
      ['submit'],
      '只点了“提交”，没有点到横幅或其他控件',
    );
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ expr: 'document.getElementById("noise-promo") !== null' }],
      timeout_ms: 5000,
    });
    const h = await hooks(pageId);
    const delay = (h.shiftedAt as number) - (h.loadedAt as number);
    assert.ok(delay >= 290, `偏移发生在加载后约 300 毫秒：${delay}`);
    assert.equal((await noiseState(space)).form_submits, 1, '只提交了一次');
    await run({ op: 'close_page', pageId });
  });

  test('布局偏移：偏移恰好发生在“移动鼠标”与“按下”之间时，落点防护拦下误点、重试后点在“提交”上，只提交一次', async () => {
    const space = 'b-shift-hover';
    const pageId = await open(space, '/noise?cookie=0&mask=0&shift=hover');
    const infos: { attempt: number; hit: string }[] = [];
    await ok(
      { op: 'click', pageId, target: btn('提交'), post: [{ text_present: '提交成功' }] },
      {
        onObscured: (info) => {
          infos.push({ attempt: info.attempt, hit: info.hit });
          return false; // 偏移不是弹窗，没有可处理的东西；act 自己重试
        },
      },
    );
    // 鼠标一移上去页面就偏移了：派发前复核发现点击点上已经不是“提交”，通知了调用方，随后在新位置重试
    assert.ok(infos.length >= 1, '偏移被发现并通知了调用方');
    assert.equal(infos[0]?.attempt, 1);
    assert.doesNotMatch(infos[0]?.hit ?? '', /提交/);
    const h = await hooks(pageId);
    assert.deepEqual(h.clicks, ['submit'], '没有点到偏移后落在原位置上的控件');
    assert.ok(h.shiftedAt !== null, '页面确实偏移了');
    assert.equal(await text(pageId, '#noise-status'), '提交成功');
    assert.equal((await noiseState(space)).form_submits, 1);
    await run({ op: 'close_page', pageId });
  });

  // ---- 四、Entry Ad（BW-7） ----

  test('Entry Ad：约 500 毫秒后出现；observe 能识别“关闭”为可点击按钮；广告没关时点页面按钮报 obscured', async () => {
    const space = 'b-entry';
    const pageId = await open(space, '/noise/entry-ad');
    await waitAd(pageId);
    const a = await adHooks(pageId);
    assert.ok(a.shownAt !== null);
    assert.ok(
      a.shownAt - a.scheduledAt >= 450,
      `广告层延迟约 500 毫秒：${a.shownAt - a.scheduledAt}`,
    );

    const ob = await obs(pageId);
    const close = find(ob, 'button', '关闭');
    assert.ok(close, 'observe 里有“关闭”按钮');
    assert.equal(close.clickable, true);
    assert.ok(close.actions.includes('click'));
    assert.equal(close.visible_ratio, 1);
    assert.equal(find(ob, 'link', '立即领取')?.clickable, true, '广告里的链接也可点');
    assert.equal(find(ob, 'button', '继续阅读')?.clickable, false, '页面按钮被广告层盖住');
    assert.equal(find(ob, 'link', '重新加载本页')?.clickable, false);

    await obscured({ op: 'click', pageId, target: btn('继续阅读') }, /noise-ad/);
    assert.deepEqual((await adHooks(pageId)).clicks, [], '没有点到广告层的任何部分');
    assert.equal(await text(pageId, '#entry-result'), '');
    await run({ op: 'close_page', pageId });
  });

  test('Entry Ad：规则点“关闭”后重试成功；关闭记账；每次加载都再弹', async () => {
    const space = 'b-entry-rule';
    const pageId = await open(space, '/noise/entry-ad');
    await waitAd(pageId);
    const calls: string[] = [];
    await ok(
      { op: 'click', pageId, target: btn('继续阅读'), post: [{ text_present: '已继续阅读' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.deepEqual(calls, ['ad']);
    assert.equal(await count(pageId, '#noise-ad'), 0, '广告层已移除');
    assert.deepEqual((await adHooks(pageId)).clicks, ['ad-close']);
    let s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.entry_ad_loads, s.ad_dismissed], [1, 1, 1, true]);
    await run({ op: 'close_page', pageId });

    // 第二次加载：Entry Ad 仍然弹出（不受“已关闭”影响）
    const again = await open(space, '/noise/entry-ad');
    await waitAd(again);
    s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.entry_ad_loads], [2, 1, 2]);
    // 用“重新加载本页”链接再来一次也一样；先关掉广告才点得到链接
    await obscured(
      { op: 'click', pageId: again, target: { role: 'link', name: '重新加载本页' } },
      /noise-ad/,
    );
    await ok(
      {
        op: 'click',
        pageId: again,
        target: { role: 'link', name: '重新加载本页' },
        post: [{ url_matches: '/noise/entry-ad$' }],
      },
      { onObscured: rules(again, []) },
    );
    await waitAd(again);
    s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.entry_ad_loads], [3, 2, 3]);
    await run({ op: 'close_page', pageId: again });
  });

  // ---- 五、随机弹窗（popup_rate） ----

  test('popup_rate=1：任意 Lab 页面都弹广告；规则关闭后继续完成动作；第二次访问不再弹', async () => {
    const space = 'b-popup';
    await control(lab, space).faults({ popup_rate: 1 });
    const pageId = await open(space, '/other');
    await waitAd(pageId);
    const ob = await obs(pageId);
    const close = find(ob, 'button', '关闭');
    assert.equal(close?.clickable, true, 'observe 把广告层的“关闭”识别为可点击按钮');
    assert.equal(find(ob, 'button', '继续')?.clickable, false, '页面按钮被盖住');

    const calls: string[] = [];
    const first = await ok(
      { op: 'click', pageId, target: btn('继续'), post: [{ text_present: '已继续' }] },
      { onObscured: rules(pageId, calls) },
    );
    assert.equal(first.status, 'ok');
    assert.deepEqual(calls, ['ad']);
    let s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.ad_dismissed], [1, 1, true]);
    await run({ op: 'close_page', pageId });

    // 第二次访问（popup_rate 仍是 1）：页面里根本没有广告层，直接就能点
    const again = await open(space, '/other');
    assert.equal(await count(again, '#noise-ad'), 0, '同一空间关闭后不再弹');
    assert.equal(find(await obs(again), 'button', '继续')?.clickable, true);
    const spy: string[] = [];
    await ok(
      { op: 'click', pageId: again, target: btn('继续'), post: [{ text_present: '已继续' }] },
      { onObscured: rules(again, spy) },
    );
    assert.deepEqual(spy, []);
    for (const path of ['/', '/noise?cookie=0']) {
      const p = await open(space, path);
      assert.equal(await count(p, '#noise-ad'), 0, `${path} 也不再弹`);
      await run({ op: 'close_page', pageId: p });
    }
    s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed], [1, 1]);
    await run({ op: 'close_page', pageId: again });
  });

  test('popup_rate=1：弹窗出现在别的页面上同样挡住按钮；不处理时报 obscured，点击记录里没有广告层', async () => {
    const space = 'b-popup-block';
    await control(lab, space).faults({ popup_rate: 1 });
    const pageId = await open(space, '/noise?cookie=0&mask=0&shift=0');
    await waitAd(pageId);
    await obscured({ op: 'click', pageId, target: btn('提交') }, /noise-ad/);
    await obscured(
      { op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: 'x' },
      /noise-ad/,
    );
    assert.deepEqual((await hooks(pageId)).clicks, []);
    assert.equal(await text(pageId, '#noise-status'), '');
    const s = await noiseState(space);
    assert.deepEqual([s.ad_shown, s.ad_closed, s.form_submits], [1, 0, 0]);
    await run({ op: 'close_page', pageId });
  });

  // ---- 六、表单与综合 ----

  test('表单：填写姓名并提交，显示“提交成功”；可以再提交一次（新的幂等键）', async () => {
    const space = 'b-form';
    const pageId = await open(space, '/noise?cookie=0&mask=0&shift=0');
    for (const name of ['甲', '乙']) {
      await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: name });
      await ok({
        op: 'click',
        pageId,
        target: btn('提交'),
        post: [{ text_present: '提交成功' }],
      });
      await ok({
        op: 'wait_for',
        pageId,
        until: [{ expr: 'document.getElementById("noise-submit").disabled === false' }],
      });
      // 把提示清掉，下一轮才能确认是新的“提交成功”
      await evaluate(pageId, () => {
        (document.getElementById('noise-status') as HTMLElement).textContent = '';
      });
    }
    const s = await control(lab, space).state();
    assert.equal((s.modules.noise as NoiseData).form_submits, 2);
    assert.deepEqual((s.modules.noise as NoiseData).names, ['甲', '乙']);
    assert.equal(s.submissions.length, 2, '两次提交用了两个幂等键');
    assert.ok(s.submissions.every((x) => x.count === 1));
    await run({ op: 'close_page', pageId });
  });

  test('表单：接口返回 500 时页面提示失败、不显示“提交成功”；恢复后再点成功，只落库一次', async () => {
    const space = 'b-form-500';
    const c = control(lab, space);
    await c.faults({ error_rate: 1 });
    const pageId = await open(space, '/noise?cookie=0&mask=0&shift=0');
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '丙' });
    await ok({
      op: 'click',
      pageId,
      target: btn('提交'),
      post: [{ text_present: '提交失败（500）' }],
    });
    assert.equal((await noiseState(space)).form_submits, 0);
    await c.faults({ error_rate: 0 });
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ expr: 'document.getElementById("noise-submit").disabled === false' }],
    });
    await ok({ op: 'click', pageId, target: btn('提交'), post: [{ text_present: '提交成功' }] });
    const s = await noiseState(space);
    assert.equal(s.form_submits, 1);
    assert.deepEqual(s.names, ['丙']);
    await run({ op: 'close_page', pageId });
  });

  test('所有干扰叠在一起（popup_rate=1 + Cookie 提示条 + 遮挡层 + 偏移）：规则处理后完成提交，只提交一次，不点到任何遮挡物', async () => {
    const space = 'b-combo';
    await control(lab, space).faults({ popup_rate: 1 });
    const pageId = await open(space, '/noise');
    const calls: string[] = [];
    const onObscured = rules(pageId, calls);
    await ok(
      { op: 'click', pageId, target: btn('在线客服'), post: [{ text_present: '客服暂未上线' }] },
      { onObscured },
    );
    await ok(
      { op: 'fill', pageId, target: { role: 'textbox', name: '姓名' }, value: '丁' },
      { onObscured },
    );
    await ok(
      { op: 'click', pageId, target: btn('提交'), post: [{ text_present: '提交成功' }] },
      { onObscured },
    );
    assert.ok(calls.includes('cookie'), `Cookie 提示条被处理：${calls.join()}`);
    assert.ok(calls.includes('ad'), `广告被处理：${calls.join()}`);

    const h = await hooks(pageId);
    const allowed = ['ad-close', 'cookie-accept', 'chat', 'name', 'submit'];
    assert.deepEqual(
      h.clicks.filter((c) => !allowed.includes(c)),
      [],
      `点到了遮挡物：${h.clicks.join()}`,
    );
    assert.equal(h.clicks.filter((c) => c === 'submit').length, 1);
    assert.equal(h.clicks.filter((c) => c === 'ad-close').length, 1);
    assert.equal(h.clicks.filter((c) => c === 'cookie-accept').length, 1);
    assert.equal(h.clicks.filter((c) => c === 'chat').length, 1);
    assert.deepEqual((await adHooks(pageId)).clicks, ['ad-close'], '广告层里只点了“关闭”');

    const s = await control(lab, space).state();
    const n = s.modules.noise as NoiseData;
    assert.equal(n.form_submits, 1);
    assert.deepEqual(n.names, ['丁']);
    assert.equal(n.ad_closed, 1);
    assert.equal(n.cookie_accepted, true);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.submissions[0]?.count, 1, '没有重复提交');
    await run({ op: 'close_page', pageId });
  });
});
