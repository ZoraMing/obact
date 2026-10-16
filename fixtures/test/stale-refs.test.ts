// 夹具：失效编号（FR-06）。观察之后整块重绘的列表：旧编号报 stale_ref，绝不点到新节点；编号不复用。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { act, generateLocator, observe } from '@obact/core';
import type { Action, ActResult, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type FixtureEnv, SKIP, setup } from './helpers.ts';

const contracts = new Contracts();
type LogEntry = { op: string; id: string };

/** 列表内按钮的编号：键为 “处理:T-2” 这样的 操作:工单号。 */
function listRefs(ob: ObserveResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of ob.elements) {
    const id = /T-\d/.exec(e.within ?? '')?.[0];
    if (id) out.set(`${e.name}:${id}`, e.ref);
  }
  return out;
}

describe('夹具 stale-refs（FR-06）', { skip: SKIP }, () => {
  let env: FixtureEnv;
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
  /** 用编号点击，必须报 stale_ref，且立即返回（不轮询）。 */
  async function stale(pageId: string, ref: number): Promise<void> {
    const r = await run({ op: 'click', pageId, target: { ref } });
    assert.equal(r.status, 'error', `编号 ${ref} 应失效`);
    assert.equal(r.error?.code, 'stale_ref', r.error?.message);
    assert.ok(r.duration_ms < 2000, `失效编号应立即报错（${r.duration_ms} 毫秒）`);
  }
  const page = (pageId: string) => env.session.pages.get(pageId);
  const log = (pageId: string) =>
    page(pageId).evaluate(() => (window as unknown as { __log: LogEntry[] }).__log);
  const rerender = (pageId: string, name: string, n: number) =>
    ok({
      op: 'click',
      pageId,
      target: { role: 'button', name },
      post: [{ text_present: `已重绘 ${n} 次` }],
    });

  test('模板重建：旧编号全部 stale_ref；重新观察后新编号可用且不复用', async () => {
    const pageId = await env.open('/stale-refs/');
    const first = await observe(env.session, { pageId });
    const old = listRefs(first);
    assert.equal(old.size, 8, '4 行 × 2 个按钮');
    await rerender(pageId, '重新渲染（模板）', 1);
    for (const ref of old.values()) await stale(pageId, ref);
    assert.deepEqual(await log(pageId), [], '没有点到任何新节点');

    const second = await observe(env.session, { pageId });
    const fresh = listRefs(second);
    assert.equal(fresh.size, 8);
    const maxOld = Math.max(...first.elements.map((e) => e.ref));
    for (const [k, ref] of fresh) {
      assert.ok(ref > maxOld, `${k} 的新编号 ${ref} 应大于旧编号 ${maxOld}`);
    }
    // 工具栏按钮没被重绘，编号不变
    const toolbar = (ob: ObserveResult) =>
      ob.elements.filter((e) => e.name.startsWith('重新渲染')).map((e) => e.ref);
    assert.deepEqual(toolbar(second), toolbar(first));

    await ok({ op: 'click', pageId, target: { ref: fresh.get('处理:T-3') as number } });
    assert.deepEqual(await log(pageId), [{ op: '处理', id: 'T-3' }]);
    // 重新观察之后，旧编号依然失效（不会被重新分配给新节点）
    await stale(pageId, old.get('处理:T-3') as number);
    await assert.rejects(
      generateLocator(env.session, pageId, old.get('转派:T-1') as number),
      (e: { code?: string }) => e.code === 'stale_ref',
    );
    await run({ op: 'close_page', pageId });
  });

  test('原样替换 innerHTML：新节点带着同样的 data-obact-ref 属性，仍判为失效', async () => {
    const pageId = await env.open('/stale-refs/');
    const old = listRefs(await observe(env.session, { pageId }));
    const ref = old.get('处理:T-2') as number;
    await rerender(pageId, '重新渲染（原样替换）', 1);
    const copies = await page(pageId).$$eval(`[data-obact-ref="${ref}"]`, (els) =>
      els.map((e) => e.textContent),
    );
    assert.deepEqual(copies, ['处理'], '克隆出的新节点带着旧编号属性');
    for (const r of old.values()) await stale(pageId, r);
    assert.deepEqual(await log(pageId), []);

    const fresh = listRefs(await observe(env.session, { pageId }));
    const now = fresh.get('处理:T-2') as number;
    assert.ok(now > Math.max(...old.values()));
    assert.equal(
      await page(pageId).$eval('li[data-id="T-2"] button', (e) => e.getAttribute('data-obact-ref')),
      String(now),
      '重新观察后属性改成新编号',
    );
    await ok({ op: 'click', pageId, target: { ref: now } });
    assert.deepEqual(await log(pageId), [{ op: '处理', id: 'T-2' }]);
    await run({ op: 'close_page', pageId });
  });

  test('只重绘一行：其余行的编号仍有效，被重绘那行的编号失效', async () => {
    const pageId = await env.open('/stale-refs/');
    const old = listRefs(await observe(env.session, { pageId }));
    await rerender(pageId, '只重绘第 2 行', 1);
    await stale(pageId, old.get('处理:T-2') as number);
    await stale(pageId, old.get('转派:T-2') as number);
    await ok({ op: 'click', pageId, target: { ref: old.get('处理:T-1') as number } });
    await ok({ op: 'click', pageId, target: { ref: old.get('转派:T-3') as number } });
    assert.deepEqual(await log(pageId), [
      { op: '处理', id: 'T-1' },
      { op: '转派', id: 'T-3' },
    ]);
    await run({ op: 'close_page', pageId });
  });

  test('节点只是移动（倒序）：编号绑定节点，仍点中原来的工单', async () => {
    const pageId = await env.open('/stale-refs/');
    const old = listRefs(await observe(env.session, { pageId }));
    await ok({ op: 'click', pageId, target: { role: 'button', name: '倒序排列' } });
    assert.equal(
      await page(pageId).$eval('#list li', (e) => (e as HTMLElement).dataset.id),
      'T-4',
      '已倒序',
    );
    await ok({ op: 'click', pageId, target: { ref: old.get('转派:T-4') as number } });
    await ok({ op: 'click', pageId, target: { ref: old.get('处理:T-1') as number } });
    assert.deepEqual(await log(pageId), [
      { op: '转派', id: 'T-4' },
      { op: '处理', id: 'T-1' },
    ]);
    await run({ op: 'close_page', pageId });
  });

  test('动作进行中（鼠标移上去时）整块重绘：报 stale_ref，不派发点击', async () => {
    const pageId = await env.open('/stale-refs/?rerender=hover');
    const old = listRefs(await observe(env.session, { pageId }));
    await stale(pageId, old.get('处理:T-3') as number);
    assert.equal(
      await page(pageId).evaluate(() => (window as unknown as { __renders: number }).__renders),
      1,
      '悬停触发了重绘',
    );
    assert.deepEqual(await log(pageId), [], '重绘后的新节点没有被点到');
    const fresh = listRefs(await observe(env.session, { pageId }));
    await ok({ op: 'click', pageId, target: { ref: fresh.get('处理:T-3') as number } });
    assert.deepEqual(await log(pageId), [{ op: '处理', id: 'T-3' }]);
    await run({ op: 'close_page', pageId });
  });
});
