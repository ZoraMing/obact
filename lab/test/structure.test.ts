// Lab 模块“复杂结构”（PRD 9.3；FR-04、FR-06、FR-07）：
//   /structure：同源与跨域 iframe、嵌套 frame、开放与封闭 Shadow DOM、新标签页、同名按钮、动态 id 与哈希类名；
//   /structure/library：Shoelace 组件库（Web Components，带 Shadow DOM）实现的差旅申请流程。
// 第一组只测静态资源防目录穿越；第二组在浏览器里用 observe / act 操作并和服务端提交记录对账。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { generateLocator } from '@obact/core';
import type { Locator, ObservedElement, ObserveResult } from '@obact/schemas';
import { createLab, type Lab } from '../src/app.ts';
import { ROWS } from '../src/modules/structure/data.ts';
import { shoelaceRoot } from '../src/modules/structure/vendor.ts';
import structure from '../src/modules/structure.ts';
import { control, type LabEnv, SKIP, setup } from './helpers.ts';

describe('复杂结构：组件库静态资源防目录穿越', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [structure] });
  });
  after(async () => {
    await lab?.close();
  });

  /** 原样发送路径（fetch 会先规范化 %2e%2e，测不到服务端对编码后斜杠的处理）。 */
  const rawGet = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(lab.base);
      request({ host: u.hostname, port: u.port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
        .on('error', reject)
        .end();
    });

  test('目录穿越读不到包外文件（tst-4：靶子文件必须真实存在，否则不论有没有防护都是 404）', async () => {
    const root = shoelaceRoot();
    assert.ok(root, '需要先 npm install 装好 @shoelace-style/shoelace');
    const base = '/s/st-vendor/structure/vendor/shoelace';
    // 正向对照：合法文件能读到，下面的非 200 才说明是防护挡住的，而不是路由坏了
    assert.equal((await rawGet(`${base}/custom-elements.json`)).status, 200);
    for (const a of ['..%2fpackage.json', '%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json']) {
      assert.ok(existsSync(resolve(root, decodeURIComponent(a))), `${a} 的靶子文件应真实存在`);
      const r = await rawGet(`${base}/${a}`);
      assert.notEqual(r.status, 200, a);
      assert.doesNotMatch(r.body, /"name"\s*:/, `${a} 不应泄露文件内容`);
    }
  });
});

/** 各 iframe 的 frame 链特征（observe 的 frame 字段）。 */
const SAME = /^iframe(#same-frame|\[id="same-frame"\])$/;
const CROSS = /^iframe(#cross-frame|\[id="cross-frame"\])$/;
const NESTED = [
  /^iframe(#nested-frame|\[id="nested-frame"\])$/,
  /^iframe(#inner-frame|\[id="inner-frame"\])$/,
];

describe('复杂结构：页面（浏览器 + observe/act）', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [structure] });
  });
  after(async () => {
    await env?.close();
  });
  afterEach(() => env.closePages());

  const page = (pageId: string) => env.session.pages.get(pageId);
  /** 某空间里指定操作的提交记录（页面事件上报、组件库提交都记在这里）。 */
  const subs = async (space: string, op: string) =>
    (await control(env.lab, space).state()).submissions.filter((x) => x.op === op);
  /** 条件等待（轮询到条件成立或超时），不用固定延时。 */
  async function until(fn: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) assert.fail(`等待超时：${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** 点击并等到页面出现某段文字（可选）。 */
  const click = (pageId: string, target: Locator | { ref: number }, text?: string) =>
    env.ok({ op: 'click', pageId, target, ...(text ? { post: [{ text_present: text }] } : {}) });
  /** 按名称与 frame 链找元素；frame 为 null 表示顶层文档。 */
  function find(ob: ObserveResult, name: string, frame: RegExp[] | null = null): ObservedElement {
    const e = ob.elements.find((x) => {
      const chain = x.frame ?? [];
      if (x.name !== name) return false;
      if (!frame) return chain.length === 0;
      return chain.length === frame.length && frame.every((re, i) => re.test(chain[i] as string));
    });
    assert.ok(e, `找不到 ${name}（frame ${frame?.map(String).join(' > ') ?? '顶层'}）`);
    return e;
  }
  const locatorOf = async (pageId: string, e: ObservedElement): Promise<Locator> => {
    const g = await generateLocator(env.session, pageId, e.ref);
    assert.ok(g.unique, `${e.name} 的定位器应唯一：${JSON.stringify(g.locator)}`);
    return g.locator;
  };

  test('同源、跨域与嵌套 iframe：按编号和持久定位器填写、点击，效果显示在顶层并记入提交记录', async () => {
    const space = 'st-frames';
    const pageId = await env.open(space, '/structure');
    const ob = await env.look(pageId);
    const [same, cross, nested] = [[SAME], [CROSS], NESTED].map((chain) => find(ob, '提交', chain));
    assert.equal(new Set([same, cross, nested].map((e) => e?.ref)).size, 3, '同名按钮编号各不相同');

    // 跨域 iframe 是同一服务的另一个主机名
    const crossFrame = page(pageId)
      .frames()
      .find((f) => f.url().includes('who=cross'));
    const host = (u?: string) => new URL(u ?? 'http://x').hostname;
    assert.notEqual(host(crossFrame?.url()), host(page(pageId).url()));

    await click(pageId, { ref: same?.ref as number }, '同源框架提交 1 次');
    // 跨域：按编号填写，再用带 frame 链的持久定位器点击
    const email = { ref: find(ob, '邮箱', [CROSS]).ref };
    await env.ok({ op: 'fill', pageId, target: email, value: 'a@x.cn' });
    const crossLoc = await locatorOf(pageId, cross as ObservedElement);
    assert.equal(crossLoc.frame?.length, 1);
    const r = await click(pageId, crossLoc, '跨域框架提交 1 次（a@x.cn）');
    assert.notEqual(r.locator_used, 'ref');
    // 嵌套：同源外层 → 跨域内层，frame 链两级，定位器可重放
    const nestedLoc = await locatorOf(pageId, nested as ObservedElement);
    assert.equal(nestedLoc.frame?.length, 2);
    await click(pageId, nestedLoc, '嵌套框架提交 1 次');
    await click(pageId, nestedLoc, '嵌套框架提交 2 次');

    const who = async () =>
      (await subs(space, 'event:frame_submit')).map((s) => (s.payload as { who: string }).who);
    await until(async () => (await who()).length === 4, '记到 4 次提交');
    assert.deepEqual((await who()).sort(), ['cross', 'nested', 'nested', 'same']);
  });

  test('Shadow DOM：开放、嵌套开放与封闭里的元素按编号和定位器都能操作（obs-8：封闭的也能生成定位器）', async () => {
    const space = 'st-shadow';
    const pageId = await env.open(space, '/structure');
    const ob = await env.look(pageId);
    assert.equal(find(ob, '金额').role, 'textbox', '封闭 Shadow DOM 里的输入框');
    await click(pageId, { ref: find(ob, '关注').ref }, '已关注');
    await click(pageId, await locatorOf(pageId, find(ob, '收藏')), '已收藏');
    await env.ok({ op: 'fill', pageId, target: { ref: find(ob, '金额').ref }, value: '88' });
    await click(pageId, await locatorOf(pageId, find(ob, '支付')), '已支付 88 元');
    await until(async () => (await subs(space, 'event:pay')).length === 1, '记到支付');
  });

  test('新标签页（target=_blank 链接与 window.open）：出现在 effects.new_pages，select_page 后可以 observe 与操作', async () => {
    for (const [name, from] of [
      ['在新标签页打开报表', 'link'],
      ['弹出窗口', 'open'],
    ] as const) {
      const space = `st-tab-${from}`;
      const pageId = await env.open(space, '/structure');
      const r = await click(pageId, { ref: find(await env.look(pageId), name).ref });
      assert.equal(r.effects.new_pages.length, 1, JSON.stringify(r.effects));
      const popupId = r.effects.new_pages[0] as string;
      await env.ok({ op: 'select_page', pageId: popupId });
      const popup = await env.look(popupId);
      assert.match(popup.url, new RegExp(`/s/${space}/structure/report\\?from=${from}$`));
      await click(popupId, { ref: find(popup, '确认收到').ref }, `已确认（来自 ${from}）`);
      const acks = async () => (await subs(space, 'event:report_ack')).length;
      await until(async () => (await acks()) === 1, '记到“确认收到”');
    }
  });

  test('同名按钮与动态 id：每行一个“查看”，定位器带 within 且不含动态值；重载后同一个定位器仍点中同一行', async () => {
    const pageId = await env.open('st-rows', '/structure');
    const views = (await env.look(pageId)).elements.filter((e) => e.name === '查看');
    assert.equal(views.length, ROWS.length);
    const locs = new Map<string, Locator>();
    for (const e of views) {
      const loc = await locatorOf(pageId, e);
      const text = JSON.stringify(loc);
      assert.match(loc.within ?? '', /^tr\[data-row-key='HT-240[1-6]'\]$/, text);
      assert.equal(e.within, loc.within, 'observe 给出的 within 与定位器一致');
      assert.equal(loc.css, undefined, `行内按钮只有动态属性，不给 CSS：${text}`);
      assert.doesNotMatch(text, /(css|sc|v|row|tbl)-[a-z0-9]{6}\b/, `定位器含动态值：${text}`);
      locs.set(/HT-\d+/.exec(loc.within ?? '')?.[0] as string, loc);
    }
    // 不带 within 的同名定位器有歧义：报 not_unique，不会随便点一个
    const amb = await env.run({ op: 'click', pageId, target: { role: 'button', name: '查看' } });
    assert.equal(amb.error?.code, 'not_unique');

    // 重载后 id 与类名都变了，旧定位器照样点中对应行
    const rowId = () => page(pageId).evaluate(() => document.querySelector('tbody tr')?.id);
    for (const id of ['HT-2403', 'HT-2405']) {
      const before = await rowId();
      await env.ok({ op: 'navigate_page', pageId, type: 'reload' });
      assert.notEqual(await rowId(), before, '每次加载 id 都变');
      await click(pageId, locs.get(id) as Locator, `查看 ${id}`);
    }
  });

  test('页面事件上报遇到服务端 500 会用同一个键重试，不是只试一次（lab-4）', async () => {
    const c = control(env.lab, 'st-retry');
    const pageId = await env.open('st-retry', '/structure');
    await c.faults({ error_rate: 1 });
    const view = { role: 'button', name: '查看', within: "tr[data-row-key='HT-2401']" };
    await click(pageId, view);
    // error_rate=1 时每次上报都是 500：重试的次数体现在日志里的 fault_500 条数
    await until(
      async () => (await c.state()).log.filter((x) => x.type === 'fault_500').length >= 3,
      '第一次上报之后又重试了两次',
    );
  });

  test('组件库页面：完整表单流程（只用 observe / act），结果与提交记录一致', async () => {
    const space = 'st-lib-flow';
    const pageId = await env.open(space, '/structure/library');
    await page(pageId).waitForFunction(() => document.body.dataset.slReady === '1', {
      timeout: 20_000,
    });
    const pick = async (role: string, name: string) => {
      const ob = await env.look(pageId);
      const e = ob.elements.find((x) => x.role === role && x.name === name);
      assert.ok(
        e,
        `找不到 ${role} “${name}”；现有：${ob.elements.map((x) => `${x.role}:${x.name}`)}`,
      );
      return e;
    };
    const press = async (role: string, name: string, text?: string) =>
      click(pageId, { ref: (await pick(role, name)).ref }, text);
    const fill = async (name: string, value: string) =>
      env.ok({ op: 'fill', pageId, target: { ref: (await pick('textbox', name)).ref }, value });

    // 1 填写：sl-button 的名称来自插槽里的文本（con-5）
    await fill('姓名', '张三');
    await fill('邮箱', 'zs@example.com');
    await press('button', '下一步');

    // 2 选择：sl-select 是 combobox + option；组件内部的重复项被折叠，隐藏的取值输入不列出（obs-6、aria-hidden）
    await env.ok({
      op: 'wait_for',
      pageId,
      until: [{ element_present: { role: 'combobox', name: '目的地城市' } }],
    });
    await press('combobox', '目的地城市');
    await press('option', '上海');
    const ob = await env.look(pageId);
    assert.equal(ob.elements.find((e) => e.role === 'combobox')?.value, '上海');
    const roles = (name: string) => ob.elements.filter((e) => e.name === name).map((e) => e.role);
    assert.deepEqual([roles('下一步'), roles('经济')], [['button'], ['radio']]);
    assert.equal(ob.elements.filter((e) => e.role === 'tab').length, 3);
    assert.deepEqual(
      ob.elements.filter((e) => e.role === 'textbox'),
      [],
      '没有隐藏输入',
    );
    await press('radio', '商务');
    await press('button', '下一步', '座位等级：商务');

    // 3 核对并勾选：摘要里是前面填的内容；同意之前提交按钮是禁用的
    await env.ok({
      op: 'wait_for',
      pageId,
      until: [{ text_present: '姓名：张三' }, { text_present: '目的地：上海' }],
    });
    const submit = (await env.look(pageId)).elements.find((e) => e.name === '提交申请');
    assert.equal(submit?.states?.disabled, true);
    await press('checkbox', '我已阅读并同意差旅规定');

    // 4 提交：先在确认对话框里取消，什么都不会提交；再提交一次，这次确认
    await press('button', '提交申请', '请核对申请信息');
    await press('button', '取消');
    await env.ok({ op: 'wait_for', pageId, until: [{ text_absent: '请核对申请信息' }] });
    assert.equal((await subs(space, 'library_submit')).length, 0, '取消后没有提交');
    await press('button', '提交申请', '请核对申请信息');
    await press('button', '确认提交', '申请已提交：编号 TR-0001（张三，上海，商务）');

    // 5 对账：服务端只有一份申请，字段与页面一致，幂等键只用了一次
    const s = await control(env.lab, space).state();
    assert.deepEqual((s.modules.structure as { applications: unknown[] }).applications, [
      { id: 'TR-0001', name: '张三', email: 'zs@example.com', city: 'shanghai', cabin: 'business' },
    ]);
    assert.deepEqual(
      s.submissions.filter((x) => x.op === 'library_submit').map((x) => x.count),
      [1],
    );
  });
});
