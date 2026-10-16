// Lab 订单后台模块（PRD 9.3）：接口、页面（筛选、排序、翻页不改 URL）、批量审核与幂等键、
// 提交超时但已落库（C-4 的前提）、导出、故障注入下的可见提示、改版变体。
// 只装配 auth 与 orders 两个模块：测试不受其他模块影响，也验证订单后台能和真实的登录模块一起工作。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, launchBrowser, observe, Session } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser } from 'puppeteer-core';
import { createLab, type Lab } from '../src/app.ts';
import type { Faults } from '../src/core.ts';
import auth from '../src/modules/auth.ts';
import { csvField, type Order, ordersCsv } from '../src/modules/orders/data.ts';
import orders from '../src/modules/orders.ts';
import { CHROME, control, type LabState, SKIP } from './helpers.ts';

const contracts = new Contracts();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type OrdersState = {
  total: number;
  counts: Record<string, number>;
  approved_ids: string[];
  changed_ids: string[];
  comments: Record<string, string>;
};
type ListBody = {
  total: number;
  page: number;
  page_size: number;
  pages: number;
  items: Order[];
};
type ApproveBody = {
  ok: true;
  key: string | null;
  approved: number;
  approved_ids: string[];
  skipped: { id: string; reason: string }[];
  duplicate?: boolean;
};

const ordersOf = (s: LabState): OrdersState => s.modules.orders as OrdersState;
const approveSubs = (s: LabState) => s.submissions.filter((x) => x.op === 'approve');
const sorted = (a: readonly string[]) => [...a].sort();

/** 登录并返回会话 cookie（"lab_session=…"）。表单字段 username 是 auth 模块的字段名，user 兼容旧写法。 */
async function loginCookie(lab: Lab, space: string): Promise<string> {
  const r = await fetch(`${lab.url(space)}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'alice',
      user: 'alice',
      password: 'alice123',
    }).toString(),
    redirect: 'manual',
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  assert.match(cookie, /^lab_session=/, `登录失败：HTTP ${r.status}`);
  return cookie;
}

/** 带登录态的接口调用。 */
function apiOf(lab: Lab, space: string, cookie: string) {
  const u = (p: string) => `${lab.url(space)}${p}`;
  return {
    url: u,
    get: (path: string) => fetch(u(path), { headers: { cookie } }),
    post: (path: string, body: unknown) =>
      fetch(u(path), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    async list(query = ''): Promise<ListBody> {
      const r = await fetch(u(`/api/orders?${query}`), { headers: { cookie } });
      assert.equal(r.status, 200, `GET /api/orders?${query}`);
      return (await r.json()) as ListBody;
    },
    /** 全部订单（按默认顺序）。 */
    async all(): Promise<Order[]> {
      return (await this.list('page_size=500')).items;
    },
  };
}

/** 最小的 RFC 4180 解析：逗号分隔、双引号包裹、引号写两次、CRLF 换行。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

/** 响应正文按 UTF-8 解码，保留开头的 BOM（Response.text() 会把 BOM 去掉）。 */
const csvText = async (r: Response): Promise<string> =>
  Buffer.from(await r.arrayBuffer()).toString('utf8');

/** 页面上显示的金额（千分位、两位小数）。 */
const fmtAmount = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Row = {
  id: string | null;
  customer: string;
  amount: string;
  status: string;
  region: string;
  created_at: string;
};
const expectedRows = (items: readonly Order[]): Row[] =>
  items.map((o) => ({
    id: o.id,
    customer: o.customer,
    amount: fmtAmount(o.amount),
    status: o.status,
    region: o.region,
    created_at: o.created_at,
  }));

// ---------------------------------------------------------------------------------------------
// 一、接口与数据（不需要浏览器）
// ---------------------------------------------------------------------------------------------

describe('订单后台：数据与接口', () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
  });
  after(async () => {
    await lab?.close();
  });

  test('init：200 条订单，订单号唯一且递增，三种状态都有；同名空间重置后数据相同，换种子则不同', async () => {
    const space = 'ord-init';
    const c = control(lab, space);
    const api = apiOf(lab, space, await loginCookie(lab, space));
    const first = await api.all();
    assert.equal(first.length, 200);
    assert.equal(new Set(first.map((o) => o.id)).size, 200, '订单号唯一');
    for (const o of first) {
      assert.match(o.id, /^\d{5}$/);
      assert.match(o.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      assert.ok(o.amount > 0 && Math.round(o.amount * 100) / 100 === o.amount, '金额最多两位小数');
      assert.ok(o.customer && o.region);
    }
    // 默认按下单时间倒序；订单号随下单时间递增，所以倒序时订单号递减
    const ids = first.map((o) => o.id);
    assert.deepEqual(ids, sorted(ids).reverse());
    const st = ordersOf(await c.state());
    assert.equal(st.total, 200);
    assert.deepEqual(Object.keys(st.counts), ['待审核', '已审核', '已驳回']);
    for (const n of Object.values(st.counts)) assert.ok(n > 0);
    assert.equal(
      Object.values(st.counts).reduce((a, b) => a + b, 0),
      200,
    );
    assert.deepEqual(
      st.approved_ids,
      sorted(first.filter((o) => o.status === '已审核').map((o) => o.id)),
    );
    assert.deepEqual(st.changed_ids, []);

    await c.reset();
    const again = apiOf(lab, space, await loginCookie(lab, space));
    assert.deepEqual(await again.all(), first, '同名空间重置后数据相同');
    await c.reset(42);
    const other = apiOf(lab, space, await loginCookie(lab, space));
    assert.notDeepEqual(
      (await other.all()).map((o) => o.id + o.amount),
      first.map((o) => o.id + o.amount),
      '换种子数据不同',
    );
  });

  test('未登录：接口 401，页面跳到登录页（登录后回到原页面）', async () => {
    const space = 'ord-noauth';
    for (const p of ['/api/orders', '/api/orders/export.csv', '/api/orders/88001']) {
      const r = await fetch(`${lab.url(space)}${p}`);
      assert.equal(r.status, 401, p);
    }
    const post = await fetch(`${lab.url(space)}/api/orders/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['88001'], key: 'k' }),
    });
    assert.equal(post.status, 401);
    for (const p of ['/orders', '/orders/88001']) {
      const r = await fetch(`${lab.url(space)}${p}`, { redirect: 'manual' });
      assert.equal(r.status, 303, p);
      assert.equal(r.headers.get('location'), `/s/${space}/login?next=${encodeURIComponent(p)}`);
    }
    const s = await control(lab, space).state();
    assert.equal(ordersOf(s).total, 200);
    assert.equal(s.submissions.length, 0, '未登录的提交不记录');
  });

  test('列表接口：状态与关键字筛选、六列排序（同值按订单号升序）、分页、参数校验', async () => {
    const space = 'ord-list';
    const api = apiOf(lab, space, await loginCookie(lab, space));
    const all = await api.all();

    // 状态筛选
    for (const status of ['待审核', '已审核', '已驳回']) {
      const r = await api.list(`status=${encodeURIComponent(status)}&page_size=500`);
      assert.deepEqual(
        r.items.map((o) => o.id),
        all.filter((o) => o.status === status).map((o) => o.id),
        status,
      );
      assert.equal(r.total, r.items.length);
    }
    assert.equal((await api.list('status=all')).total, 200, 'status=all 等于不筛选');

    // 关键字：订单号子串或客户名，不分大小写
    const byId = await api.list(`q=${all[7]?.id}&page_size=500`);
    assert.deepEqual(
      byId.items.map((o) => o.id),
      [all[7]?.id],
    );
    const orion = (await api.list('q=oRiOn&page_size=500')).items;
    assert.ok(orion.length > 0);
    assert.deepEqual(
      orion.map((o) => o.id),
      all.filter((o) => o.customer.toLowerCase().includes('orion')).map((o) => o.id),
    );
    assert.equal((await api.list('q=不存在的客户名zzz')).total, 0);
    const both = await api.list(`status=${encodeURIComponent('已审核')}&q=orion&page_size=500`);
    assert.deepEqual(
      both.items.map((o) => o.id),
      orion.filter((o) => o.status === '已审核').map((o) => o.id),
    );

    // 排序：六列、两个方向；键值相同的按订单号升序
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const rank = (s: string) => ['待审核', '已审核', '已驳回'].indexOf(s);
    const keyOf = {
      id: (o: Order) => o.id,
      customer: (o: Order) => o.customer,
      amount: (o: Order) => o.amount,
      status: (o: Order) => rank(o.status),
      region: (o: Order) => o.region,
      created_at: (o: Order) => o.created_at,
    } as const;
    for (const [sort, key] of Object.entries(keyOf)) {
      for (const dir of ['asc', 'desc'] as const) {
        const got = (await api.list(`sort=${sort}&dir=${dir}&page_size=500`)).items;
        const sign = dir === 'asc' ? 1 : -1;
        const want = [...all].sort((a, b) => {
          const ka = key(a);
          const kb = key(b);
          const c = typeof ka === 'number' ? ka - (kb as number) : cmp(ka, kb as string);
          return sign * c || cmp(a.id, b.id);
        });
        assert.deepEqual(
          got.map((o) => o.id),
          want.map((o) => o.id),
          `sort=${sort}&dir=${dir}`,
        );
      }
    }

    // 分页：默认每页 20 条；page_size；越界页为空；总页数
    const p1 = await api.list();
    assert.deepEqual(
      [p1.page, p1.page_size, p1.pages, p1.total, p1.items.length],
      [1, 20, 10, 200, 20],
    );
    const p3 = await api.list('page=3');
    assert.deepEqual(
      p3.items.map((o) => o.id),
      all.slice(40, 60).map((o) => o.id),
    );
    const sized = await api.list('page=2&page_size=15');
    assert.deepEqual(
      sized.items.map((o) => o.id),
      all.slice(15, 30).map((o) => o.id),
    );
    assert.equal(sized.pages, 14);
    const beyond = await api.list('page=11');
    assert.equal(beyond.items.length, 0);
    assert.equal(beyond.total, 200);
    assert.equal((await api.list('q=不存在的客户名zzz')).pages, 1);

    // 参数校验
    for (const bad of [
      'status=已删除',
      'sort=weight',
      'dir=up',
      'page=0',
      'page=abc',
      'page_size=0',
      'page_size=501',
    ]) {
      const r = await api.get(`/api/orders?${bad}`);
      assert.equal(r.status, 400, bad);
      assert.ok(((await r.json()) as { error: string }).error);
    }

    // 单条订单
    const one = await api.get(`/api/orders/${all[3]?.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), all[3]);
    assert.equal((await api.get('/api/orders/00000')).status, 404);
  });

  test('导出接口：与筛选一致，UTF-8 BOM、CRLF、attachment，含逗号与引号的客户名按 RFC 4180 转义', async () => {
    const space = 'ord-csv';
    const api = apiOf(lab, space, await loginCookie(lab, space));
    const query = `status=${encodeURIComponent('待审核')}&q=o&sort=amount&dir=desc`;
    const r = await api.get(`/api/orders/export.csv?${query}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(
      r.headers.get('content-disposition') ?? '',
      /^attachment; filename="orders\.csv"$/,
    );
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const body = buf.toString('utf8');
    assert.ok(body.endsWith('\r\n'));
    assert.ok(!body.slice(1).replace(/\r\n/g, '').includes('\n'), '只有 CRLF 换行');

    const rows = parseCsv(body.slice(1));
    assert.deepEqual(rows[0], ['订单号', '客户', '金额', '状态', '地区', '下单时间']);
    const want = (await api.list(`${query}&page_size=500`)).items;
    assert.ok(want.length > 5);
    assert.deepEqual(
      rows.slice(1),
      want.map((o) => [o.id, o.customer, o.amount.toFixed(2), o.status, o.region, o.created_at]),
    );
    assert.equal(body, ordersCsv(want), '与按同一条件取到的订单逐字节一致');
    assert.ok(rows.slice(1).every((x) => x[3] === '待审核'));
    const amounts = rows.slice(1).map((x) => Number(x[2]));
    assert.deepEqual(
      amounts,
      [...amounts].sort((a, b) => b - a),
      '按金额倒序',
    );

    // 全部订单：客户名里的逗号、引号被转义，解析后还原
    const full = await api.get('/api/orders/export.csv');
    const fullBody = Buffer.from(await full.arrayBuffer()).toString('utf8');
    assert.equal(parseCsv(fullBody.slice(1)).length, 201);
    assert.ok(fullBody.includes(csvField('Orion Trading, Ltd.')));
    assert.ok(fullBody.includes('"Orion Trading, Ltd."'));
    assert.ok(fullBody.includes('"老张""鲜果""批发部"'));

    assert.equal((await api.get('/api/orders/export.csv?status=已删除')).status, 400);
    const none = await api.get('/api/orders/export.csv?q=不存在的客户名zzz');
    assert.equal(parseCsv((await csvText(none)).slice(1)).length, 1, '没有数据时只有表头');
  });

  test('审核接口：只有待审核会变更；已审核、已驳回、不存在被跳过；同一个幂等键再次提交只计数、不重复改数据', async () => {
    const space = 'ord-approve-api';
    const c = control(lab, space);
    const api = apiOf(lab, space, await loginCookie(lab, space));
    const all = await api.all();
    const pend = all.filter((o) => o.status === '待审核').map((o) => o.id);
    const done = all.find((o) => o.status === '已审核')?.id as string;
    const rej = all.find((o) => o.status === '已驳回')?.id as string;
    const before = ordersOf(await c.state());

    const post = async (body: unknown) => {
      const r = await api.post('/api/orders/approve', body);
      return { status: r.status, body: (await r.json()) as ApproveBody & { error?: string } };
    };

    // 参数校验：不落库、不记录
    for (const bad of [
      {},
      { ids: [] },
      { ids: 'x' },
      { ids: [1] },
      { ids: [''] },
      { ids: ['1'], comment: 'x'.repeat(201) },
    ]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal((await c.state()).submissions.length, 0);

    // 混合：待审核 2 条 + 已审核 + 已驳回 + 不存在 + 重复的订单号
    const r1 = await post({
      ids: [pend[0], pend[1], done, rej, '00000', pend[0]],
      key: 'k-1',
      comment: '  资料齐全  ',
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.approved_ids, [pend[0], pend[1]]);
    assert.equal(r1.body.approved, 2);
    assert.deepEqual(r1.body.skipped, [
      { id: done, reason: 'already_approved' },
      { id: rej, reason: 'rejected' },
      { id: '00000', reason: 'not_found' },
    ]);
    assert.equal(r1.body.key, 'k-1');
    assert.equal(r1.body.duplicate, undefined);
    let st = ordersOf(await c.state());
    assert.equal(st.counts.待审核, (before.counts.待审核 as number) - 2);
    assert.equal(st.counts.已审核, (before.counts.已审核 as number) + 2);
    assert.equal(st.counts.已驳回, before.counts.已驳回, '已驳回不会被改');
    assert.deepEqual(st.changed_ids, [pend[0], pend[1]]);
    assert.deepEqual(st.comments, {
      [pend[0] as string]: '资料齐全',
      [pend[1] as string]: '资料齐全',
    });
    assert.deepEqual(
      (await (await api.get(`/api/orders/${rej}`)).json()) as Order,
      all.find((o) => o.id === rej),
    );

    // 同一个键再来一次：计数变 2，数据不再改，原样返回首次结果并标记 duplicate
    const dup = await post({ ids: [pend[0], pend[1], pend[2]], key: 'k-1' });
    assert.deepEqual({ ...dup.body, duplicate: undefined }, { ...r1.body, duplicate: undefined });
    assert.equal(dup.body.duplicate, true);
    st = ordersOf(await c.state());
    assert.deepEqual(st.changed_ids, [pend[0], pend[1]], 'pend[2] 没有被审核');
    const s1 = (await c.state()).submissions.find((x) => x.key === 'k-1');
    assert.equal(s1?.op, 'approve');
    assert.equal(s1?.count, 2);

    // 不同的键是新操作；没有键时服务端自动生成，各算一次
    assert.equal((await post({ ids: [pend[2]], key: 'k-2' })).body.approved, 1);
    assert.equal((await post({ ids: [pend[3]] })).body.key, null);
    assert.equal((await post({ ids: [pend[4]] })).body.approved, 1);
    const subs = approveSubs(await c.state());
    assert.equal(subs.length, 4);
    assert.deepEqual(
      subs.map((x) => x.count),
      [2, 1, 1, 1],
    );
    assert.ok(subs.slice(2).every((x) => x.key.startsWith('auto-')));
    assert.deepEqual(ordersOf(await c.state()).changed_ids, pend.slice(0, 5));
  });

  test('故障注入对订单接口生效：error_rate、drop_rate、commit_timeout 的写接口先落库再不返回', async () => {
    const space = 'ord-faults-api';
    const c = control(lab, space);
    const cookie = await loginCookie(lab, space);
    const api = apiOf(lab, space, cookie);
    const pend = (await api.all()).filter((o) => o.status === '待审核').map((o) => o.id);

    await c.faults({ error_rate: 1 });
    assert.equal((await api.get('/api/orders')).status, 500);
    assert.equal((await api.get('/api/orders/export.csv')).status, 500);
    assert.equal((await api.post('/api/orders/approve', { ids: [pend[0]], key: 'e' })).status, 500);
    assert.equal(approveSubs(await c.state()).length, 0, '注入的 500 发生在落库之前');
    assert.equal((await api.get('/orders')).status, 200, '页面不受接口故障影响');
    await c.faults({ error_rate: 0, drop_rate: 1 });
    await assert.rejects(api.get('/api/orders'));
    await c.faults({ drop_rate: 0, commit_timeout: true });
    await assert.rejects(
      fetch(api.url('/api/orders/approve'), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [pend[0]], key: 'ct' }),
        signal: AbortSignal.timeout(400),
      }),
    );
    const s = await c.state();
    assert.deepEqual(ordersOf(s).changed_ids, [pend[0]], '已落库');
    assert.equal(s.submissions.find((x) => x.key === 'ct')?.count, 1);
    // 读接口不受 commit_timeout 影响
    assert.equal((await api.get('/api/orders?page_size=1')).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------
// 二、页面（浏览器 + observe/act）
// ---------------------------------------------------------------------------------------------

describe('订单后台：页面', { skip: SKIP }, () => {
  let lab: Lab;
  let browser: Browser;
  let session: Session;
  let profileDir: string;
  const tmpDirs: string[] = [];

  before(async () => {
    lab = await createLab({ modules: [auth, orders] });
    profileDir = mkdtempSync(join(tmpdir(), 'obact-lab-orders-'));
    browser = await launchBrowser({
      profileDir,
      chromePath: CHROME,
      mode: process.env.HEADED === '1' ? 'headed' : 'headless',
    });
    session = await Session.attach(browser);
  });
  after(async () => {
    await session?.close({ closeBrowser: true });
    await lab?.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  /** 执行动作并校验返回值符合契约。 */
  async function run(a: Action): Promise<ActResult> {
    const r = await act(session, a);
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  async function err(a: Action, ...codes: string[]): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'error', `${a.op} 应失败`);
    assert.ok(codes.includes(r.error?.code ?? ''), `${r.error?.code}：${r.error?.message}`);
    return r;
  }

  /** observe 并校验返回值符合契约。 */
  async function obs(pageId: string) {
    const r = await observe(session, { pageId });
    contracts.assert('observe.Result', r);
    return r;
  }

  /** 登录（HTTP）、把会话 cookie 交给浏览器、打开订单列表，等到列表加载完。 */
  async function openOrders(
    space: string,
    opts: { faults?: Partial<Faults>; wait?: string | false; path?: string } = {},
  ) {
    const cookie = await loginCookie(lab, space);
    const [name, value] = cookie.split('=') as [string, string];
    await browser.setCookie({
      name,
      value,
      domain: '127.0.0.1',
      path: `/s/${space}/`,
      httpOnly: true,
    });
    const c = control(lab, space);
    if (opts.faults) await c.faults(opts.faults);
    const pageId = await session.pages.newPage();
    const page = session.pages.get(pageId);
    await page.goto(`${lab.url(space)}${opts.path ?? '/orders'}`, { waitUntil: 'load' });
    if (opts.wait !== false) {
      await ok({ op: 'wait_for', pageId, until: [{ text_present: opts.wait ?? '共 200 条' }] });
    }
    return { pageId, page, c, api: apiOf(lab, space, cookie) };
  }

  /** 页面上当前显示的订单行（表格或卡片）。 */
  async function domRows(pageId: string): Promise<Row[]> {
    return session.pages.get(pageId).evaluate((): Row[] => {
      const text = (e: Element | null | undefined) => (e?.textContent ?? '').trim();
      const trs = [...document.querySelectorAll('table tbody tr[data-id]')];
      if (trs.length) {
        return trs.map((tr) => {
          const td = tr.querySelectorAll('td');
          return {
            id: tr.getAttribute('data-id'),
            customer: text(td[2]),
            amount: text(td[3]),
            status: text(td[4]),
            region: text(td[5]),
            created_at: text(td[6]),
          };
        });
      }
      return [...document.querySelectorAll('ul li[data-id]')].map((li) => {
        const dd = li.querySelectorAll('dd');
        return {
          id: li.getAttribute('data-id'),
          customer: text(dd[0]),
          amount: text(dd[1]),
          status: text(li.querySelector('.card-head')?.lastElementChild),
          region: text(dd[2]),
          created_at: text(dd[3]),
        };
      });
    });
  }

  const bodyText = (pageId: string) =>
    session.pages.get(pageId).evaluate(() => document.body.innerText);

  /** 勾选这些订单（按角色 + 名称）。 */
  async function check(pageId: string, ids: readonly string[]) {
    for (const id of ids) {
      await ok({ op: 'click', pageId, target: { role: 'checkbox', name: `选择订单 ${id}` } });
    }
  }

  /** 页面上的订单按当前筛选条件取前 n 条待审核的订单号。 */
  const firstPending = (items: readonly Order[], n: number): string[] => {
    const ids = items.filter((o) => o.status === '待审核').map((o) => o.id);
    assert.ok(ids.length >= n, `当前页待审核订单不足 ${n} 条`);
    return ids.slice(0, n);
  };

  /** 点“批量审核”并确认对话框的文字，返回处理对话框的结果；accept 为 false 时取消。 */
  async function batch(
    pageId: string,
    opts: { name?: string; message: string; accept?: boolean; post?: string; timeout_ms?: number },
  ): Promise<ActResult> {
    const click = await ok({
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
    if (opts.timeout_ms) a.timeout_ms = opts.timeout_ms;
    return run(a);
  }

  test('未登录访问订单页：跳到登录页，用真实的登录页登录后回到订单页', async () => {
    const space = 'ord-ui-login';
    const pageId = await session.pages.newPage();
    const page = session.pages.get(pageId);
    await page.goto(`${lab.url(space)}/orders`, { waitUntil: 'load' });
    assert.match(page.url(), /\/login\?next=%2Forders$/);
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '账号' }, value: 'alice' });
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '密码' }, value: 'alice123' });
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '登录' },
      post: [{ url_matches: '/orders$' }, { text_present: '共 200 条' }],
    });
    assert.equal(new URL(page.url()).pathname, `/s/${space}/orders`);
    const ob = await obs(pageId);
    assert.ok(
      ob.elements.some((e) => e.role === 'link' && e.name === '订单后台'),
      '导航里有订单后台',
    );
    assert.ok(ob.elements.some((e) => e.role === 'button' && e.name === '批量审核'));
  });

  test('筛选、排序、翻页都在前端完成：URL 始终不变，页面内容与接口一致', async () => {
    const space = 'ord-ui-browse';
    const { pageId, page, api } = await openOrders(space);
    const url0 = page.url();
    const history0 = await page.evaluate(() => history.length);

    /** 页面上的行必须等于接口按同一条件返回的这一页；URL 与历史记录不变；动作不引起导航。 */
    const expectList = async (query: string, label: string): Promise<ListBody> => {
      const want = await api.list(query);
      assert.deepEqual(await domRows(pageId), expectedRows(want.items), label);
      assert.equal(page.url(), url0, `${label}：URL 不变`);
      assert.equal(
        await page.evaluate(() => history.length),
        history0,
        `${label}：没有新增历史记录`,
      );
      return want;
    };
    const quiet = (r: ActResult) => assert.equal(r.effects.navigated, false);

    // 初始：200 条、10 页、默认按下单时间倒序
    const init = await expectList('sort=created_at&dir=desc', '初始');
    assert.equal(init.items.length, 20);
    assert.ok((await bodyText(pageId)).includes('共 200 条，第 1 / 10 页，每页 20 条'));

    // 状态筛选（下拉框，点“查询”才生效）
    const pend = await api.list(`status=${encodeURIComponent('待审核')}`);
    await ok({ op: 'fill', pageId, target: { role: 'combobox', name: '状态' }, value: '待审核' });
    assert.ok((await bodyText(pageId)).includes('共 200 条'), '没点查询之前不筛选');
    quiet(
      await ok({
        op: 'click',
        pageId,
        target: { role: 'button', name: '查询' },
        post: [{ text_present: `共 ${pend.total} 条` }],
      }),
    );
    await expectList(`status=${encodeURIComponent('待审核')}`, '状态=待审核');

    // 关键字（不分大小写，匹配客户名）；回车也能提交
    await ok({ op: 'fill', pageId, target: { role: 'searchbox', name: '关键字' }, value: 'orion' });
    await ok({ op: 'press_key', pageId, key: 'Enter' });
    const q = `status=${encodeURIComponent('待审核')}&q=orion`;
    const orion = await api.list(q);
    assert.ok(orion.total > 0 && orion.total <= 20);
    await ok({ op: 'wait_for', pageId, until: [{ text_present: `共 ${orion.total} 条` }] });
    await expectList(q, '状态=待审核 且关键字=orion');
    assert.ok((await domRows(pageId)).every((r) => r.customer.toLowerCase().includes('orion')));

    // 排序：点表头，同一列再点翻转方向；aria-sort 表达当前状态
    const sortedHeader = () =>
      page.evaluate(() => {
        const th = document.querySelector('th[aria-sort=ascending], th[aria-sort=descending]');
        return th ? [th.textContent?.trim(), th.getAttribute('aria-sort')] : null;
      });
    quiet(await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } }));
    await expectList(`${q}&sort=amount&dir=asc`, '金额升序');
    assert.deepEqual(await sortedHeader(), ['金额', 'ascending']);
    quiet(await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } }));
    await expectList(`${q}&sort=amount&dir=desc`, '金额降序');
    assert.deepEqual(await sortedHeader(), ['金额', 'descending']);
    await ok({ op: 'click', pageId, target: { role: 'button', name: '客户' } });
    await expectList(`${q}&sort=customer&dir=asc`, '客户升序');

    // 没有结果
    await ok({
      op: 'fill',
      pageId,
      target: { role: 'searchbox', name: '关键字' },
      value: '不存在的客户zzz',
    });
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '查询' },
      post: [{ text_present: '没有符合条件的订单' }],
    });
    assert.ok((await bodyText(pageId)).includes('共 0 条'));
    assert.deepEqual(await domRows(pageId), []);

    // 重置：回到全部订单（排序保持）
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '重置' },
      post: [{ text_present: '共 200 条' }],
    });
    await expectList('sort=customer&dir=asc', '重置');
    await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
    await expectList('sort=amount&dir=desc', '金额降序（全部）');

    // 翻页：页码、下一页、上一页；首页上一页不可点，末页下一页不可点；换排序回到第 1 页
    quiet(await ok({ op: 'click', pageId, target: { role: 'button', name: '第 3 页' } }));
    await expectList('sort=amount&dir=desc&page=3', '第 3 页');
    assert.ok((await bodyText(pageId)).includes('第 3 / 10 页'));
    assert.equal(
      await page.$eval('nav button[aria-current=page]', (e) => e.textContent),
      '3',
      '当前页码高亮',
    );
    await ok({ op: 'click', pageId, target: { role: 'button', name: '下一页' } });
    await expectList('sort=amount&dir=desc&page=4', '下一页');
    await ok({ op: 'click', pageId, target: { role: 'button', name: '上一页' } });
    await expectList('sort=amount&dir=desc&page=3', '上一页');
    await ok({ op: 'click', pageId, target: { role: 'button', name: '第 1 页' } });
    assert.equal(
      await page.$eval('[data-page=prev]', (e) => (e as HTMLButtonElement).disabled),
      true,
    );
    await err(
      { op: 'click', pageId, target: { role: 'button', name: '上一页' }, timeout_ms: 500 },
      'not_actionable',
    );
    await ok({ op: 'click', pageId, target: { role: 'button', name: '第 10 页' } });
    const last = await expectList('sort=amount&dir=desc&page=10', '末页');
    assert.equal(last.items.length, 20);
    assert.equal(
      await page.$eval('[data-page=next]', (e) => (e as HTMLButtonElement).disabled),
      true,
    );
    await ok({ op: 'click', pageId, target: { role: 'button', name: '订单号' } });
    await expectList('sort=id&dir=asc&page=1', '换排序回到第 1 页');
    assert.ok((await bodyText(pageId)).includes('第 1 / 10 页'));
    assert.equal(page.url(), url0);
  });

  test('批量审核：勾选 3 条 → 取消不提交 → 确认后落库一次，幂等键计数为 1，其余订单不变', async () => {
    const space = 'ord-ui-approve';
    const { pageId, page, c, api } = await openOrders(space);
    const before = await api.all();
    const stBefore = ordersOf(await c.state());

    await ok({ op: 'fill', pageId, target: { role: 'combobox', name: '状态' }, value: '待审核' });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '查询' } });
    const pendTotal = stBefore.counts.待审核 as number;
    await ok({ op: 'wait_for', pageId, until: [{ text_present: `共 ${pendTotal} 条` }] });
    const pick = firstPending((await api.list(`status=${encodeURIComponent('待审核')}`)).items, 3);

    // 没有勾选时按钮不可用
    assert.equal(await page.$eval('#btn-batch', (e) => (e as HTMLButtonElement).disabled), true);
    await err(
      { op: 'click', pageId, target: { role: 'button', name: '批量审核' }, timeout_ms: 500 },
      'not_actionable',
    );

    await check(pageId, pick);
    assert.ok((await bodyText(pageId)).includes('已选 3 条'));
    assert.equal(await page.$eval('#btn-batch', (e) => (e as HTMLButtonElement).disabled), false);

    // 取消：不提交
    const cancel = await batch(pageId, { message: '确认批量审核选中的 3 条订单？', accept: false });
    assert.equal(cancel.status, 'ok');
    assert.deepEqual(cancel.effects.dialogs, [
      { type: 'confirm', message: '确认批量审核选中的 3 条订单？', handled: 'dismiss' },
    ]);
    const s0 = await c.state();
    assert.equal(s0.submissions.length, 0, '取消不提交');
    assert.deepEqual(ordersOf(s0).counts, stBefore.counts);
    assert.ok((await bodyText(pageId)).includes('已选 3 条'), '取消后勾选还在');

    // 确认：提交一次
    const done = await batch(pageId, {
      message: '确认批量审核选中的 3 条订单？',
      post: '已审核 3 条',
    });
    assert.equal(done.status, 'ok', `${done.error?.code} ${done.error?.message}`);
    const s1 = await c.state();
    const st1 = ordersOf(s1);
    assert.equal(st1.counts.待审核, pendTotal - 3);
    assert.equal(st1.counts.已审核, (stBefore.counts.已审核 as number) + 3);
    assert.equal(st1.counts.已驳回, stBefore.counts.已驳回);
    assert.deepEqual(sorted(st1.changed_ids), sorted(pick));
    for (const id of pick) assert.ok(st1.approved_ids.includes(id));
    const subs = approveSubs(s1);
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.count, 1, '幂等键计数为 1');
    assert.match(subs[0]?.key ?? '', UUID, '页面用 crypto.randomUUID() 生成幂等键');
    assert.deepEqual(
      sorted((subs[0]?.payload as { ids: string[] } | undefined)?.ids ?? []),
      sorted(pick),
    );

    // 其余订单没有被改动
    const after = await api.all();
    assert.deepEqual(
      after.filter((o) => !pick.includes(o.id)),
      before.filter((o) => !pick.includes(o.id)),
    );
    for (const o of after.filter((x) => pick.includes(x.id))) assert.equal(o.status, '已审核');

    // 页面：这三条已从“待审核”列表里消失，选择清零，按钮回到不可用
    const text = await bodyText(pageId);
    assert.ok(text.includes(`共 ${pendTotal - 3} 条`));
    assert.ok(text.includes('已选 0 条'));
    assert.equal(await page.$eval('#btn-batch', (e) => (e as HTMLButtonElement).disabled), true);
    const shown = (await domRows(pageId)).map((r) => r.id);
    for (const id of pick) assert.ok(!shown.includes(id));

    // 行内“审核”：每行都有同名按钮，靠所在行消歧；生成的定位器带 within，能原样回放
    const target = firstPending(
      (await api.list(`status=${encodeURIComponent('待审核')}`)).items,
      1,
    )[0] as string;
    const ob = await obs(pageId);
    const same = ob.elements.filter((e) => e.role === 'button' && e.name === '审核');
    assert.ok(same.length >= 10, '同名的审核按钮有很多个');
    const btn = same.find((e) => e.within === `tr[data-id='${target}']`);
    assert.ok(btn, '按钮带所在行');
    const gen = await generateLocator(session, pageId, btn.ref);
    assert.equal(gen.unique, true);
    assert.equal(gen.locator.within, `tr[data-id='${target}']`);
    assert.deepEqual([gen.locator.role, gen.locator.name], ['button', '审核']);
    const click = await ok({ op: 'click', pageId, target: gen.locator });
    assert.deepEqual(click.effects.dialogs, [
      { type: 'confirm', message: `确认审核订单 ${target}？`, handled: 'pending' },
    ]);
    await ok({
      op: 'handle_dialog',
      pageId,
      action: 'accept',
      post: [{ text_present: '已审核 1 条' }],
    });
    const s2 = await c.state();
    assert.deepEqual(ordersOf(s2).changed_ids.slice(3), [target]);
    const subs2 = approveSubs(s2);
    assert.equal(subs2.length, 2);
    assert.notEqual(subs2[1]?.key, subs2[0]?.key, '新操作换新键');
    assert.ok(subs2.every((x) => x.count === 1));
  });

  test('提交超时但已落库（C-4 的前提）：act 超时或报错，状态里已落库、幂等键计数为 1', async () => {
    const space = 'ord-ui-commit-timeout';
    const { pageId, c, api } = await openOrders(space);
    const items = (await api.list()).items;
    const pick = firstPending(items, 3);
    const stBefore = ordersOf(await c.state());
    await check(pageId, pick);
    await c.faults({ commit_timeout: true });

    const r = await batch(pageId, {
      message: '确认批量审核选中的 3 条订单？',
      post: '已审核 3 条',
      timeout_ms: 1500,
    });
    assert.equal(r.status, 'error', '页面没有收到响应，成功提示不会出现');
    assert.ok(['assertion_failed', 'timeout'].includes(r.error?.code ?? ''), `${r.error?.code}`);

    // 服务端已经落库，且只记录了一次
    const s = await c.state();
    const st = ordersOf(s);
    assert.deepEqual(sorted(st.changed_ids), sorted(pick));
    assert.equal(st.counts.已审核, (stBefore.counts.已审核 as number) + 3);
    assert.equal(st.counts.待审核, (stBefore.counts.待审核 as number) - 3);
    const subs = approveSubs(s);
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.count, 1);
    assert.ok(s.log.some((x) => x.type === 'fault_commit_timeout'));
    // 页面还在等响应：没有成功提示，也没有错误提示（15 秒的等待上限没到）
    const text = await bodyText(pageId);
    assert.ok(!text.includes('已审核 3 条'));
    assert.ok(text.includes('提交中…'));
  });

  test('状态未明后重试：页面提示状态未明，重试沿用同一个幂等键，服务端只计数、不重复落库', async () => {
    const space = 'ord-ui-retry';
    const { pageId, page, c, api } = await openOrders(space);
    const pick = firstPending((await api.list()).items, 3);
    await check(pageId, pick);
    // 把提交的等待上限缩短到 1.2 秒（默认 15 秒），让“状态未明”很快出现
    await page.evaluate(() => {
      (
        window as unknown as { __ORDERS__: { submit_timeout_ms: number } }
      ).__ORDERS__.submit_timeout_ms = 1200;
    });
    await c.faults({ commit_timeout: true });
    await batch(pageId, { message: '确认批量审核选中的 3 条订单？' });
    await ok({
      op: 'wait_for',
      pageId,
      until: [{ text_present: '提交状态未明' }],
      timeout_ms: 8000,
    });
    const alertText = await page.$eval('[role=alert]', (e) => (e as HTMLElement).innerText);
    assert.match(alertText, /提交失败：请求超时/);
    assert.match(alertText, /重试会沿用同一个幂等键/);

    const s1 = await c.state();
    const key = approveSubs(s1)[0]?.key as string;
    assert.match(key, UUID);
    assert.equal(approveSubs(s1)[0]?.count, 1);
    assert.deepEqual(sorted(ordersOf(s1).changed_ids), sorted(pick), '已经落库');

    // 故障解除，点“重试提交”：同一个键再到达服务端
    await c.faults({ commit_timeout: false });
    const retry = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '重试提交' },
      post: [{ text_present: '已审核 3 条（此前的提交已生效，本次没有重复处理）' }],
    });
    assert.equal(retry.effects.dialogs.length, 0, '重试是同一次操作，不再弹确认');
    const s2 = await c.state();
    const subs = approveSubs(s2);
    assert.equal(subs.length, 1, '没有产生新的键');
    assert.equal(subs[0]?.key, key);
    assert.equal(subs[0]?.count, 2, '同一个键被提交了 2 次，对账能发现');
    assert.deepEqual(sorted(ordersOf(s2).changed_ids), sorted(pick), '数据没有被重复修改');
    assert.equal(await page.$eval('[role=alert]', (e) => (e as HTMLElement).hidden), true);

    // 成功之后的下一次操作换新键
    const next = firstPending((await api.list()).items, 1);
    await check(pageId, next);
    await batch(pageId, { message: '确认批量审核选中的 1 条订单？', post: '已审核 1 条' });
    const subs3 = approveSubs(await c.state());
    assert.equal(subs3.length, 2);
    assert.notEqual(subs3[1]?.key, key);
  });

  test('故障注入下页面有可见的提示：error_rate 与 drop_rate 时列表加载失败可重试，延迟时显示加载中', async () => {
    // error_rate=1：接口全部 500，页面不是空白，给出错误提示和重新加载按钮
    const a = await openOrders('ord-ui-error', { faults: { error_rate: 1 }, wait: false });
    await ok({
      op: 'wait_for',
      pageId: a.pageId,
      until: [{ text_present: '加载订单失败' }],
      timeout_ms: 5000,
    });
    const ob = await obs(a.pageId);
    assert.ok(ob.text_md.includes('加载订单失败：服务器返回 500'), ob.text_md);
    assert.ok(ob.text_md.includes('订单数据未能加载'), '列表区域也有说明，不是空白');
    assert.ok(ob.elements.some((e) => e.role === 'button' && e.name === '重新加载'));
    const alert = await a.page.$eval('[role=alert]', (e) => ({
      hidden: (e as HTMLElement).hidden,
      visible: (e as HTMLElement).offsetHeight > 0,
    }));
    assert.deepEqual(alert, { hidden: false, visible: true });
    assert.deepEqual(await domRows(a.pageId), []);
    await a.c.faults({ error_rate: 0 });
    await ok({
      op: 'click',
      pageId: a.pageId,
      target: { role: 'button', name: '重新加载' },
      post: [{ text_present: '共 200 条' }],
    });
    assert.equal((await domRows(a.pageId)).length, 20);
    assert.equal(await a.page.$eval('[role=alert]', (e) => (e as HTMLElement).hidden), true);

    // drop_rate=1：连接被断开，提示网络错误
    const d = await openOrders('ord-ui-drop', { faults: { drop_rate: 1 }, wait: false });
    await ok({
      op: 'wait_for',
      pageId: d.pageId,
      until: [{ text_present: '加载订单失败：网络错误' }],
      timeout_ms: 5000,
    });

    // delay_ms：先显示“加载中…”，数据到了再显示列表
    const l = await openOrders('ord-ui-delay', { faults: { delay_ms: 1500 }, wait: false });
    assert.ok((await bodyText(l.pageId)).includes('加载中…'));
    await ok({
      op: 'wait_for',
      pageId: l.pageId,
      until: [{ text_present: '共 200 条' }],
      timeout_ms: 8000,
    });
    assert.equal((await domRows(l.pageId)).length, 20);
  });

  test('提交失败有可见提示：error_rate 时审核提示失败并可重试；会话过期提示重新登录', async () => {
    // 500：落库之前就失败，状态不明确，可重试
    const space = 'ord-ui-approve-error';
    const { pageId, page, c, api } = await openOrders(space);
    const pick = firstPending((await api.list()).items, 2);
    await check(pageId, pick);
    await c.faults({ error_rate: 1 });
    const r = await batch(pageId, {
      message: '确认批量审核选中的 2 条订单？',
      post: '提交失败：服务器返回 500',
    });
    assert.equal(r.status, 'ok', `${r.error?.code} ${r.error?.message}`);
    const s1 = await c.state();
    assert.equal(s1.submissions.length, 0);
    assert.deepEqual(ordersOf(s1).changed_ids, []);
    assert.ok((await bodyText(pageId)).includes('已选 2 条'), '失败后勾选还在');
    await c.faults({ error_rate: 0 });
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '重试提交' },
      post: [{ text_present: '已审核 2 条' }],
    });
    const s2 = await c.state();
    assert.equal(approveSubs(s2).length, 1);
    assert.equal(approveSubs(s2)[0]?.count, 1);
    assert.deepEqual(sorted(ordersOf(s2).changed_ids), sorted(pick));
    assert.equal(await page.$eval('[role=alert]', (e) => (e as HTMLElement).hidden), true);

    // 会话过期：401，明确失败，提示重新登录（带登录页链接）
    const e = await openOrders('ord-ui-expired');
    const one = firstPending((await e.api.list()).items, 1);
    await check(e.pageId, one);
    await e.c.faults({ session_ttl_ms: 1 });
    await batch(e.pageId, {
      message: '确认批量审核选中的 1 条订单？',
      post: '登录已过期，请重新登录',
    });
    const link = await e.page.$eval('[role=alert] a', (a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    );
    assert.equal(link, '/s/ord-ui-expired/login?next=%2Forders');
    const se = await e.c.state();
    assert.equal(se.submissions.length, 0);
    assert.deepEqual(ordersOf(se).changed_ids, []);
    assert.equal(
      await e.page.$$eval('button', (bs) => bs.some((b) => b.textContent === '重试提交')),
      false,
      '明确失败（未登录）不提供重试',
    );
  });

  test('详情页：订单信息、填写审核意见并审核、已审核与已驳回不可再审核、不存在为 404', async () => {
    const space = 'ord-ui-detail';
    const { pageId, page, c, api } = await openOrders(space);
    const all = await api.all();
    const target = all.find((o) => o.status === '待审核') as Order;
    const rejected = all.find((o) => o.status === '已驳回') as Order;

    // 从列表点订单号进入详情（导航）
    const nav = await ok({
      op: 'click',
      pageId,
      target: { role: 'link', name: target.id },
      post: [{ url_matches: `/orders/${target.id}$` }],
    });
    assert.equal(nav.effects.navigated, true);
    const text = await bodyText(pageId);
    for (const s of [
      `订单 ${target.id}`,
      target.customer,
      `¥${fmtAmount(target.amount)}`,
      target.region,
      target.created_at,
      '待审核',
    ]) {
      assert.ok(text.includes(s), `详情页缺少：${s}`);
    }
    await ok({
      op: 'fill',
      pageId,
      target: { role: 'textbox', name: '审核意见' },
      value: '资料齐全，同意',
    });
    const click = await ok({ op: 'click', pageId, target: { role: 'button', name: '审核通过' } });
    assert.deepEqual(click.effects.dialogs, [
      { type: 'confirm', message: `确认审核通过订单 ${target.id}？`, handled: 'pending' },
    ]);
    await ok({
      op: 'handle_dialog',
      pageId,
      action: 'accept',
      post: [{ text_present: '已审核 1 条' }],
    });
    assert.equal(await page.$eval('#order-status', (e) => e.textContent), '已审核');
    const st = ordersOf(await c.state());
    assert.deepEqual(st.changed_ids, [target.id]);
    assert.deepEqual(st.comments, { [target.id]: '资料齐全，同意' });
    assert.equal(approveSubs(await c.state()).length, 1);

    // 刷新：状态、意见都在，不再有审核按钮
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    const again = await bodyText(pageId);
    assert.ok(again.includes('资料齐全，同意'));
    assert.ok(again.includes('该订单已审核。'));
    assert.equal(await page.$('#btn-approve'), null);

    // 已驳回：不能审核
    await ok({ op: 'navigate_page', pageId, url: `${lab.url(space)}/orders/${rejected.id}` });
    assert.ok((await bodyText(pageId)).includes('该订单已驳回，不能审核。'));
    assert.equal(await page.$('#btn-approve'), null);

    // 不存在：404
    const r = await api.get('/orders/00000');
    assert.equal(r.status, 404);
    assert.ok((await r.text()).includes('订单不存在'));
  });

  test('导出：当前筛选条件的 CSV，链接随筛选与排序更新，浏览器下载的内容与接口一致', async () => {
    const space = 'ord-ui-export';
    const { pageId, page, api } = await openOrders(space);
    const url0 = page.url();
    const linkOf = async () => {
      const ob = await obs(pageId);
      const link = ob.elements.find((e) => e.role === 'link' && e.name === '导出 CSV');
      assert.ok(link, '导出链接在元素表中');
      return link;
    };
    assert.ok(
      (await linkOf()).href?.endsWith('/api/orders/export.csv?sort=created_at&dir=desc'),
      '初始：全部订单',
    );

    await ok({ op: 'fill', pageId, target: { role: 'combobox', name: '状态' }, value: '待审核' });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '查询' } });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
    const query = `status=${encodeURIComponent('待审核')}&sort=amount&dir=desc`;
    const want = await api.list(`${query}&page_size=500`);
    await ok({ op: 'wait_for', pageId, until: [{ text_present: `共 ${want.total} 条` }] });
    const link = await linkOf();
    assert.ok(link.href?.endsWith(`/api/orders/export.csv?${query}`), link.href);

    // 链接指向的内容 = 当前筛选条件下的全部订单（不止当前页）
    assert.ok(want.total > 20, '筛选结果多于一页，导出的是全部');
    const fetched = Buffer.from(
      await (
        await api.get(
          new URL(link.href as string).pathname.replace(`/s/${space}`, '') +
            new URL(link.href as string).search,
        )
      ).arrayBuffer(),
    );
    assert.equal(fetched.toString('utf8'), ordersCsv(want.items));
    const csv = parseCsv(fetched.toString('utf8').slice(1));
    assert.equal(csv.length, want.total + 1);
    assert.ok(csv.slice(1).every((x) => x[3] === '待审核'));

    // 在浏览器里点链接：触发下载（不是导航），文件内容与接口一致
    const dir = mkdtempSync(join(tmpdir(), 'obact-orders-download-'));
    tmpDirs.push(dir);
    const cdp = await browser.target().createCDPSession();
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dir,
        eventsEnabled: true,
      });
      const begin = new Promise<{ suggestedFilename: string; url: string }>((resolve) =>
        cdp.on('Browser.downloadWillBegin', (e) => resolve(e)),
      );
      const done = new Promise<{ guid: string }>((resolve) =>
        cdp.on('Browser.downloadProgress', (e) => {
          if (e.state === 'completed') resolve(e);
        }),
      );
      const click = await ok({ op: 'click', pageId, target: { ref: link.ref } });
      assert.equal(click.effects.navigated, false, '下载不是导航');
      const b = await Promise.race([
        begin,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('等待下载开始超时')), 10_000),
        ),
      ]);
      const d = await Promise.race([
        done,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('等待下载完成超时')), 10_000),
        ),
      ]);
      assert.ok(b.url.endsWith(`/api/orders/export.csv?${query}`), b.url);
      assert.ok(readFileSync(join(dir, d.guid)).equals(fetched), '下载的文件与接口一致（含 BOM）');
      assert.equal(b.suggestedFilename, 'orders.csv');
    } finally {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    assert.equal(page.url(), url0, '页面没有跳走');

    // 再加关键字：链接随之更新，内容仍与同条件的接口结果逐字节一致
    await ok({ op: 'fill', pageId, target: { role: 'searchbox', name: '关键字' }, value: 'orion' });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '查询' } });
    const query2 = `status=${encodeURIComponent('待审核')}&q=orion&sort=amount&dir=desc`;
    const want2 = await api.list(`${query2}&page_size=500`);
    assert.ok(want2.total > 0 && want2.total < want.total);
    const link2 = await linkOf();
    assert.ok(link2.href?.endsWith(`/api/orders/export.csv?${query2}`), link2.href);
    const body2 = await csvText(await api.get(`/api/orders/export.csv?${query2}`));
    assert.equal(body2, ordersCsv(want2.items));
    assert.equal(parseCsv(body2.slice(1)).length, want2.total + 1);

    // 没有结果时导出只有表头
    await ok({
      op: 'fill',
      pageId,
      target: { role: 'searchbox', name: '关键字' },
      value: '不存在的客户zzz',
    });
    await ok({ op: 'click', pageId, target: { role: 'button', name: '查询' } });
    const q3 = `status=${encodeURIComponent('待审核')}&q=${encodeURIComponent('不存在的客户zzz')}&sort=amount&dir=desc`;
    assert.ok((await linkOf()).href?.endsWith(`/api/orders/export.csv?${q3}`));
    const empty = await api.get(`/api/orders/export.csv?${q3}`);
    assert.equal(parseCsv((await csvText(empty)).slice(1)).length, 1);
  });

  describe('改版变体（faults.redesign）', () => {
    /** 批量审核 3 条并核对落库；返回选中的订单号。 */
    async function approveThree(
      space: string,
      pageId: string,
      c: ReturnType<typeof control>,
      api: ReturnType<typeof apiOf>,
      opts: { name: string; message: string },
    ): Promise<string[]> {
      const pick = firstPending((await api.list()).items, 3);
      const before = ordersOf(await c.state());
      await check(pageId, pick);
      assert.ok((await bodyText(pageId)).includes('已选 3 条'));
      const r = await batch(pageId, { ...opts, post: '已审核 3 条' });
      assert.equal(r.status, 'ok', `${space}：${r.error?.code} ${r.error?.message}`);
      const s = await c.state();
      assert.deepEqual(sorted(ordersOf(s).changed_ids), sorted(pick));
      assert.equal(ordersOf(s).counts.已审核, (before.counts.已审核 as number) + 3);
      assert.equal(approveSubs(s).length, 1);
      assert.equal(approveSubs(s)[0]?.count, 1);
      return pick;
    }

    test('1 改 id 与类名：原来的 CSS 定位器失效，按角色 + 名称仍可用，批量审核照常', async () => {
      const space = 'ord-ui-redesign-1';
      const { pageId, page, c, api } = await openOrders(space, { faults: { redesign: 1 } });
      for (const old of [
        '#order-table',
        '#btn-batch',
        '#status-filter',
        '#keyword',
        '.sort-btn',
        '.row-check',
        '.order-row',
        '#check-all',
      ]) {
        assert.equal(await page.$(old), null, `${old} 已改名`);
      }
      assert.equal(await page.$('[role=alert]').then((e) => e !== null), true, '错误提示容器还在');
      await err(
        { op: 'click', pageId, target: { css: '#btn-batch' }, timeout_ms: 500 },
        'not_found',
      );
      const ob = await obs(pageId);
      for (const [role, name] of [
        ['button', '批量审核'],
        ['button', '查询'],
        ['combobox', '状态'],
        ['searchbox', '关键字'],
        ['link', '导出 CSV'],
      ]) {
        assert.ok(
          ob.elements.some((e) => e.role === role && e.name === name),
          `${role} ${name}`,
        );
      }
      // 内容与原版一致
      assert.deepEqual(await domRows(pageId), expectedRows((await api.list()).items));
      await ok({ op: 'click', pageId, target: { role: 'button', name: '金额' } });
      assert.deepEqual(
        await domRows(pageId),
        expectedRows((await api.list('sort=amount&dir=asc')).items),
      );
      await ok({ op: 'click', pageId, target: { role: 'button', name: '订单号' } });
      await ok({ op: 'click', pageId, target: { role: 'button', name: '订单号' } });
      await approveThree(space, pageId, c, api, {
        name: '批量审核',
        message: '确认批量审核选中的 3 条订单？',
      });
    });

    test('2 改按钮文案：id 与类名不变，按旧文案的角色 + 名称定位失效，新文案可用', async () => {
      const space = 'ord-ui-redesign-2';
      const { pageId, page, c, api } = await openOrders(space, { faults: { redesign: 2 } });
      assert.equal(await page.$eval('#btn-batch', (e) => e.textContent), '审核所选');
      assert.equal(await page.$eval('#btn-search', (e) => e.textContent), '搜索');
      await err(
        { op: 'click', pageId, target: { role: 'button', name: '批量审核' }, timeout_ms: 500 },
        'not_found',
      );
      await err(
        { op: 'click', pageId, target: { role: 'button', name: '查询' }, timeout_ms: 500 },
        'not_found',
      );
      const ob = await obs(pageId);
      for (const [role, name] of [
        ['button', '审核所选'],
        ['button', '搜索'],
        ['button', '清空条件'],
        ['button', '通过'],
        ['link', '查看'],
        ['link', '下载 CSV'],
        ['combobox', '订单状态'],
        ['searchbox', '搜索词'],
        ['button', '下页'],
      ]) {
        assert.ok(
          ob.elements.some((e) => e.role === role && e.name === name),
          `${role} ${name}`,
        );
      }
      assert.ok(!ob.elements.some((e) => e.name === '审核'), '行内按钮不再叫“审核”');
      // 用不变的 id 定位：筛选、翻页照常
      await ok({ op: 'fill', pageId, target: { css: '#status-filter' }, value: '已驳回' });
      await ok({ op: 'click', pageId, target: { css: '#btn-search' } });
      const rej = await api.list(`status=${encodeURIComponent('已驳回')}`);
      assert.deepEqual(await domRows(pageId), expectedRows(rej.items));
      await ok({ op: 'click', pageId, target: { css: '#btn-reset' } });
      assert.deepEqual(await domRows(pageId), expectedRows((await api.list()).items));
      await ok({ op: 'click', pageId, target: { role: 'button', name: '下页' } });
      assert.deepEqual(await domRows(pageId), expectedRows((await api.list('page=2')).items));
      await ok({ op: 'click', pageId, target: { role: 'button', name: '上页' } });
      await approveThree(space, pageId, c, api, {
        name: '审核所选',
        message: '确认审核所选的 3 条订单吗？',
      });
    });

    test('3 改层级：表格改成卡片列表，排序改用下拉框和方向按钮，批量审核照常', async () => {
      const space = 'ord-ui-redesign-3';
      const { pageId, page, c, api } = await openOrders(space, { faults: { redesign: 3 } });
      assert.equal(await page.$('table'), null, '没有表格');
      assert.equal(await page.$$eval('ul li[data-id]', (l) => l.length), 20, '20 张卡片');
      assert.equal(await page.$('#check-all'), null, '没有全选框');
      assert.equal(await page.$('th'), null, '没有表头');
      assert.deepEqual(await domRows(pageId), expectedRows((await api.list()).items));
      // 卡片里的同名按钮仍靠所在容器消歧
      const ob = await obs(pageId);
      const sortSel = ob.elements.find((e) => e.role === 'combobox' && e.name === '排序方式');
      assert.ok(sortSel, '有排序下拉框');
      const pendCard = (await api.list()).items.find((o) => o.status === '待审核') as Order;
      assert.ok(
        ob.elements.some(
          (e) =>
            e.role === 'button' && e.name === '审核' && e.within === `li[data-id='${pendCard.id}']`,
        ),
      );
      // 排序：下拉框选字段，方向按钮翻转
      await ok({
        op: 'fill',
        pageId,
        target: { role: 'combobox', name: '排序方式' },
        value: '金额',
      });
      assert.deepEqual(
        await domRows(pageId),
        expectedRows((await api.list('sort=amount&dir=desc')).items),
      );
      await ok({ op: 'click', pageId, target: { role: 'button', name: '降序' } });
      assert.deepEqual(
        await domRows(pageId),
        expectedRows((await api.list('sort=amount&dir=asc')).items),
      );
      await ok({ op: 'click', pageId, target: { role: 'button', name: '第 2 页' } });
      assert.deepEqual(
        await domRows(pageId),
        expectedRows((await api.list('sort=amount&dir=asc&page=2')).items),
      );
      await ok({
        op: 'fill',
        pageId,
        target: { role: 'combobox', name: '排序方式' },
        value: '下单时间',
      });
      await ok({ op: 'click', pageId, target: { role: 'button', name: '升序' } });
      assert.deepEqual(await domRows(pageId), expectedRows((await api.list()).items));
      await approveThree(space, pageId, c, api, {
        name: '批量审核',
        message: '确认批量审核选中的 3 条订单？',
      });
    });

    test('4 全面改版：id、类名、文案、层级全变，只剩角色与业务主键（data-id）可用', async () => {
      const space = 'ord-ui-redesign-4';
      const { pageId, page, c, api } = await openOrders(space, { faults: { redesign: 4 } });
      assert.equal(await page.$('table'), null);
      assert.equal(await page.$('#btn-batch'), null);
      const ob = await obs(pageId);
      assert.ok(ob.elements.some((e) => e.role === 'button' && e.name === '审核所选'));
      assert.ok(!ob.elements.some((e) => e.name === '批量审核'));
      assert.equal(await page.$$eval('ul li[data-id]', (l) => l.length), 20);
      await approveThree(space, pageId, c, api, {
        name: '审核所选',
        message: '确认审核所选的 3 条订单吗？',
      });
    });

    test('改版只改页面：数据与接口不变，详情页同样随变体变化', async () => {
      const space = 'ord-ui-redesign-detail';
      const { pageId, page, api } = await openOrders(space, { faults: { redesign: 2 } });
      const all = await api.all();
      assert.equal(all.length, 200);
      const target = all.find((o) => o.status === '待审核') as Order;
      await ok({ op: 'navigate_page', pageId, url: `${lab.url(space)}/orders/${target.id}` });
      assert.equal(await page.$eval('#btn-approve', (e) => e.textContent), '同意');
      await ok({
        op: 'fill',
        pageId,
        target: { role: 'textbox', name: '备注' },
        value: '改版后的意见',
      });
      const click = await ok({ op: 'click', pageId, target: { role: 'button', name: '同意' } });
      assert.equal(click.effects.dialogs[0]?.message, `确认同意订单 ${target.id} 吗？`);
      await ok({
        op: 'handle_dialog',
        pageId,
        action: 'accept',
        post: [{ text_present: '已审核 1 条' }],
      });
    });
  });
});
