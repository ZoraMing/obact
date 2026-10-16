// 夹具：改版变体（FR-07、FR-20、BW-6）。在原版上生成定位器，到各改版上解析与回放：
// 要么命中语义相同的元素，要么报 not_found / not_unique（转人工），误点必须为 0。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, observe, resolveLocator, resolveRef } from '@obact/core';
import type { Action, ActResult, Locator } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
type Outcome = 'hit' | 'manual' | 'wrong';
type Event = { type: string; key: string | null; tag: string };

/** 原版上的全部可操作元素（data-x-key）。 */
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

/** 各改版的期望结果：未列出的元素期望命中（hit）。 */
const EXPECT: Record<string, Record<string, Outcome>> = {
  v1: {}, // 改 id：CSS 失效，角色+名称 兜底
  v2: {}, // 改文案：角色+名称 失效，CSS 兜底
  v3: {}, // 改层级：两类都还有效
  v4: {
    // 工具栏 id 按位置编号，换顺序后 CSS 指向别的按钮：冲突转人工
    create: 'manual',
    import: 'manual',
    export: 'manual',
    // 无名关闭图标挪出了提示条容器，容器里只剩“查看详情”：不能退而点它
    'notice-close': 'manual',
  },
  v5: { customer: 'manual', phone: 'manual', save: 'manual', cancel: 'manual' }, // id 互换：冲突
  v6: Object.fromEntries(KEYS.map((k) => [k, 'manual'])), // 全面改版：两类都失效
};
/** 期望报“冲突”（CSS 与 角色+名称 指向不同元素）的元素。 */
const CONFLICTS: Record<string, string[]> = {
  v4: ['create', 'import', 'export'],
  v5: ['customer', 'phone', 'save', 'cancel'],
};
const expected = (v: string, k: string): Outcome => EXPECT[v]?.[k] ?? 'hit';

describe('夹具 redesign（FR-07、FR-20、BW-6）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  /** 原版上录制的定位器：data-x-key → 定位器。 */
  const recorded = new Map<string, Locator>();
  /** 原版上各元素的角色（决定回放用什么动作）。 */
  const roles = new Map<string, string>();

  before(async () => {
    env = await setup();
    const pageId = await env.open('/redesign/v0.html');
    const ob = await observe(env.session, { pageId });
    for (const e of ob.elements) {
      const r = await resolveRef(env.session, pageId, e.ref);
      const key = await r.handle.evaluate((el) => el.getAttribute('data-x-key'));
      await r.handle.dispose();
      if (!key) continue;
      const g = await generateLocator(env.session, pageId, e.ref);
      assert.ok(g.unique, `${key} 在原版上应能生成唯一定位器：${JSON.stringify(g.locator)}`);
      recorded.set(key, g.locator);
      roles.set(key, e.role);
    }
    await env.session.pages.get(pageId).close();
  });
  after(async () => {
    await env?.close();
  });

  test('原版：全部元素生成两类定位器，往返解析回自己', async () => {
    assert.deepEqual([...recorded.keys()].sort(), [...KEYS].sort());
    const pageId = await env.open('/redesign/v0.html');
    for (const [key, loc] of recorded) {
      if (key !== 'close' && key !== 'notice-close') {
        assert.ok(loc.css && loc.role && loc.name, `${key} 两类都有：${JSON.stringify(loc)}`);
      }
      const r = await resolveLocator(env.session, pageId, loc);
      assert.equal(await r.handle.evaluate((el) => el.getAttribute('data-x-key')), key);
      await r.handle.dispose();
    }
    assert.match(recorded.get('remove-apple')?.within ?? '', /sku-apple/, '同名按钮按行消歧');
    await env.session.pages.get(pageId).close();
  });

  test('解析：各改版上要么命中同一元素，要么转人工，误点为 0', async (t) => {
    const wrong: string[] = [];
    const mismatch: string[] = [];
    for (const v of Object.keys(EXPECT)) {
      const pageId = await env.open(`/redesign/${v}.html`);
      const tally: Record<Outcome, string[]> = { hit: [], manual: [], wrong: [] };
      for (const [key, loc] of recorded) {
        let outcome: Outcome;
        try {
          const r = await resolveLocator(env.session, pageId, loc);
          const got = await r.handle.evaluate((el) => el.getAttribute('data-x-key'));
          await r.handle.dispose();
          outcome = got === key ? 'hit' : 'wrong';
          if (outcome === 'wrong') wrong.push(`${v} ${key} → 命中了 ${got}（${r.via}）`);
        } catch (e) {
          const err = e as { code?: string; details?: { conflict?: boolean } };
          assert.ok(
            err.code === 'not_found' || err.code === 'not_unique',
            `${v} ${key}：意外的错误 ${err.code}`,
          );
          outcome = 'manual';
          if (CONFLICTS[v]?.includes(key)) {
            assert.equal(err.details?.conflict, true, `${v} ${key} 应报冲突`);
          }
        }
        tally[outcome].push(key);
        if (outcome !== expected(v, key)) {
          mismatch.push(`${v} ${key}：期望 ${expected(v, key)}，实际 ${outcome}`);
        }
      }
      t.diagnostic(
        `${v}：命中 ${tally.hit.length}，转人工 ${tally.manual.length}（${tally.manual.join('、')}），误点 ${tally.wrong.length}`,
      );
      await env.session.pages.get(pageId).close();
    }
    assert.deepEqual(wrong, [], '误点必须为 0');
    assert.deepEqual(mismatch, []);
  });

  test('回放动作：点中的就是同一元素；转人工时页面上没有任何事件', async (t) => {
    const wrong: string[] = [];
    const mismatch: string[] = [];
    for (const v of Object.keys(EXPECT)) {
      const pageId = await env.open(`/redesign/${v}.html`);
      const page = env.session.pages.get(pageId);
      const tally: Record<Outcome, number> = { hit: 0, manual: 0, wrong: 0 };
      for (const [key, target] of recorded) {
        const role = roles.get(key) as string;
        const base = { pageId, target, timeout_ms: 400 };
        const action: Action =
          role === 'textbox' || role === 'searchbox'
            ? { op: 'fill', ...base, value: `值-${key}` }
            : role === 'combobox'
              ? { op: 'fill', ...base, value: '已发货' }
              : { op: 'click', ...base };
        const r: ActResult = await act(env.session, action);
        contracts.assert('act-result', r);
        const events = await page.evaluate(() =>
          (window as unknown as { __events: Event[] }).__events.splice(0),
        );
        let outcome: Outcome;
        if (r.status === 'ok') {
          const others = events.filter((e) => e.key !== key);
          outcome = events.some((e) => e.key === key) && others.length === 0 ? 'hit' : 'wrong';
          if (outcome === 'wrong') {
            wrong.push(
              `${v} ${key} → 事件落在 ${others.map((e) => `${e.type}:${e.key ?? e.tag}`).join('、') || '（无事件）'}`,
            );
          }
        } else {
          assert.ok(
            r.error?.code === 'not_found' || r.error?.code === 'not_unique',
            `${v} ${key}：意外的错误 ${r.error?.code} ${r.error?.message}`,
          );
          assert.deepEqual(events, [], `${v} ${key} 转人工时不应有任何事件`);
          outcome = 'manual';
        }
        tally[outcome]++;
        if (outcome !== expected(v, key)) {
          mismatch.push(`${v} ${key}：期望 ${expected(v, key)}，实际 ${outcome}`);
        }
      }
      t.diagnostic(`${v}：命中 ${tally.hit}，转人工 ${tally.manual}，误点 ${tally.wrong}`);
      await page.close();
    }
    assert.deepEqual(wrong, [], '误点必须为 0');
    assert.deepEqual(mismatch, []);
  });
});
