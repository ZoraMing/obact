// 格式化数字夹具（PRD 9.3，FR-09、FR-10）：页面显示千分位与“万/亿”，接口返回原始值，两者可按换算函数一一对应。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { observe } from '@obact/core';
import { Contracts } from '@obact/schemas';
import {
  type Daily,
  dataFor,
  formatValue,
  type Kpi,
  type NumberFormat,
  parseDisplay,
} from '../api/formatted-numbers.ts';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
type Data = { seed: number; kpis: Kpi[]; daily: Daily[] };

/** 显示值与原始值对应：差不超过显示精度的一半（加浮点误差）。 */
function assertMatches(display: string, raw: number, what: string): void {
  const p = parseDisplay(display);
  assert.ok(p, `${what}：无法解析显示值 ${display}`);
  const tol = p.step / 2 + 1e-9 * Math.max(1, Math.abs(raw));
  assert.ok(
    Math.abs(p.value - raw) <= tol,
    `${what}：显示 ${display} → ${p.value}，原始值 ${raw}，允许误差 ${tol}`,
  );
}

describe('格式化数字夹具（FR-09、FR-10）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  /** 打开页面并截获页面自己请求的数据接口响应（原始值）。 */
  async function openWithResponse(seed: number): Promise<{ pageId: string; data: Data }> {
    const pageId = await env.session.pages.newPage();
    const page = env.session.pages.get(pageId);
    const resp = page.waitForResponse((r) => r.url().includes('/api/formatted-numbers/data'));
    await page.goto(`${env.server.base}/formatted-numbers/?seed=${seed}`, { waitUntil: 'load' });
    const data = (await (await resp).json()) as Data;
    await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 5000 });
    return { pageId, data };
  }

  test('text_md 里是页面的显示值（千分位、万、亿、百分比），不是原始值', async () => {
    const { pageId, data } = await openWithResponse(1);
    const ob = await observe(env.session, { pageId });
    contracts.assert('observe.Result', ob);
    for (const want of ['1,234,567.89', '1.2万', '3.4亿']) {
      assert.ok(ob.text_md.includes(want), `缺少典型显示值 ${want}`);
    }
    const page = env.session.pages.get(pageId);
    const cards = await page.$$eval('.kpi', (els) =>
      els.map((e) => ({
        key: (e as HTMLElement).dataset.key,
        value: e.querySelector('.value')?.textContent ?? '',
      })),
    );
    for (const k of data.kpis) {
      const display = formatValue(k.value, k.format);
      assert.equal(cards.find((c) => c.key === k.key)?.value, display, `${k.label} 页面格式化`);
      assert.ok(ob.text_md.includes(display), `${k.label} 的显示值 ${display} 不在 text_md 中`);
    }
    // 原始值（不带千分位或单位的形式）不出现在页面上
    const revenue = data.kpis.find((k) => k.key === 'revenue') as Kpi;
    assert.ok(!ob.text_md.includes(String(revenue.value)));
    const pv = data.kpis.find((k) => k.key === 'pv') as Kpi;
    assert.ok(!ob.text_md.includes(String(pv.value)));
  });

  test('从 text_md 抽取的显示值与接口原始值一一对应（换算函数 parseDisplay）', async () => {
    const { pageId, data } = await openWithResponse(3);
    const ob = await observe(env.session, { pageId });

    // 指标卡：text_md 中所有能解析成数值的片段，与指标原始值一一对应
    const tokens = ob.text_md
      .split(/[\s|]+/)
      .map((t) => ({ t, p: parseDisplay(t) }))
      .filter((x) => x.p);
    for (const k of data.kpis) {
      const display = formatValue(k.value, k.format);
      const hit = tokens.find((x) => x.t === display);
      assert.ok(hit, `${k.label}：text_md 中找不到 ${display}`);
      assertMatches(hit.t, k.value, k.label);
    }

    // 表格：按日期找到 Markdown 行，逐列换算后与接口的原始值比对
    const lines = ob.text_md.split('\n');
    const cols: [keyof Daily, NumberFormat][] = [
      ['sales', 'thousands'],
      ['visitors', 'cn'],
      ['conversion', 'percent'],
    ];
    for (const d of data.daily) {
      const line = lines.find((l) => l.startsWith(`| ${d.date} |`));
      assert.ok(line, `表格缺少 ${d.date}`);
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      assert.equal(cells.length, 4, line);
      cols.forEach(([key, format], i) => {
        const shown = cells[i + 1] as string;
        assert.equal(shown, formatValue(d[key] as number, format), `${d.date} ${key}`);
        assertMatches(shown, d[key] as number, `${d.date} ${key}`);
      });
    }
  });

  test('接口：原始数值、同一 seed 结果相同、不同 seed 不同', async () => {
    const get = async (q: string) => {
      const r = await fetch(`${env.server.base}/api/formatted-numbers/data?${q}`);
      return { status: r.status, body: (await r.json()) as Data };
    };
    const a = await get('seed=5');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, (await get('seed=5')).body);
    assert.deepEqual(a.body, dataFor(5));
    assert.notDeepEqual(a.body.kpis, (await get('seed=6')).body.kpis);
    for (const k of a.body.kpis) assert.equal(typeof k.value, 'number', `${k.key} 是原始数值`);
    assert.equal((await get('seed=x')).status, 400);
  });

  test('换算函数：典型写法、边界与往返', () => {
    const cases: [string, number, number][] = [
      ['1,234,567.89', 1234567.89, 0.01],
      ['-37,316.50', -37316.5, 0.01],
      ['3,270', 3270, 1],
      ['1.2万', 12000, 1000],
      ['3.4亿', 340000000, 10000000],
      ['19.3亿', 1930000000, 10000000],
      ['12.5%', 0.125, 0.001],
    ];
    for (const [text, value, step] of cases) {
      const p = parseDisplay(text);
      assert.ok(p, text);
      assert.ok(Math.abs(p.value - value) < 1e-6 * Math.max(1, value), `${text} → ${p.value}`);
      assert.ok(Math.abs(p.step - step) < 1e-12 * Math.max(1, step), `${text} 精度 ${p.step}`);
    }
    for (const bad of ['', 'abc', '1,23,4', '12.3.4', '万'])
      assert.equal(parseDisplay(bad), null, bad);

    assert.equal(formatValue(9999, 'cn'), '9,999');
    assert.equal(formatValue(12345, 'cn'), '1.2万');
    assert.equal(formatValue(-12345, 'cn'), '-1.2万');
    assert.equal(formatValue(99_949_999, 'cn'), '9995.0万');
    assert.equal(formatValue(99_999_999, 'cn'), '1.0亿', '进位到 1 万万时改用亿');
    assert.equal(formatValue(340_123_456, 'cn'), '3.4亿');
    assert.equal(formatValue(1234567.891, 'thousands'), '1,234,567.89');
    assert.equal(formatValue(0.1234, 'percent'), '12.3%');

    // 往返：多个 seed 的全部数值，显示值都能换算回原始值
    for (let seed = 1; seed <= 20; seed++) {
      const d = dataFor(seed);
      for (const k of d.kpis)
        assertMatches(formatValue(k.value, k.format), k.value, `${seed}/${k.key}`);
      for (const row of d.daily) {
        assertMatches(formatValue(row.sales, 'thousands'), row.sales, `${seed}/${row.date}/sales`);
        assertMatches(
          formatValue(row.visitors, 'cn'),
          row.visitors,
          `${seed}/${row.date}/visitors`,
        );
        assertMatches(
          formatValue(row.conversion, 'percent'),
          row.conversion,
          `${seed}/${row.date}/conversion`,
        );
      }
    }
  });
});
