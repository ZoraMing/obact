// Lab 订单后台（PRD 9.3；FR-07、FR-09、FR-16 至 FR-19）：reset 订单数量（BW-9）、审核接口与幂等键、
// 批量审核页面、提交超时但已落库（C-4 的前提）、故障下的提交提示、列表翻页不改 URL、改版变体。
// 只装配 auth 与 orders 两个模块。
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Action, ActResult } from '@obact/schemas';
import { createLab, type Lab } from '../src/app.ts';
import auth from '../src/modules/auth.ts';
import type { Order } from '../src/modules/orders/data.ts';
import orders from '../src/modules/orders.ts';
import { control, type LabEnv, type LabState, SKIP, setup } from './helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type OrdersState = { total: number; counts: Record<string, number>; changed_ids: string[] };
const ordersOf = (s: LabState): OrdersState => s.modules.orders as OrdersState;
const approveSubs = (s: LabState) => s.submissions.filter((x) => x.op === 'approve');
const sorted = (a: readonly string[]) => [...a].sort();

/** 登录并返回会话 cookie（"lab_session=…"）。 */
async function loginCookie(lab: Lab, space: string): Promise<string> {
  const r = await fetch(`${lab.url(space)}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=alice123',
    redirect: 'manual',
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^lab_session=/, `登录失败：HTTP ${r.status}`);
  return cookie;
}

/** 带登录态的接口调用。 */
function apiOf(lab: Lab, space: string, cookie: string) {
  return {
    /** 订单列表（默认第 1 页每页 20 条）；query 如 'page_size=500'。 */
    async list(query = ''): Promise<Order[]> {
      const r = await fetch(`${lab.url(space)}/api/orders?${query}`, { headers: { cookie } });
      assert.equal(r.status, 200, `GET /api/orders?${query}`);
      return ((await r.json()) as { items: Order[] }).items;
    },
    async approve(body: unknown) {
      const r = await fetch(`${lab.url(space)}/api/orders/approve`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await r.json()) as {
        key: string | null;
        approved: number;
        approved_ids: string[];
        skipped: { id: string; reason: string }[];
      };
    },
  };
}

/** 取前 n 条待审核的订单号。 */
const firstPending = (items: readonly Order[], n: number): string[] => {
  const ids = items.filter((o) => o.status === '待审核').map((o) => o.id);
  assert.ok(ids.length >= n, `当前页待审核订单不足 ${n} 条`);
  return ids.slice(0, n);
};

describe('订单后台：数据与接口', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
  });

  test('reset 可指定订单数量（lab-11）：BW-9 要逐条审核 500 条，1000 条里待审核足够；越界和未知参数回 400', async () => {
    const c = control(lab, 'ord-size');
    const reset = (body: unknown) =>
      fetch(`${lab.url('ord-size')}/_lab/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal(ordersOf(await c.state()).total, 200, '不带参数时仍是 200 条');
    assert.equal((await reset({ orders: 1000 })).status, 200);
    const st = await c.state();
    assert.deepEqual(st.options, { orders: 1000 });
    assert.equal(ordersOf(st).total, 1000);
    assert.ok((ordersOf(st).counts.待审核 as number) >= 500, '待审核不够逐条审核 500 条');
    for (const body of [{ orders: 0 }, { orders: 2001 }, { orders: 1.5 }, { order: 10 }]) {
      assert.equal((await reset(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(ordersOf(await c.state()).total, 1000, '被拒绝的请求没有重置空间');
    await reset({});
    assert.equal(ordersOf(await c.state()).total, 200, '不带参数的 reset 回到默认');
  });

  test('审核接口（FR-16~18）：只有待审核会变更；同一个幂等键再次提交只计数、不重复改数据', async () => {
    const c = control(lab, 'ord-approve-api');
    const api = apiOf(lab, 'ord-approve-api', await loginCookie(lab, 'ord-approve-api'));
    const all = await api.list('page_size=500');
    const pend = all.filter((o) => o.status === '待审核').map((o) => o.id);
    const done = all.find((o) => o.status === '已审核')?.id as string;
    const rej = all.find((o) => o.status === '已驳回')?.id as string;
    const changed = async () => ordersOf(await c.state()).changed_ids;

    // 混合：待审核 2 条 + 已审核 + 已驳回 + 不存在 + 重复的订单号
    const r1 = await api.approve({
      ids: [pend[0], pend[1], done, rej, '00000', pend[0]],
      key: 'k-1',
    });
    assert.deepEqual(r1.approved_ids, [pend[0], pend[1]]);
    assert.deepEqual(r1.skipped, [
      { id: done, reason: 'already_approved' },
      { id: rej, reason: 'rejected' },
      { id: '00000', reason: 'not_found' },
    ]);
    assert.deepEqual(await changed(), [pend[0], pend[1]]);

    // 同一个键再来一次：数据不再改，原样返回首次结果；不同的键、没有键（服务端生成 auto-N）各算一次
    assert.deepEqual(await api.approve({ ids: [pend[2]], key: 'k-1' }), { ...r1, duplicate: true });
    assert.deepEqual(await changed(), [pend[0], pend[1]], 'pend[2] 没有被审核');
    assert.equal((await api.approve({ ids: [pend[2]], key: 'k-2' })).approved, 1);
    assert.equal((await api.approve({ ids: [pend[3]] })).key, null);
    const subs = approveSubs(await c.state());
    assert.deepEqual(
      subs.map((x) => x.count),
      [2, 1, 1],
    );
    assert.ok(subs[2]?.key.startsWith('auto-'));
  });
});

describe('订单后台：页面', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [auth, orders] });
  });
  after(async () => {
    await env?.close();
  });
  afterEach(() => env.closePages());

  const bodyText = (pageId: string) =>
    env.session.pages.get(pageId).evaluate(() => document.body.innerText);

  /** 登录（HTTP）、把会话 cookie 交给浏览器、打开订单列表，等到列表加载完。 */
  async function openOrders(space: string, redesign = 0) {
    const cookie = await loginCookie(env.lab, space);
    const [name, value] = cookie.split('=') as [string, string];
    await env.browser.setCookie({
      name,
      value,
      domain: '127.0.0.1',
      path: `/s/${space}/`,
      httpOnly: true,
    });
    const c = control(env.lab, space);
    if (redesign) await c.faults({ redesign });
    const pageId = await env.open(space, '/orders');
    await env.ok({ op: 'wait_for', pageId, until: [{ text_present: '共 200 条' }] });
    return { pageId, page: env.session.pages.get(pageId), c, api: apiOf(env.lab, space, cookie) };
  }

  /** 页面上当前显示的订单号（表格行或卡片）。 */
  const shownIds = (pageId: string) =>
    env.session.pages.get(pageId).evaluate(() => {
      const rows = document.querySelectorAll('tr[data-id], li[data-id]');
      return [...rows].map((e) => e.getAttribute('data-id'));
    });

  /** 勾选这些订单（按角色 + 名称）。 */
  async function check(pageId: string, ids: readonly string[]) {
    for (const id of ids) {
      await env.ok({ op: 'click', pageId, target: { role: 'checkbox', name: `选择订单 ${id}` } });
    }
  }

  /** 点“批量审核”并处理 confirm 对话框；accept 为 false 时取消。 */
  async function batch(
    pageId: string,
    opts: { name?: string; message: string; accept?: boolean; post?: string; timeout_ms?: number },
  ): Promise<ActResult> {
    const click = await env.ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: opts.name ?? '批量审核' },
    });
    assert.deepEqual(click.effects.dialogs, [
      { type: 'confirm', message: opts.message, handled: 'pending' },
    ]);
    const a: Action = {
      op: 'handle_dialog',
      pageId,
      action: opts.accept === false ? 'dismiss' : 'accept',
    };
    if (opts.post) a.post = [{ text_present: opts.post }];
    return env.run(a);
  }
  const three = '确认批量审核选中的 3 条订单？';

  test('批量审核（FR-16、FR-17）：取消不提交，确认后落库一次、幂等键计数为 1、其余订单不变', async () => {
    const { pageId, page, c, api } = await openOrders('ord-ui-approve');
    const before = await api.list('page_size=500');
    const pendTotal = ordersOf(await c.state()).counts.待审核 as number;

    await env.ok({
      op: 'fill',
      pageId,
      target: { role: 'combobox', name: '状态' },
      value: '待审核',
    });
    await env.ok({ op: 'click', pageId, target: { role: 'button', name: '查询' } });
    await env.ok({ op: 'wait_for', pageId, until: [{ text_present: `共 ${pendTotal} 条` }] });
    const pick = firstPending(await api.list('status=待审核'), 3);
    const disabled = () => page.$eval('#btn-batch', (e) => (e as HTMLButtonElement).disabled);
    assert.equal(await disabled(), true, '没有勾选时按钮不可用');
    await check(pageId, pick);
    assert.ok((await bodyText(pageId)).includes('已选 3 条'));

    // 取消：不提交，勾选还在；确认：提交一次
    await batch(pageId, { message: three, accept: false });
    assert.equal((await c.state()).submissions.length, 0, '取消不提交');
    assert.ok((await bodyText(pageId)).includes('已选 3 条'), '取消后勾选还在');
    await batch(pageId, { message: three, post: '已审核 3 条' });
    const s = await c.state();
    assert.equal(ordersOf(s).counts.待审核, pendTotal - 3);
    assert.deepEqual(sorted(ordersOf(s).changed_ids), sorted(pick));
    const subs = approveSubs(s);
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.count, 1, '幂等键计数为 1');
    assert.match(subs[0]?.key ?? '', UUID, '页面用 crypto.randomUUID() 生成幂等键');
    const payload = subs[0]?.payload as { ids: string[] };
    assert.deepEqual(sorted(payload.ids), sorted(pick));
    // 其余订单没有被改动；选择清零，按钮回到不可用
    const rest = (os: Order[]) => os.filter((o) => !pick.includes(o.id));
    assert.deepEqual(rest(await api.list('page_size=500')), rest(before));
    assert.ok((await bodyText(pageId)).includes('已选 0 条'));
    assert.equal(await disabled(), true);
  });

  test('提交超时但已落库（C-4、FR-18）：页面提示状态未明，重试沿用同一个幂等键，服务端只计数、不重复落库', async () => {
    const { pageId, page, c, api } = await openOrders('ord-ui-retry');
    const pick = firstPending(await api.list(), 3);
    await check(pageId, pick);
    // 把提交的等待上限缩短到 1.2 秒（默认 15 秒），让“状态未明”很快出现
    await page.evaluate(() => {
      (
        window as unknown as { __ORDERS__: { submit_timeout_ms: number } }
      ).__ORDERS__.submit_timeout_ms = 1200;
    });
    await c.faults({ commit_timeout: true });
    await batch(pageId, { message: three });
    await env.ok({
      op: 'wait_for',
      pageId,
      until: [{ text_present: '提交状态未明' }],
      timeout_ms: 8000,
    });
    const s1 = await c.state();
    const key = approveSubs(s1)[0]?.key;
    assert.deepEqual(
      approveSubs(s1).map((x) => x.count),
      [1],
    );
    assert.deepEqual(sorted(ordersOf(s1).changed_ids), sorted(pick), '已经落库');
    assert.ok(s1.log.some((x) => x.type === 'fault_commit_timeout'));

    // 故障解除，点“重试提交”：同一个键再到达服务端，不再弹确认
    await c.faults({ commit_timeout: false });
    const retry = await env.ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '重试提交' },
      post: [{ text_present: '已审核 3 条（此前的提交已生效，本次没有重复处理）' }],
    });
    assert.equal(retry.effects.dialogs.length, 0, '重试是同一次操作，不再弹确认');
    const s2 = await c.state();
    assert.deepEqual(
      approveSubs(s2).map((x) => [x.key, x.count]),
      [[key, 2]],
      '同一个键被提交了 2 次',
    );
    assert.deepEqual(sorted(ordersOf(s2).changed_ids), sorted(pick), '数据没有被重复修改');

    // 成功之后的下一次操作换新键
    await check(pageId, firstPending(await api.list(), 1));
    await batch(pageId, { message: '确认批量审核选中的 1 条订单？', post: '已审核 1 条' });
    const subs = approveSubs(await c.state());
    assert.equal(subs.length, 2);
    assert.notEqual(subs[1]?.key, key);
  });

  test('偶发 500（TS-07）：页面给出可见的失败提示，落库之前失败，点“重试提交”后成功', async () => {
    const { pageId, c, api } = await openOrders('ord-ui-error');
    const pick = firstPending(await api.list(), 2);
    await check(pageId, pick);
    await c.faults({ error_rate: 1 });
    await batch(pageId, {
      message: '确认批量审核选中的 2 条订单？',
      post: '提交失败：服务器返回 500',
    });
    assert.deepEqual(ordersOf(await c.state()).changed_ids, [], '500 发生在落库之前');
    await c.faults({ error_rate: 0 });
    await env.ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '重试提交' },
      post: [{ text_present: '已审核 2 条' }],
    });
    const s = await c.state();
    assert.deepEqual(sorted(ordersOf(s).changed_ids), sorted(pick));
    assert.deepEqual(
      approveSubs(s).map((x) => x.count),
      [1],
    );
  });

  test('列表的排序与翻页都不改 URL，显示的订单与接口一致（FR-09）', async () => {
    const { pageId, page, api } = await openOrders('ord-ui-list');
    const url = page.url();
    const ids = async (query: string) => (await api.list(query)).map((o) => o.id);
    assert.deepEqual(await shownIds(pageId), await ids(''));
    await env.ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
    assert.deepEqual(await shownIds(pageId), await ids('sort=amount&dir=asc'));
    await env.ok({ op: 'click', pageId, target: { role: 'button', name: '下一页' } });
    assert.deepEqual(await shownIds(pageId), await ids('sort=amount&dir=asc&page=2'));
    assert.equal(page.url(), url);
  });

  // 每个变体只改一个方面，4 起三项叠加：旧定位器失效，按角色 + 名称仍可用，批量审核照常
  const four = '确认审核所选的 3 条订单吗？';
  const VARIANTS: { batch: string; message: string; css?: string; name?: string; cards?: true }[] =
    [
      { batch: '批量审核', message: three, css: '#btn-batch' }, // 1 改 id 与类名
      { batch: '审核所选', message: four, name: '批量审核' }, // 2 改按钮文案
      { batch: '批量审核', message: three, cards: true }, // 3 改层级：表格改卡片
      { batch: '审核所选', message: four, css: '#btn-batch', name: '批量审核', cards: true }, // 4 全面改版
    ];
  for (const [i, v] of VARIANTS.entries()) {
    test(`改版变体 ${i + 1}（FR-07）：旧定位器失效，角色 + 名称仍可用，批量审核照常`, async () => {
      const { pageId, page, c, api } = await openOrders(`ord-ui-redesign-${i + 1}`, i + 1);
      assert.equal((await page.$('table')) === null, !!v.cards, '卡片列表没有表格');
      assert.deepEqual(
        await shownIds(pageId),
        (await api.list()).map((o) => o.id),
      );
      for (const target of [v.css && { css: v.css }, v.name && { role: 'button', name: v.name }]) {
        if (!target) continue;
        const r = await env.run({ op: 'click', pageId, target, timeout_ms: 500 });
        assert.equal(r.error?.code, 'not_found', JSON.stringify(target));
      }
      const pick = firstPending(await api.list(), 3);
      await check(pageId, pick);
      await batch(pageId, { name: v.batch, message: v.message, post: '已审核 3 条' });
      const s = await c.state();
      assert.deepEqual(sorted(ordersOf(s).changed_ids), sorted(pick));
      assert.deepEqual(
        approveSubs(s).map((x) => x.count),
        [1],
      );
    });
  }
});
