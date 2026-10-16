// Lab 模块“复杂结构”（PRD 9.3；FR-04、FR-06、FR-07）：
//   /structure：同源与跨域 iframe、嵌套 frame、开放与封闭 Shadow DOM、新标签页、同名按钮、动态 id 与哈希类名；
//   /structure/library：Shoelace 组件库（Web Components，带 Shadow DOM）实现的差旅申请流程。
// 第一组只测服务端（接口幂等、静态资源防目录穿越）；第二、三组在浏览器里用 observe / act 做完整操作并和服务端账本对账。
// 内核问题（Shoelace 的插槽名称、宿主元素落点判定、aria-hidden 隐藏输入）按正确行为断言，失败即内核待修，见各测试的注释。
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, observe } from '@obact/core';
import type { Action, ActResult, Locator, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { createLab, type Lab } from '../src/app.ts';
import { ROWS } from '../src/modules/structure/data.ts';
import { safeResolve, shoelaceRoot } from '../src/modules/structure/vendor.ts';
import structure from '../src/modules/structure.ts';
import { control, type LabEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();

type StructureState = {
  counts: Record<string, number>;
  views: string[];
  frames: Record<string, { count: number; email: string }>;
  events: { type: string; detail: Record<string, string> }[];
  applications: {
    id: string;
    name: string;
    email: string;
    city: string;
    transport: string;
    cabin: string;
    hotel: boolean;
    key: string;
  }[];
  loads: { index: number; library: number };
};

/** 条件等待（轮询到条件成立或超时），不用固定延时。 */
async function until<T>(
  fn: () => Promise<T | undefined | false | null>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------- 服务端

describe('复杂结构：服务端（接口、静态资源）', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [structure] });
  });
  after(async () => {
    await lab?.close();
  });

  const post = (space: string, path: string, body: unknown) =>
    fetch(`${lab.url(space)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const state = async (space: string) =>
    (await control(lab, space).state()).modules.structure as StructureState;
  /** 原样发送路径（fetch 会先规范化 %2e%2e，测不到服务端对编码后斜杠的处理）。 */
  const rawGet = (path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const u = new URL(lab.base);
      const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });

  test('模块信息：导航“复杂结构”指向 /structure，页面不需要登录，同名按钮的行带业务主键', async () => {
    assert.equal(structure.name, 'structure');
    assert.equal(structure.title, '复杂结构');
    assert.equal(structure.nav, '/structure');
    const r = await fetch(`${lab.url('st-meta')}/structure`, { redirect: 'manual' });
    assert.equal(r.status, 200, '不需要登录，不会被跳到登录页');
    const html = await r.text();
    assert.match(html, /<title>复杂结构 - Obact Lab<\/title>/);
    for (const row of ROWS) assert.match(html, new RegExp(`data-row-key="${row.id}"`));
    assert.equal(html.match(/>查看<\/button>/g)?.length, ROWS.length, '每行一个“查看”');
    const lib = await fetch(`${lab.url('st-meta')}/structure/library`, { redirect: 'manual' });
    assert.equal(lib.status, 200);
    assert.match(await lib.text(), /<sl-select/);
    const s = await state('st-meta');
    assert.deepEqual(s.loads, { index: 1, library: 1 });
  });

  test('init 不消耗随机序列：重置后的状态与初始一致', async () => {
    const c = control(lab, 'st-reset');
    const first = await state('st-reset');
    await post('st-reset', '/api/structure/event', { type: 'follow', key: 'k1' });
    assert.equal((await state('st-reset')).counts.follow, 1);
    await c.reset();
    assert.deepEqual(await state('st-reset'), first);
  });

  test('页面事件接口：同一个幂等键只计一次，非法类型与参数返回 400', async () => {
    const space = 'st-events';
    const a = await post(space, '/api/structure/event', {
      type: 'frame_submit',
      detail: { who: 'cross', email: 'a@x.cn' },
      key: 'ev-1',
    });
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { ok: true, duplicate: false });
    const b = await post(space, '/api/structure/event', {
      type: 'frame_submit',
      detail: { who: 'cross', email: 'a@x.cn' },
      key: 'ev-1',
    });
    assert.deepEqual(await b.json(), { ok: true, duplicate: true });
    await post(space, '/api/structure/event', {
      type: 'view',
      detail: { row: 'HT-2403' },
      key: 'ev-2',
    });
    await post(space, '/api/structure/event', {
      type: 'pay',
      detail: { amount: '88' },
      key: 'ev-3',
    });
    for (const bad of [
      { type: 'nope', key: 'x1' },
      { type: 'frame_submit', detail: { who: 'moon' }, key: 'x2' },
      { type: 'view', detail: { row: 'HT-0000' }, key: 'x3' },
    ]) {
      assert.equal(
        (await post(space, '/api/structure/event', bad)).status,
        400,
        JSON.stringify(bad),
      );
    }
    const s = await state(space);
    assert.equal(s.frames.cross?.count, 1);
    assert.equal(s.frames.cross?.email, 'a@x.cn');
    assert.deepEqual(s.views, ['HT-2403']);
    assert.equal(s.counts.pay, 1);
    const st = await control(lab, space).state();
    assert.equal(st.submissions.find((x) => x.key === 'ev-1')?.count, 2, '重复提交按幂等键计数');
    assert.equal(st.submissions.length, 3, '非法请求不进账本');
  });

  test('差旅申请接口：校验字段；同一个幂等键再次提交原样返回首次结果', async () => {
    const space = 'st-apply';
    const body = {
      name: '张三',
      email: 'zs@example.com',
      city: 'shanghai',
      transport: 'train',
      cabin: 'business',
      hotel: true,
      agree: true,
    };
    for (const bad of [
      { ...body, name: '  ' },
      { ...body, email: 'not-an-email' },
      { ...body, city: 'mars' },
      { ...body, transport: '' },
      { ...body, cabin: 'first' },
      { ...body, agree: false },
    ]) {
      const r = await post(space, '/api/structure/library/submit', { ...bad, key: 'bad' });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await state(space)).applications.length, 0, '被拒绝的申请不落库');
    const a = (await (
      await post(space, '/api/structure/library/submit', { ...body, key: 'k-1' })
    ).json()) as {
      id: string;
      duplicate?: boolean;
    };
    assert.equal(a.id, 'TR-0001');
    assert.equal(a.duplicate, undefined);
    const again = (await (
      await post(space, '/api/structure/library/submit', { ...body, key: 'k-1' })
    ).json()) as {
      id: string;
      duplicate?: boolean;
    };
    assert.equal(again.id, 'TR-0001');
    assert.equal(again.duplicate, true);
    const other = (await (
      await post(space, '/api/structure/library/submit', { ...body, key: 'k-2' })
    ).json()) as {
      id: string;
    };
    assert.equal(other.id, 'TR-0002');
    const s = await state(space);
    assert.equal(s.applications.length, 2, '同一个键只落库一次');
    assert.equal(s.applications[0]?.name, '张三');
    assert.equal(s.applications[0]?.hotel, true);
    const st = await control(lab, space).state();
    assert.equal(st.submissions.find((x) => x.key === 'k-1')?.count, 2);
  });

  test('组件库资源：按路径提供 js、css、svg；其他类型和不存在的文件 404', async () => {
    assert.ok(shoelaceRoot(), '已安装 @shoelace-style/shoelace');
    const base = '/s/st-vendor/structure/vendor/shoelace';
    const js = await rawGet(`${base}/shoelace.js`);
    assert.equal(js.status, 200);
    assert.match(js.type, /^text\/javascript/);
    assert.match(js.body, /import/);
    const css = await rawGet(`${base}/themes/light.css`);
    assert.equal(css.status, 200);
    assert.match(css.type, /^text\/css/);
    const deep = await rawGet(`${base}/components/button/button.js`);
    assert.equal(deep.status, 200, '三层目录');
    const svg = await rawGet(`${base}/assets/icons/chevron-down.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.type, /^image\/svg\+xml/);
    assert.equal((await rawGet(`${base}/shoelace.d.ts`)).status, 404, '只提供 js、css、svg、json');
    assert.equal((await rawGet(`${base}/no/such/file.js`)).status, 404);
    assert.equal((await rawGet(`${base}/components`)).status, 404, '目录不是文件');
  });

  test('组件库资源：目录穿越一律 404（编码斜杠、编码点、反斜杠、NUL）', async () => {
    const base = '/s/st-vendor/structure/vendor/shoelace';
    const attacks = [
      `${base}/..%2f..%2f..%2fpackage.json`,
      `${base}/..%2F..%2F..%2F..%2F..%2Fpackage.json`,
      `${base}/%2e%2e%2f%2e%2e%2fpackage.json`,
      `${base}/..%5c..%5cpackage.json`,
      `${base}/components/..%2f..%2f..%2fpackage.json`,
      `${base}/themes/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`,
      `${base}/shoelace.js%00.css`,
      `${base}/%2fetc%2fpasswd`,
    ];
    for (const path of attacks) {
      const r = await rawGet(path);
      assert.notEqual(r.status, 200, `${path} 不应读到文件`);
      assert.doesNotMatch(r.body, /"name"\s*:|root:/, `${path} 不应泄露文件内容`);
    }
    // 规范化后的点段落到别的路由，也读不到包外的文件
    const r = await rawGet(`${base}/../../../package.json`);
    assert.notEqual(r.status, 200);
    assert.doesNotMatch(r.body, /"workspaces"/);
  });

  test('safeResolve：只接受 root 之内的相对路径段', () => {
    const root = shoelaceRoot() as string;
    assert.ok(safeResolve(root, ['shoelace.js'])?.endsWith('shoelace.js'));
    assert.ok(safeResolve(root, ['themes', 'light.css'])?.includes('themes'));
    for (const segs of [
      [],
      [''],
      ['.'],
      ['..'],
      ['..', 'x'],
      ['a', '..', '..', 'x'],
      ['a/b'],
      ['..\\x'],
      ['a\0b'],
      ['/etc/passwd'],
    ]) {
      assert.equal(safeResolve(root, segs), null, JSON.stringify(segs));
    }
  });
});

// ---------------------------------------------------------------- /structure

/** 各 iframe 的 frame 链特征（observe 的 frame 字段）。 */
const FRAMES = {
  same: /^iframe(#same-frame|\[id="same-frame"\])$/,
  cross: /^iframe(#cross-frame|\[id="cross-frame"\])$/,
  shadow: /^iframe\[title="组件内框架"\]$/,
} as const;
const NESTED = [
  /^iframe(#nested-frame|\[id="nested-frame"\])$/,
  /^iframe(#inner-frame|\[id="inner-frame"\])$/,
];
/** 页面每次加载随机生成的 id 与类名（前缀-6 位含数字的哈希）。 */
const DYNAMIC = /^[a-z]+-(?=[a-z0-9]*\d)[a-z0-9]{6}$/;

describe('复杂结构 /structure（FR-04、FR-06、FR-07）', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function run(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const page = (pageId: string) => env.session.pages.get(pageId);
  const stateOf = async (space: string) =>
    (await control(env.lab, space).state()).modules.structure as StructureState;

  /**
   * 打开主页面并等到脚本就绪、四个 iframe 都加载完（条件等待）：
   * 各 frame 加载完会通知顶层，<html> 的 data-frames-ready 计数到 4 即全部就绪。
   */
  async function openMain(space: string, cross = false): Promise<string> {
    const pageId = await env.open(space, '/structure', { cross });
    const p = page(pageId);
    await p.waitForFunction(() => document.body.dataset.structureReady === '1');
    try {
      await p.waitForFunction(() => document.documentElement.dataset.framesReady === '4', {
        timeout: 20_000,
      });
    } catch (e) {
      const ready = await p.evaluate(
        () => (window as unknown as { __framesReady?: string[] }).__framesReady,
      );
      assert.fail(
        `四个框架没有都加载完：已就绪 ${JSON.stringify(ready)}；frames：${p
          .frames()
          .map((f) => f.url())
          .join(' | ')}；${(e as Error).message}`,
      );
    }
    return pageId;
  }
  /** 按名称与 frame 链找元素；frame 为 null 表示顶层文档。 */
  function find(ob: ObserveResult, name: string, frame: RegExp[] | null): ObservedElement {
    const e = ob.elements.find((x) => {
      if (x.name !== name) return false;
      const chain = x.frame ?? [];
      if (!frame) return chain.length === 0;
      return chain.length === frame.length && frame.every((re, i) => re.test(chain[i] as string));
    });
    assert.ok(e, `找不到 ${name}（frame ${frame?.map(String).join(' > ') ?? '顶层'}）`);
    return e;
  }
  /** 主文档里所有随每次加载变化的 id 与类名。 */
  const dynamicTokens = (pageId: string) =>
    page(pageId).evaluate((src) => {
      const re = new RegExp(src);
      const out = new Set<string>();
      for (const el of document.querySelectorAll('*')) {
        if (re.test(el.id)) out.add(el.id);
        for (const c of el.classList) if (re.test(c)) out.add(c);
      }
      return [...out].sort();
    }, DYNAMIC.source);
  const log = (pageId: string) =>
    page(pageId).evaluate(() => (window as unknown as { __log: string[] }).__log);

  test('observe 看到开放、嵌套、封闭 Shadow DOM 与各级 frame 里的元素，角色与可用操作正确', async () => {
    const pageId = await openMain('st-observe');
    const ob = await observe(env.session, { pageId });
    contracts.assert('observe.Result', ob);
    for (const name of ['关注', '收藏', '支付']) {
      const e = find(ob, name, null);
      assert.equal(e.role, 'button', name);
      assert.ok(e.actions.includes('click'), `${name}：${e.actions}`);
    }
    const amount = find(ob, '金额', null);
    assert.equal(amount.role, 'textbox', '封闭 Shadow DOM 里的输入框');
    assert.ok(amount.actions.includes('fill'));
    const outer = find(ob, '外层按钮', [NESTED[0] as RegExp]);
    assert.equal(outer.role, 'button');
    for (const chain of [[FRAMES.same], [FRAMES.cross], [FRAMES.shadow], NESTED]) {
      const submit = find(ob, '提交', chain);
      const email = find(ob, '邮箱', chain);
      assert.equal(submit.role, 'button');
      assert.equal(email.role, 'textbox');
      assert.equal(email.input_type, 'email');
      assert.ok(email.actions.includes('fill'), `${chain.map(String)} 内的邮箱框可填写`);
      assert.ok(submit.actions.includes('click'));
      assert.ok(ob.snapshot_text?.includes(`[${submit.ref}] button "提交"`));
    }
    for (const chain of [[FRAMES.same], [FRAMES.cross], NESTED]) {
      assert.ok(
        find(ob, '提交', chain).clickable,
        `${chain.map(String)} 内的提交按钮在视口内可点击`,
      );
    }
    const submits = ob.elements.filter((e) => e.name === '提交').map((e) => e.ref);
    assert.equal(new Set(submits).size, 4, '四个 frame 里的同名按钮编号各不相同');
    const link = ob.elements.find((e) => e.name === '在新标签页打开报表');
    assert.equal(link?.role, 'link');
    assert.match(link?.href ?? '', /\/s\/st-observe\/structure\/report\?from=link$/);
    assert.equal(ob.elements.filter((e) => e.name === '查看').length, ROWS.length);
    await run({ op: 'close_page', pageId });
  });

  test('同源与跨域 iframe：按编号和按定位器点击、填写，效果在顶层与服务端账本都可见', async () => {
    const space = 'st-xframe';
    const pageId = await openMain(space);
    const p = page(pageId);
    const ob = await observe(env.session, { pageId });

    // 跨域 iframe 的地址是同一服务的另一个主机名，路径同在本空间下
    const topHost = new URL(p.url()).hostname;
    const crossFrame = p.frames().find((f) => f.url().includes('who=cross'));
    assert.ok(crossFrame);
    const crossUrl = new URL(crossFrame.url());
    assert.notEqual(crossUrl.hostname, topHost, '跨域：主机名不同');
    assert.equal(crossUrl.port, new URL(p.url()).port);
    assert.equal(crossUrl.pathname, `/s/${space}/structure/frame`);

    // 跨域：按编号填写与点击
    await ok({
      op: 'fill',
      pageId,
      target: { ref: find(ob, '邮箱', [FRAMES.cross]).ref },
      value: 'a@x.cn',
    });
    const crossSubmit = find(ob, '提交', [FRAMES.cross]);
    await ok({
      op: 'click',
      pageId,
      target: { ref: crossSubmit.ref },
      post: [{ text_present: '跨域框架提交 1 次（a@x.cn）' }],
    });
    assert.equal(await crossFrame.$eval('#result', (e) => e.textContent), '已提交 1 次：a@x.cn');

    // 跨域：按持久定位器（带 frame 链）点击和填写
    const crossLoc = await generateLocator(env.session, pageId, crossSubmit.ref);
    assert.ok(crossLoc.unique, JSON.stringify(crossLoc.locator));
    assert.equal(crossLoc.locator.frame?.length, 1);
    const r = await ok({
      op: 'click',
      pageId,
      target: crossLoc.locator,
      post: [{ text_present: '跨域框架提交 2 次' }],
    });
    assert.notEqual(r.locator_used, 'ref');
    const crossEmail = await generateLocator(
      env.session,
      pageId,
      find(ob, '邮箱', [FRAMES.cross]).ref,
    );
    await ok({ op: 'fill', pageId, target: crossEmail.locator, value: 'b@x.cn' });
    await ok({
      op: 'click',
      pageId,
      target: crossLoc.locator,
      post: [{ text_present: '跨域框架提交 3 次（b@x.cn）' }],
    });

    // 同源 iframe
    await ok({
      op: 'click',
      pageId,
      target: { ref: find(ob, '提交', [FRAMES.same]).ref },
      post: [{ text_present: '同源框架提交 1 次' }],
    });

    // 服务端账本：各 frame 自己上报，计数与页面一致
    const s = await until(async () => {
      const st = await stateOf(space);
      return st.frames.cross?.count === 3 && st.frames.same?.count === 1 ? st : null;
    }, '账本里 cross 提交 3 次、same 提交 1 次');
    assert.equal(s.frames.cross?.email, 'b@x.cn');
    assert.equal(s.counts.frame_submit, 4);
    await run({ op: 'close_page', pageId });
  });

  test('从 localhost 站点打开时，跨域 iframe 指向 127.0.0.1，照样能操作', async () => {
    const space = 'st-xframe2';
    const pageId = await openMain(space, true);
    const p = page(pageId);
    assert.equal(new URL(p.url()).hostname, 'localhost');
    const crossFrame = p.frames().find((f) => f.url().includes('who=cross'));
    assert.equal(new URL(crossFrame?.url() ?? 'http://x').hostname, '127.0.0.1');
    const ob = await observe(env.session, { pageId });
    await ok({
      op: 'click',
      pageId,
      target: { ref: find(ob, '提交', [FRAMES.cross]).ref },
      post: [{ text_present: '跨域框架提交 1 次' }],
    });
    await until(
      async () => (await stateOf(space)).frames.cross?.count === 1,
      '账本记到 cross 提交',
    );
    await run({ op: 'close_page', pageId });
  });

  test('嵌套 frame（同源外层 → 跨域内层）与组件里的 iframe：frame 链两级，定位器可重放', async () => {
    const space = 'st-nested';
    const pageId = await openMain(space);
    const ob = await observe(env.session, { pageId });

    const nestedSubmit = find(ob, '提交', NESTED);
    await ok({
      op: 'click',
      pageId,
      target: { ref: nestedSubmit.ref },
      post: [{ text_present: '嵌套框架提交 1 次' }],
    });
    const nestedLoc = await generateLocator(env.session, pageId, nestedSubmit.ref);
    assert.ok(nestedLoc.unique, JSON.stringify(nestedLoc.locator));
    assert.equal(nestedLoc.locator.frame?.length, 2, '两级 frame 链');
    const nestedEmail = await generateLocator(env.session, pageId, find(ob, '邮箱', NESTED).ref);
    await ok({ op: 'fill', pageId, target: nestedEmail.locator, value: 'n@x.cn' });
    await ok({
      op: 'click',
      pageId,
      target: nestedLoc.locator,
      post: [{ text_present: '嵌套框架提交 2 次（n@x.cn）' }],
    });
    await ok({
      op: 'click',
      pageId,
      target: { ref: find(ob, '外层按钮', [NESTED[0] as RegExp]).ref },
      post: [{ text_present: '外层框架提交 1 次' }],
    });

    // Shadow Root 里的 iframe（组件内框架）
    const shadowSubmit = find(ob, '提交', [FRAMES.shadow]);
    const shadowLoc = await generateLocator(env.session, pageId, shadowSubmit.ref);
    assert.ok(shadowLoc.unique, JSON.stringify(shadowLoc.locator));
    await ok({
      op: 'click',
      pageId,
      target: shadowLoc.locator,
      post: [{ text_present: '组件内框架提交 1 次' }],
    });

    const s = await until(async () => {
      const st = await stateOf(space);
      return st.frames.nested?.count === 2 &&
        st.frames.shadow?.count === 1 &&
        st.counts.outer_button === 1
        ? st
        : null;
    }, '账本记到嵌套框架 2 次、组件内框架 1 次、外层按钮 1 次');
    assert.equal(s.frames.nested?.email, 'n@x.cn');
    await run({ op: 'close_page', pageId });
  });

  test('Shadow DOM：开放、嵌套、封闭的元素按编号和定位器都能操作，事件记入账本', async () => {
    const space = 'st-shadow';
    const pageId = await openMain(space);
    const ob = await observe(env.session, { pageId });
    await ok({ op: 'click', pageId, target: { ref: find(ob, '关注', null).ref } });
    const star = await generateLocator(env.session, pageId, find(ob, '收藏', null).ref);
    assert.ok(star.unique, `嵌套 Shadow 内的元素：${JSON.stringify(star.locator)}`);
    await ok({ op: 'click', pageId, target: star.locator });
    await ok({ op: 'fill', pageId, target: { ref: find(ob, '金额', null).ref }, value: '88' });
    const pay = await generateLocator(env.session, pageId, find(ob, '支付', null).ref);
    assert.ok(pay.unique, `封闭 Shadow 内的元素能生成唯一定位器：${JSON.stringify(pay.locator)}`);
    await ok({
      op: 'click',
      pageId,
      target: pay.locator,
      post: [{ text_present: '已支付 88 元' }],
    });
    assert.deepEqual(await log(pageId), ['已关注', '已收藏', '已支付 88 元']);
    const s = await until(async () => {
      const st = await stateOf(space);
      return st.counts.follow === 1 && st.counts.favorite === 1 && st.counts.pay === 1 ? st : null;
    }, '账本记到关注、收藏、支付');
    assert.deepEqual(s.events.find((e) => e.type === 'pay')?.detail, { amount: '88' });
    await run({ op: 'close_page', pageId });
  });

  for (const [how, name, from] of [
    ['target=_blank 链接', '在新标签页打开报表', 'link'],
    ['window.open', '弹出窗口', 'open'],
  ] as const) {
    test(`新标签页（${how}）：出现在 effects.new_pages，select_page 后可以 observe 与操作`, async () => {
      const space = `st-tab-${from}`;
      const pageId = await openMain(space);
      const ob = await observe(env.session, { pageId });
      const opener = ob.elements.find((e) => e.name === name);
      assert.ok(opener, name);
      const r = await ok({ op: 'click', pageId, target: { ref: opener.ref } });
      assert.equal(r.effects.new_pages.length, 1, JSON.stringify(r.effects));
      const popupId = r.effects.new_pages[0] as string;
      assert.ok(
        env.session.pages.list().some((p) => p.pageId === popupId),
        '新标签页已登记',
      );
      await ok({ op: 'wait_for', pageId: popupId, until: [{ text_present: `打开方式：${from}` }] });
      await ok({ op: 'select_page', pageId: popupId });
      const popup = await observe(env.session, { pageId: popupId });
      assert.match(popup.url, new RegExp(`/s/${space}/structure/report\\?from=${from}$`));
      assert.equal(popup.title, '报表（新标签页） - Obact Lab');
      const ack = popup.elements.find((e) => e.name === '确认收到');
      assert.ok(ack);
      await ok({
        op: 'click',
        pageId: popupId,
        target: { ref: ack.ref },
        post: [{ text_present: `已确认（来自 ${from}）` }],
      });
      // 编号属于各自的标签页：拿新标签页的编号去操作原页面要报错
      const wrong = await run({ op: 'click', pageId, target: { ref: ack.ref } });
      assert.equal(wrong.error?.code, 'invalid_params');
      const s = await until(async () => {
        const st = await stateOf(space);
        return st.counts.report_ack === 1 ? st : null;
      }, '账本记到“确认收到”');
      assert.deepEqual(s.events.find((e) => e.type === 'report_ack')?.detail, { from });
      assert.equal(s.counts.open_window, from === 'open' ? 1 : 0);
      await ok({ op: 'close_page', pageId: popupId });
      await ok({ op: 'select_page', pageId });
      await observe(env.session, { pageId });
      await run({ op: 'close_page', pageId });
    });
  }

  test('同名按钮：每行一个“查看”，定位器带 within（业务主键），按定位器点中对应行', async () => {
    const space = 'st-rows';
    const pageId = await openMain(space);
    const ob = await observe(env.session, { pageId });
    const views = ob.elements.filter((e) => e.name === '查看');
    assert.equal(views.length, ROWS.length);
    const seen = new Map<string, ObservedElement>();
    for (const e of views) {
      assert.equal(e.role, 'button');
      const { locator, unique } = await generateLocator(env.session, pageId, e.ref);
      const text = JSON.stringify(locator);
      assert.ok(unique, `应唯一：${text}`);
      assert.match(locator.within ?? '', /^tr\[data-row-key='HT-240[1-6]'\]$/, text);
      assert.equal(e.within, locator.within, 'observe 给出的 within 与定位器一致');
      assert.equal(locator.role, 'button');
      assert.equal(locator.name, '查看');
      assert.equal(locator.css, undefined, `行内按钮只有动态属性，不给 CSS：${text}`);
      seen.set(/HT-\d+/.exec(locator.within ?? '')?.[0] as string, e);
    }
    assert.deepEqual(
      [...seen.keys()].sort(),
      ROWS.map((r) => r.id),
    );

    // 不带 within 的同名定位器有歧义：报 not_unique，不会随便点一个
    const amb = await run({ op: 'click', pageId, target: { role: 'button', name: '查看' } });
    assert.equal(amb.status, 'error');
    assert.equal(amb.error?.code, 'not_unique');
    assert.deepEqual((await stateOf(space)).views, []);

    // 按 observe 生成的定位器点中对应行
    const loc = await generateLocator(
      env.session,
      pageId,
      (seen.get('HT-2403') as ObservedElement).ref,
    );
    await ok({
      op: 'click',
      pageId,
      target: loc.locator,
      post: [{ text_present: '正在查看：HT-2403 采购框架协议（负责人：张伟，金额 450,000 元）' }],
    });
    // 手写定位器：角色 + 名称 + within
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '查看', within: "tr[data-row-key='HT-2405']" },
      post: [{ text_present: '正在查看：HT-2405 软件许可补充协议' }],
    });
    // 编号也行
    await ok({
      op: 'click',
      pageId,
      target: { ref: (seen.get('HT-2401') as ObservedElement).ref },
    });
    const s = await until(async () => {
      const st = await stateOf(space);
      return st.views.length === 3 ? st : null;
    }, '账本记到三次查看');
    assert.deepEqual(s.views, ['HT-2403', 'HT-2405', 'HT-2401']);
    assert.equal(
      await page(pageId)
        .$$eval('tr.selected', (rows) => rows.map((r) => (r as HTMLElement).dataset.rowKey))
        .then((x) => x.join()),
      'HT-2401',
    );
    await run({ op: 'close_page', pageId });
  });

  test('动态 id 与哈希类名：每次加载都变；定位器不含动态值；重载后用同一个定位器点中同一个目标', async () => {
    const space = 'st-dyn';
    const a = await env.open(space, '/structure');
    const b = await env.open(space, '/structure');
    const ta = await dynamicTokens(a);
    const tb = await dynamicTokens(b);
    assert.ok(ta.length > 40, `动态 id 与类名共 ${ta.length} 个`);
    const shared = ta.filter((t) => tb.includes(t)).length;
    assert.ok(shared / ta.length < 0.1, `两次加载几乎没有重合（${shared}/${ta.length}）`);
    await run({ op: 'close_page', pageId: b });

    const pageId = a;
    await page(pageId).waitForFunction(() => document.body.dataset.structureReady === '1');
    const ob = await observe(env.session, { pageId });
    const locs = new Map<string, Locator>();
    for (const e of ob.elements.filter((x) => !x.frame?.length)) {
      const { locator, unique } = await generateLocator(env.session, pageId, e.ref);
      const text = JSON.stringify(locator);
      assert.ok(unique, `${e.name} 应唯一：${text}`);
      const leaked = ta.filter((t) => text.includes(t));
      assert.deepEqual(leaked, [], `${e.name} 的定位器含动态值：${text}`);
      assert.doesNotMatch(
        text,
        /(css|sc|btn|row|tbl|dyn|note|dst|log|status|detail)-[a-z0-9]{6}\b/,
        `${e.name}：${text}`,
      );
      locs.set(e.name + (e.within ?? ''), locator);
    }
    const draft = locs.get('保存草稿');
    const approve = locs.get('提交审批');
    const note = locs.get('备注');
    const view5 = locs.get("查看tr[data-row-key='HT-2405']");
    assert.ok(draft && approve && note && view5, '拿到了四个定位器');

    // 换 id、换类名之后重放
    let before = ta;
    let n = 0;
    for (const reload of [1, 2, 3]) {
      const nav = await ok({ op: 'navigate_page', pageId, type: 'reload' });
      assert.equal(nav.effects.navigated, true);
      await page(pageId).waitForFunction(() => document.body.dataset.structureReady === '1');
      const now = await dynamicTokens(pageId);
      assert.equal(
        now.filter((t) => before.includes(t)).length / now.length < 0.1,
        true,
        `第 ${reload} 次重载后 id 与类名都变了`,
      );
      before = now;
      await ok({ op: 'fill', pageId, target: note, value: `备注${reload}` });
      n++;
      await ok({
        op: 'click',
        pageId,
        target: draft,
        post: [{ text_present: `草稿已保存（第 1 次，备注：备注${reload}）` }],
      });
      await ok({
        op: 'click',
        pageId,
        target: approve,
        post: [{ text_present: '审批已提交（第 1 次' }],
      });
      await ok({
        op: 'click',
        pageId,
        target: view5,
        post: [{ text_present: '正在查看：HT-2405 软件许可补充协议' }],
      });
    }
    const s = await until(async () => {
      const st = await stateOf(space);
      return st.counts.draft === n && st.counts.approve === n && st.views.length === n ? st : null;
    }, '账本记到每次重载后的三个操作');
    assert.deepEqual(s.views, Array(n).fill('HT-2405'));
    assert.equal(s.events.filter((e) => e.type === 'draft').at(-1)?.detail.note, '备注3');
    await run({ op: 'close_page', pageId });
  });

  test('随机按 space.rng()：同一空间每次加载都变；重置后同样的访问次序得到同样的 id', async () => {
    const space = 'st-rng';
    const c = control(env.lab, space);
    const first = await env.open(space, '/structure');
    const t1 = await dynamicTokens(first);
    const second = await env.open(space, '/structure');
    const t2 = await dynamicTokens(second);
    assert.notDeepEqual(t2, t1, '同一空间连续两次加载，id 与类名不同');
    await c.reset();
    const again = await env.open(space, '/structure');
    assert.deepEqual(await dynamicTokens(again), t1, '重置后第一次加载与重置前的第一次相同');
    const other = await env.open('st-rng-other', '/structure');
    assert.notDeepEqual(await dynamicTokens(other), t1, '不同空间（不同种子）不同');
    for (const id of [first, second, again, other]) await run({ op: 'close_page', pageId: id });
  });
});

// ---------------------------------------------------------------- /structure/library（Shoelace）

describe('复杂结构 /structure/library：Shoelace 组件库（FR-04、FR-06、FR-07）', {
  skip: SKIP,
}, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function run(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const page = (pageId: string) => env.session.pages.get(pageId);
  const stateOf = async (space: string) =>
    (await control(env.lab, space).state()).modules.structure as StructureState;

  /** 打开组件库页面（可直接打开某一步），等组件全部定义并升级完成（条件等待）。 */
  async function openLibrary(space: string, tab?: 'info' | 'choose' | 'confirm'): Promise<string> {
    const pageId = await env.open(space, `/structure/library${tab ? `?tab=${tab}` : ''}`);
    await page(pageId).waitForFunction(() => document.body.dataset.slReady === '1', {
      timeout: 20_000,
    });
    return pageId;
  }
  const look = (pageId: string) => observe(env.session, { pageId });
  /** 按角色与名称找元素。 */
  function pick(ob: ObserveResult, role: string, name: string): ObservedElement {
    const e = ob.elements.find((x) => x.role === role && x.name === name);
    assert.ok(
      e,
      `找不到 ${role} “${name}”；现有：${ob.elements.map((x) => `${x.role}:${x.name}`).join('，')}`,
    );
    return e;
  }
  const byName = (ob: ObserveResult, name: string) => {
    const e = ob.elements.find((x) => x.name === name);
    assert.ok(e, `找不到 “${name}”`);
    return e;
  };

  test('observe 识别 Shoelace 的选项卡、输入框、单选组、下拉菜单：角色、名称、状态、可用操作', async () => {
    const pageId = await openLibrary('st-lib-roles', 'info');
    const ob = await look(pageId);
    contracts.assert('observe.Result', ob);
    // 选项卡：role 在宿主 sl-tab 上
    const tabs = ['填写信息', '选择行程', '核对信息'].map((n) => pick(ob, 'tab', n));
    assert.deepEqual(
      tabs.map((t) => t.states?.selected),
      [true, false, false],
    );
    // sl-input：输入框在 Shadow DOM 里，label 属性成了名称
    const name = pick(ob, 'textbox', '姓名');
    assert.ok(name.actions.includes('fill'));
    assert.equal(name.value, '');
    const email = pick(ob, 'textbox', '邮箱');
    assert.equal(email.input_type, 'email');
    // 没有显示的选项卡面板里的元素不出现
    assert.equal(
      ob.elements.find((e) => e.name === '目的地城市'),
      undefined,
    );
    assert.match(ob.text_md, /差旅申请（组件库）/);
    await run({ op: 'close_page', pageId });

    const choose = await openLibrary('st-lib-roles', 'choose');
    const cb = await look(choose);
    // sl-select 是 combobox：未展开时 expanded=false，可点击；选项在展开后才渲染
    const city = pick(cb, 'combobox', '目的地城市');
    assert.equal(city.states?.expanded, false);
    assert.ok(city.actions.includes('click'));
    assert.ok(city.clickable);
    assert.equal(
      cb.elements.filter((e) => e.role === 'option').length,
      0,
      '收起时选项不渲染，不应出现在元素列表里',
    );
    // sl-radio-group：每个 sl-radio 是 radio，默认选中“经济”
    assert.equal(pick(cb, 'radio', '经济').states?.checked, true);
    assert.equal(pick(cb, 'radio', '商务').states?.checked, false);
    await run({ op: 'close_page', pageId: choose });
  });

  test('sl-select 展开后：listbox 加 4 个 option（名称是城市），状态随选择更新', async () => {
    const pageId = await openLibrary('st-lib-select', 'choose');
    const ob = await look(pageId);
    // 不依赖角色：按名称找 sl-select 的 combobox
    const city = pick(ob, 'combobox', '目的地城市');
    await ok({ op: 'click', pageId, target: { ref: city.ref } });
    const open = await look(pageId);
    assert.equal(pick(open, 'combobox', '目的地城市').states?.expanded, true);
    pick(open, 'listbox', '目的地城市');
    const names = open.elements.filter((e) => e.role === 'option').map((e) => e.name);
    assert.deepEqual(names, ['北京', '上海', '深圳', '成都']);
    for (const o of open.elements.filter((e) => e.role === 'option')) {
      assert.ok(o.actions.includes('click'));
      assert.ok(o.clickable, `${o.name} 可点击`);
    }
    // 点选项（宿主 sl-option 带 role=option，点击落在它自己 Shadow DOM 的插槽上）
    await ok({ op: 'click', pageId, target: { ref: pick(open, 'option', '上海').ref } });
    const after = await look(pageId);
    const combo = pick(after, 'combobox', '目的地城市');
    assert.equal(combo.value, '上海');
    assert.equal(combo.states?.expanded, false);
    await run({ op: 'close_page', pageId });
  });

  test('sl-tab-group：按角色与名称点选项卡，面板随之切换', async () => {
    const pageId = await openLibrary('st-lib-tabs', 'info');
    await ok({
      op: 'click',
      pageId,
      target: { role: 'tab', name: '选择行程' },
      post: [{ element_present: { role: 'combobox', name: '目的地城市' } }],
    });
    const ob = await look(pageId);
    assert.equal(pick(ob, 'tab', '选择行程').states?.selected, true);
    assert.equal(pick(ob, 'tab', '填写信息').states?.selected, false);
    assert.equal(
      ob.elements.find((e) => e.name === '姓名'),
      undefined,
      '第一个面板已隐藏',
    );
    await ok({
      op: 'click',
      pageId,
      target: { role: 'tab', name: '核对信息' },
      post: [{ text_present: '预订酒店' }],
    });
    await run({ op: 'close_page', pageId });
  });

  test('sl-dropdown：点触发按钮展开菜单，菜单项是 menuitem，点选后页面更新', async () => {
    const space = 'st-lib-menu';
    const pageId = await openLibrary(space, 'choose');
    const ob = await look(pageId);
    // 触发器是 sl-button（宿主上有点击监听）；按名称找，不限角色
    await ok({ op: 'click', pageId, target: { ref: byName(ob, '出行方式').ref } });
    const open = await look(pageId);
    assert.deepEqual(
      open.elements.filter((e) => e.role === 'menuitem').map((e) => e.name),
      ['飞机', '高铁', '自驾'],
    );
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(open, 'menuitem', '高铁').ref },
      post: [
        { text_present: '已选：高铁' },
        { element_absent: { role: 'menuitem', name: '高铁' } },
      ],
    });
    const closed = await look(pageId);
    assert.equal(closed.elements.filter((e) => e.role === 'menuitem').length, 0, '选完后菜单收起');
    await run({ op: 'close_page', pageId });
  });

  test('sl-radio-group：点 sl-radio 切换选中项', async () => {
    const pageId = await openLibrary('st-lib-radio', 'choose');
    const ob = await look(pageId);
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'radio', '商务').ref } });
    const after = await look(pageId);
    assert.equal(pick(after, 'radio', '商务').states?.checked, true);
    assert.equal(pick(after, 'radio', '经济').states?.checked, false);
    // 按角色与名称的定位器点回“经济”
    await ok({ op: 'click', pageId, target: { role: 'radio', name: '经济' } });
    const back = await look(pageId);
    assert.equal(pick(back, 'radio', '经济').states?.checked, true);
    assert.equal(pick(back, 'radio', '商务').states?.checked, false);
    await run({ op: 'close_page', pageId });
  });

  test('sl-checkbox 与 sl-switch：角色、勾选状态随点击变化；勾选同意后才能提交（按钮禁用状态）', async () => {
    const pageId = await openLibrary('st-lib-check', 'confirm');
    const ob = await look(pageId);
    const checkbox = ob.elements.find((e) => e.role === 'checkbox');
    const sw = ob.elements.find((e) => e.role === 'switch');
    assert.ok(checkbox, 'sl-checkbox 是 checkbox');
    assert.ok(sw, 'sl-switch 是 switch');
    assert.equal(checkbox.states?.checked, false);
    assert.equal(sw.states?.checked, false);
    assert.ok(checkbox.actions.includes('click'));
    const submit = ob.elements.find((e) => e.role === 'button' && e.states?.disabled);
    assert.ok(submit, '未勾选同意时，提交按钮是禁用的');

    await ok({ op: 'click', pageId, target: { ref: checkbox.ref } });
    await ok({ op: 'click', pageId, target: { ref: sw.ref } });
    const after = await look(pageId);
    assert.equal(after.elements.find((e) => e.role === 'checkbox')?.states?.checked, true);
    assert.equal(after.elements.find((e) => e.role === 'switch')?.states?.checked, true);
    assert.equal(
      after.elements.filter((e) => e.role === 'button' && e.states?.disabled).length,
      0,
      '勾选后提交按钮可用',
    );
    // 再点一次取消勾选，按钮重新禁用
    await ok({
      op: 'click',
      pageId,
      target: { ref: (after.elements.find((e) => e.role === 'checkbox') as ObservedElement).ref },
    });
    const off = await look(pageId);
    assert.equal(off.elements.find((e) => e.role === 'checkbox')?.states?.checked, false);
    assert.equal(off.elements.filter((e) => e.role === 'button' && e.states?.disabled).length, 1);
    await run({ op: 'close_page', pageId });
  });

  test('页面信息：选项卡面板里的正文出现在 text_md 里（不被带点击监听的外层容器吞掉）', async () => {
    // sl-tab-group 内部有一个带点击监听的外层容器，observe 会把它列成可点击的 generic；
    // 修“插槽内容计入名称”时它的名称可能变成整块文本，obsText 会把面板正文当作它的名称而丢掉。
    const pageId = await openLibrary('st-lib-text', 'confirm');
    const ob = await look(pageId);
    for (const t of ['姓名：未填写', '目的地：未选择', '座位等级：经济', '预订酒店：不需要']) {
      assert.ok(ob.text_md.includes(t), `核对页摘要含“${t}”：${ob.text_md}`);
    }
    await run({ op: 'close_page', pageId });
  });

  test('名称来自插槽里的文本：sl-button、sl-checkbox、sl-switch 要有可访问名称（内核问题：插槽内容未计入名称）', async () => {
    // sl-button / sl-checkbox / sl-switch 的文字写在宿主的子节点里，由 <slot> 投影到 Shadow DOM 里的原生 button / input。
    // 可访问名称应取扁平树（assignedNodes）里的文本；否则 observe 给出 role=button name=""，定位器没法按名称写。
    const info = await openLibrary('st-lib-names', 'info');
    const a = await look(info);
    pick(a, 'button', '下一步');
    await run({ op: 'close_page', pageId: info });

    const choose = await openLibrary('st-lib-names', 'choose');
    const b = await look(choose);
    pick(b, 'button', '出行方式');
    assert.deepEqual(
      b.elements.filter((e) => e.role === 'button' && e.name === '').map((e) => e.ref),
      [],
      '没有名称为空的 button',
    );
    await run({ op: 'close_page', pageId: choose });

    const confirm = await openLibrary('st-lib-names', 'confirm');
    const c = await look(confirm);
    pick(c, 'checkbox', '我已阅读并同意差旅规定');
    pick(c, 'switch', '需要预订酒店');
    pick(c, 'button', '提交申请');
    await run({ op: 'close_page', pageId: confirm });
  });

  test('组件库内部重复项被折叠：每个控件只列一次（宿主与内部按钮、sl-tab 与内部 div、sl-radio 与标签文字）', async () => {
    const pageId = await openLibrary('st-lib-fold', 'choose');
    const ob = await look(pageId);
    const named = (name: string) => ob.elements.filter((e) => e.name === name);
    assert.deepEqual(
      named('下一步').map((e) => e.role),
      ['button'],
      '宿主 sl-button 带点击监听，不再另列一个 generic',
    );
    assert.deepEqual(
      named('出行方式').map((e) => e.role),
      ['button'],
    );
    assert.deepEqual(
      named('经济').map((e) => e.role),
      ['radio'],
      'sl-radio 内部的标签文字不再另列',
    );
    assert.equal(ob.elements.filter((e) => e.role === 'tab').length, 3, '三个选项卡，每个只列一次');
    const generic = ob.elements.filter((e) => e.role === 'generic');
    assert.ok(generic.length <= 1, `只允许剩下选项卡条这一个泛容器：${generic.map((e) => e.hint)}`);
    // 折叠不丢功能：对剩下的元素照样能操作
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'radio', '商务').ref } });
    await run({ op: 'close_page', pageId });
  });

  test('隐藏的表单值输入（aria-hidden）不出现在元素列表里（内核问题：aria-hidden 元素被当成 textbox）', async () => {
    // sl-select 为了表单提交，在 Shadow DOM 里放了一个 aria-hidden="true"、tabindex=-1 的文本输入，值是选项的 value（如 shanghai）。
    // 它不是给人用的控件，observe 不应把它当成名称为空的 textbox（还会泄露内部取值）。
    const pageId = await openLibrary('st-lib-hidden', 'choose');
    const ob = await look(pageId);
    assert.deepEqual(
      ob.elements.filter((e) => e.role === 'textbox').map((e) => `${e.name}=${e.value}`),
      [],
      '选择行程页没有任何真正的文本框',
    );
    await run({ op: 'close_page', pageId });
  });

  test('完整表单流程（只用 observe / act）：填写 → 选择 → 勾选 → 取消一次 → 确认提交 → 结果与账本一致', async () => {
    const space = 'st-lib-flow';
    const pageId = await openLibrary(space);
    let ob = await look(pageId);

    // 1 填写
    await ok({
      op: 'fill',
      pageId,
      target: { ref: pick(ob, 'textbox', '姓名').ref },
      value: '张三',
    });
    await ok({
      op: 'fill',
      pageId,
      target: { ref: pick(ob, 'textbox', '邮箱').ref },
      value: 'zs@example.com',
    });
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'button', '下一步').ref } });

    // 2 选择：下拉框、下拉菜单、单选
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ element_present: { role: 'combobox', name: '目的地城市' } }],
    });
    ob = await look(pageId);
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'combobox', '目的地城市').ref } });
    ob = await look(pageId);
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'option', '上海').ref } });
    ob = await look(pageId);
    assert.equal(pick(ob, 'combobox', '目的地城市').value, '上海');
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'button', '出行方式').ref } });
    ob = await look(pageId);
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'menuitem', '高铁').ref },
      post: [
        { text_present: '已选：高铁' },
        { element_absent: { role: 'menuitem', name: '高铁' } },
      ],
    });
    ob = await look(pageId);
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'radio', '商务').ref } });
    ob = await look(pageId);
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'button', '下一步').ref } });

    // 3 核对并勾选：摘要里是前面填的内容；同意之前提交按钮是禁用的
    await ok({
      op: 'wait_for',
      pageId,
      until: [
        { text_present: '姓名：张三' },
        { text_present: '邮箱：zs@example.com' },
        { text_present: '目的地：上海' },
        { text_present: '出行方式：高铁' },
        { text_present: '座位等级：商务' },
        { text_present: '预订酒店：不需要' },
      ],
    });
    ob = await look(pageId);
    assert.equal(pick(ob, 'button', '提交申请').states?.disabled, true);
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'checkbox', '我已阅读并同意差旅规定').ref },
    });
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'switch', '需要预订酒店').ref },
      post: [{ text_present: '预订酒店：需要' }],
    });
    ob = await look(pageId);
    assert.notEqual(pick(ob, 'button', '提交申请').states?.disabled, true, '同意后可提交');

    // 4 提交：先在确认对话框里取消，什么都不会提交
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'button', '提交申请').ref },
      post: [{ text_present: '请核对申请信息' }],
    });
    ob = await look(pageId);
    assert.match(ob.text_md, /确认提交申请/, '对话框标题在页面信息里');
    await ok({ op: 'click', pageId, target: { ref: pick(ob, 'button', '取消').ref } });
    await ok({ op: 'wait_for', pageId, until: [{ text_absent: '请核对申请信息' }] });
    assert.equal((await stateOf(space)).applications.length, 0, '取消后没有提交');
    await ok({ op: 'assert', pageId, checks: [{ text_present: '尚未提交' }] });

    // 再提交一次，这次确认
    ob = await look(pageId);
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'button', '提交申请').ref },
      post: [{ text_present: '请核对申请信息' }],
    });
    ob = await look(pageId);
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'button', '确认提交').ref },
      post: [{ text_present: '申请已提交：编号 TR-0001（张三，上海，高铁，商务，需要酒店）' }],
    });

    // 5 对账：服务端只有一份申请，字段与页面一致，幂等键只用了一次
    const s = await until(async () => {
      const st = await stateOf(space);
      return st.applications.length === 1 ? st : null;
    }, '账本记到一份申请');
    const { key, ...fields } = s.applications[0] as StructureState['applications'][number];
    assert.deepEqual(fields, {
      id: 'TR-0001',
      name: '张三',
      email: 'zs@example.com',
      city: 'shanghai',
      transport: 'train',
      cabin: 'business',
      hotel: true,
    });
    const st = await control(env.lab, space).state();
    const sub = st.submissions.filter((x) => x.op === 'library_submit');
    assert.equal(sub.length, 1);
    assert.equal(sub[0]?.key, key, '申请用的就是账本里记录的幂等键');
    assert.equal(sub[0]?.count, 1, '没有重复提交');
    await run({ op: 'close_page', pageId });
  });

  test('缺少必填项时提交会被拦住：提示缺什么，不弹确认对话框也不落库', async () => {
    const space = 'st-lib-missing';
    const pageId = await openLibrary(space, 'confirm');
    let ob = await look(pageId);
    const agree = ob.elements.find((e) => e.role === 'checkbox');
    assert.ok(agree);
    await ok({ op: 'click', pageId, target: { ref: agree.ref } });
    ob = await look(pageId);
    await ok({
      op: 'click',
      pageId,
      target: { ref: pick(ob, 'button', '提交申请').ref },
      post: [{ text_present: '请先填写：姓名、邮箱、目的地城市、出行方式' }],
    });
    assert.doesNotMatch((await look(pageId)).text_md, /请核对申请信息/);
    assert.deepEqual((await stateOf(space)).applications, []);
    await run({ op: 'close_page', pageId });
  });

  test('Shoelace 元素生成的定位器唯一，重新加载页面后重放同一条路径', async () => {
    const space = 'st-lib-replay';
    const pageId = await openLibrary(space, 'info');
    const ob = await look(pageId);
    const targets = [
      pick(ob, 'textbox', '姓名'),
      pick(ob, 'textbox', '邮箱'),
      pick(ob, 'tab', '选择行程'),
      pick(ob, 'button', '下一步'),
    ];
    const locs: Locator[] = [];
    for (const e of targets) {
      const { locator, unique } = await generateLocator(env.session, pageId, e.ref);
      assert.ok(unique, `${e.role} ${e.name} 应唯一：${JSON.stringify(locator)}`);
      locs.push(locator);
    }
    const [nameLoc, emailLoc, , nextLoc] = locs;
    for (const reload of ['A', 'B']) {
      await ok({ op: 'navigate_page', pageId, url: `${env.lab.url(space)}/structure/library` });
      await page(pageId).waitForFunction(() => document.body.dataset.slReady === '1', {
        timeout: 20_000,
      });
      await ok({ op: 'fill', pageId, target: nameLoc as Locator, value: `用户${reload}` });
      await ok({
        op: 'fill',
        pageId,
        target: emailLoc as Locator,
        value: `${reload.toLowerCase()}@example.com`,
      });
      await ok({
        op: 'click',
        pageId,
        target: nextLoc as Locator,
        post: [{ element_present: { role: 'combobox', name: '目的地城市' } }],
      });
      const now = await look(pageId);
      assert.equal(pick(now, 'tab', '选择行程').states?.selected, true);
    }
    await run({ op: 'close_page', pageId });
  });
});
