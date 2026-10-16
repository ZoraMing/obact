// 常驻请求夹具（PRD 9.3，FR-14）：每秒轮询 + WebSocket 定时推送下，动作不等网络空闲、很快返回。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { pushValue } from '../api/polling.ts';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();

type PageState = { polls: number; inflight: number; pushes: number; wsOpen: boolean };
type Stats = {
  ticks: number;
  ws_open: number;
  ws_connections: number;
  ws_sent: number;
  ws_received: number;
};

/** 单个动作的耗时上限：远小于 FR-14 的 5 秒稳定等待上限。 */
const FAST_MS = 1500;

describe('常驻请求夹具（FR-14）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  async function ok(a: Action): Promise<ActResult> {
    const r = await act(env.session, a);
    contracts.assert('act-result', r);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  const stats = async (): Promise<Stats> =>
    (await (await fetch(`${env.server.base}/api/polling/stats`)).json()) as Stats;
  const pageState = (pageId: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(() => ({ ...(window as unknown as { fixtureState: PageState }).fixtureState }));
  const text = (pageId: string, sel: string) =>
    env.session.pages.get(pageId).$eval(sel, (e) => e.textContent ?? '');

  test('WebSocket 服务端：握手、定时推送（值由 seed 决定）、回显（含 16 位与 64 位长度帧）、关闭', async () => {
    const before = await stats();
    const ws = new WebSocket(
      `${env.server.base.replace('http', 'ws')}/api/polling/ws?interval=50&seed=3`,
    );
    const msgs: { type: string; seq?: number; value?: number; text?: string }[] = [];
    const waiters = new Set<() => void>();
    ws.addEventListener('message', (e) => {
      msgs.push(JSON.parse(String(e.data)));
      for (const w of [...waiters]) w();
    });
    /** 等到条件成立（每收到一条消息检查一次）。 */
    const until = (cond: () => boolean, what: string) =>
      new Promise<void>((resolve, reject) => {
        if (cond()) return resolve();
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`等待超时：${what}`));
        }, 5000);
        const check = () => {
          if (!cond()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    });
    const pushes = () => msgs.filter((m) => m.type === 'push');
    await until(() => pushes().length >= 3, '3 条推送');
    pushes().forEach((m, i) => {
      assert.equal(m.seq, i + 1, '推送序号连续');
      assert.equal(m.value, pushValue(3, i + 1), '推送值由 seed 与序号决定');
    });

    const echoes = () => msgs.filter((m) => m.type === 'echo').map((m) => m.text);
    const short = '你好';
    const medium = '中文消息'.repeat(80); // 960 字节：16 位长度
    const long = 'x'.repeat(70_000); // 64 位长度
    for (const t of [short, medium, long]) {
      ws.send(JSON.stringify({ type: 'echo', text: t }));
      await until(() => echoes().includes(t), `回显 ${t.length} 字`);
    }
    assert.deepEqual(echoes(), [short, medium, long]);

    const mid = await stats();
    assert.equal(mid.ws_open, before.ws_open + 1);
    assert.ok(mid.ws_received >= before.ws_received + 3);
    await new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve());
      ws.close(1000, 'bye');
    });
    const end = await stats();
    assert.equal(end.ws_open, before.ws_open, '关闭后服务端停止推送并释放连接');
  });

  test('页面每秒轮询一次，WebSocket 持续推送', async () => {
    const pageId = await env.open('/polling/');
    const page = env.session.pages.get(pageId);
    const s0 = await stats();
    await page.waitForFunction(
      () => {
        const st = (window as unknown as { fixtureState: PageState }).fixtureState;
        return st.polls >= 2 && st.pushes >= 5 && st.wsOpen;
      },
      { timeout: 5000 },
    );
    const s1 = await stats();
    assert.ok(s1.ticks >= s0.ticks + 1, `服务端收到轮询：${s0.ticks} → ${s1.ticks}`);
    assert.ok(s1.ws_sent > s0.ws_sent, '服务端在推送');
    assert.match(await text(pageId, '#feed'), /#\d+ 报价 \d+\.\d/);
    assert.equal(await text(pageId, '#ws-status'), '已连接');
    await page.close();
  });

  test('请求一直挂着（网络永不空闲）时，点击与填写仍在远小于 5 秒内返回', async () => {
    // hold=2500：每次轮询 2.5 秒才返回，每秒发一次 → 任何时刻都有请求在进行；WebSocket 每 200 毫秒推送
    const pageId = await env.open('/polling/?hold=2500');
    const page = env.session.pages.get(pageId);
    await page.waitForFunction(
      () => {
        const st = (window as unknown as { fixtureState: PageState }).fixtureState;
        return st.wsOpen && st.pushes >= 3 && st.inflight >= 2;
      },
      { timeout: 5000 },
    );
    const st0 = await pageState(pageId);
    const t0 = Date.now();
    const durations: Record<string, number> = {};

    const r1 = await ok({ op: 'click', pageId, target: { role: 'button', name: '保存草稿' } });
    durations.click = r1.duration_ms;
    assert.equal(await text(pageId, '#saved'), '已保存 1 次', '点击已生效');

    const r2 = await ok({
      op: 'fill',
      pageId,
      target: { role: 'textbox', name: '标题' },
      value: '巡检',
    });
    durations.fill = r2.duration_ms;
    const r3 = await ok({ op: 'fill', pageId, target: { css: '#note' }, value: '机房 A' });
    durations.fill2 = r3.duration_ms;
    const r4 = await ok({
      op: 'fill',
      pageId,
      target: { role: 'combobox', name: '优先级' },
      value: '高',
    });
    durations.select = r4.duration_ms;
    const r5 = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '提交' },
      post: [{ text_present: '已提交：标题=巡检' }],
    });
    durations.submit = r5.duration_ms;
    assert.equal(r5.assertions?.[0]?.pass, true);
    assert.equal(await text(pageId, '#result'), '已提交：标题=巡检，备注=机房 A，优先级=高');

    const total = Date.now() - t0;
    console.log(`常驻请求下各动作耗时（毫秒）：${JSON.stringify(durations)}，合计 ${total}`);
    for (const [k, ms] of Object.entries(durations)) {
      assert.ok(ms < FAST_MS, `${k} 耗时 ${ms} 毫秒，应远小于 5 秒上限`);
    }
    assert.ok(total < 5000, `五个动作合计 ${total} 毫秒`);

    const st1 = await pageState(pageId);
    assert.ok(st1.inflight >= 1, '动作结束时仍有轮询请求挂着：没有等网络空闲');
    assert.ok(st1.pushes > st0.pushes, `动作期间推送仍在继续：${st0.pushes} → ${st1.pushes}`);
    await page.close();
  });

  test('WebSocket 往返：点击发送，后置检查等到服务器回显即返回', async () => {
    const pageId = await env.open('/polling/');
    const page = env.session.pages.get(pageId);
    await page.waitForFunction(
      () => (window as unknown as { fixtureState: PageState }).fixtureState.wsOpen,
      { timeout: 5000 },
    );
    await ok({ op: 'fill', pageId, target: { css: '#title' }, value: '你好，服务器' });
    const r = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '发送到服务器' },
      post: [{ text_present: '服务器回显：你好，服务器' }],
    });
    console.log(`WebSocket 往返点击耗时 ${r.duration_ms} 毫秒`);
    assert.equal(r.assertions?.[0]?.pass, true);
    assert.ok(r.duration_ms < FAST_MS, `耗时 ${r.duration_ms}`);
    await page.close();
  });
});
