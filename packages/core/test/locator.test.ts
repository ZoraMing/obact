import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Locator } from '@obact/schemas';
import {
  generateLocator,
  locatorAtPoint,
  markPage,
  resolveLocator,
  resolveRef,
  type Session,
} from '../src/index.ts';
import { rejectsWithCode, SKIP, setup, type TestEnv } from './helpers.ts';

/** 页面上所有编号及其 data-k（测试用的身份标记）。 */
async function refsByKey(s: Session, pageId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const f of await markPage(s, pageId)) {
    for (const ref of f.refs) {
      const r = await resolveRef(s, pageId, ref);
      const k = await r.handle.evaluate((el) => el.getAttribute('data-k'));
      await r.handle.dispose();
      if (k) out.set(k, ref);
    }
  }
  return out;
}

async function keyOf(s: Session, pageId: string, loc: Locator): Promise<string | null> {
  const r = await resolveLocator(s, pageId, loc);
  const k = await r.handle.evaluate((el) => el.getAttribute('data-k'));
  await r.handle.dispose();
  return k;
}

async function waitFrames(env: TestEnv, pageId: string): Promise<void> {
  const page = env.session.pages.get(pageId);
  await page.waitForFrame((f) => f.url().startsWith(env.server.crossBase));
  await page.waitForFunction(() => document.querySelector('closed-box') !== null);
}

describe('定位器生成（FR-07、FR-32）', { skip: SKIP }, () => {
  let env: TestEnv;
  before(async () => {
    env = await setup();
  });
  after(async () => {
    await env?.close();
  });

  test('往返：每个元素生成的定位器都解析回它自己，且不含动态 id 与哈希类名', async () => {
    const pageId = await env.open('/pages/locator-dynamic.html');
    await waitFrames(env, pageId);
    const s = env.session;
    const refs = await refsByKey(s, pageId);
    const expected = [
      'query',
      'keyword',
      'refresh',
      'help',
      'custom',
      'status',
      'audit-1',
      'audit-2',
      'open-btn',
      'closed-btn',
      'frame-email',
      'frame-send',
    ];
    for (const k of expected) {
      const ref = refs.get(k);
      assert.ok(ref, `缺少编号：${k}`);
      const { locator, unique } = await generateLocator(s, pageId, ref);
      assert.ok(unique, `${k} 应唯一：${JSON.stringify(locator)}`);
      assert.equal(await keyOf(s, pageId, locator), k, `${k} 往返：${JSON.stringify(locator)}`);
      const text = JSON.stringify(locator);
      assert.doesNotMatch(
        text,
        /css-[a-z0-9]{5}|btn-|in-[a-z0-9]|"x[a-z0-9]{6}/,
        `${k} 含动态值：${text}`,
      );
    }
  });

  test('优先级、within、frame 链与类型', async () => {
    const pageId = await env.open('/pages/locator-dynamic.html');
    await waitFrames(env, pageId);
    const s = env.session;
    const refs = await refsByKey(s, pageId);
    const gen = async (k: string) =>
      (await generateLocator(s, pageId, refs.get(k) as number)).locator;

    assert.equal((await gen('query')).css, '[data-testid="query"]', 'data-testid 优先');
    assert.equal((await gen('keyword')).css, 'input[name="keyword"]');
    assert.equal((await gen('refresh')).css, 'button[aria-label="刷新"]');
    assert.equal((await gen('help')).css, 'a[href="/help/orders"]');
    const custom = await gen('custom');
    assert.equal(custom.css, undefined, '只有哈希类名时不给 CSS');
    assert.deepEqual([custom.role, custom.name], ['button', '自绘提交']);

    const audit = await gen('audit-2');
    assert.equal(audit.within, "tr[data-id='88232']", '同名按钮靠所在行消歧');
    assert.deepEqual([audit.role, audit.name], ['button', '审核']);

    // 两个 iframe 加载同一页面，refsByKey 取到的是后一个（跨域）；两种稳定选择器都可以
    const chain = (await gen('frame-email')).frame ?? [];
    assert.equal(chain.length, 1);
    assert.match(chain[0] as string, /^iframe\[(id="xo"|title="内嵌表单")\]$/);
  });

  test('封闭 Shadow DOM：没先 observe 也能按角色+名称、CSS 定位（回放定位器时页面不一定观察过）', async () => {
    const pageId = await env.open('/pages/basic.html');
    await env.session.pages
      .get(pageId)
      .waitForFunction(() => !!customElements.get('closed-widget'));
    for (const loc of [
      { role: 'button', name: '封闭按钮' },
      { css: 'button.sh-closed' },
    ] as Locator[]) {
      const r = await resolveLocator(env.session, pageId, loc);
      assert.equal(await r.handle.evaluate((el) => el.textContent), '封闭按钮');
      await r.handle.dispose();
    }
    // 真的不存在的元素照样报 not_found
    await rejectsWithCode(
      resolveLocator(env.session, pageId, { role: 'button', name: '不存在' }),
      'not_found',
    );
  });

  test('无法唯一时 unique=false', async () => {
    const pageId = await env.open('/pages/locator-dynamic.html');
    const refs = await refsByKey(env.session, pageId);
    const r = await generateLocator(env.session, pageId, refs.get('twin-2') as number);
    assert.equal(r.unique, false);
  });

  test('刷新后（id 与类名全变）原定位器仍解析到等价元素', async () => {
    const pageId = await env.open('/pages/locator-dynamic.html');
    await waitFrames(env, pageId);
    const s = env.session;
    const refs = await refsByKey(s, pageId);
    const keys = [
      'query',
      'keyword',
      'refresh',
      'help',
      'custom',
      'audit-1',
      'audit-2',
      'open-btn',
      'frame-email',
    ];
    const locs = new Map<string, Locator>();
    for (const k of keys)
      locs.set(k, (await generateLocator(s, pageId, refs.get(k) as number)).locator);
    const page = s.pages.get(pageId);
    await page.reload({ waitUntil: 'load' });
    await waitFrames(env, pageId);
    for (const [k, loc] of locs) assert.equal(await keyOf(s, pageId, loc), k, `刷新后 ${k}`);
  });

  test('改版变体：能解析时必须正确，不能时报错，绝不命中错误元素', async () => {
    const s = env.session;
    const base = await env.open('/pages/locator-redesign-v0.html');
    const refs = await refsByKey(s, base);
    const save = (await generateLocator(s, base, refs.get('save') as number)).locator;
    assert.ok(save.css && save.role, `两类都有：${JSON.stringify(save)}`);

    const expect: Record<string, string | null> = {
      v1: 'save', // 改 id：CSS 失效，角色+名称 兜底
      v2: 'save', // 改文案：CSS 仍有效
      v3: 'save', // 改层级
      v4: 'save', // 移动位置
      v5: null, // id 与文案都改：找不到
      v6: null, // id 被挪到另一个按钮：两类指向不同元素，报错
    };
    for (const [v, want] of Object.entries(expect)) {
      const pageId = await env.open(`/pages/locator-redesign-${v}.html`);
      if (want) assert.equal(await keyOf(s, pageId, save), want, v);
      else {
        const err = await resolveLocator(s, pageId, save).then(
          () => null,
          (e: { code: string }) => e.code,
        );
        assert.ok(err === 'not_found' || err === 'not_unique', `${v} 应报错，实际 ${err}`);
      }
    }
  });

  test('组件陈列页：全部编号往返，唯一的必须解析回自己', async () => {
    const pageId = await env.open('/pages/components.html');
    const s = env.session;
    const frames = await markPage(s, pageId);
    let total = 0;
    let unique = 0;
    const wrong: string[] = [];
    for (const ref of frames.flatMap((f) => f.refs)) {
      total++;
      const r = await generateLocator(s, pageId, ref);
      if (!r.unique) continue;
      unique++;
      const back = await resolveLocator(s, pageId, r.locator);
      const orig = await resolveRef(s, pageId, ref);
      if (!(await orig.handle.evaluate((a, b) => a === b, back.handle))) {
        wrong.push(JSON.stringify(r.locator));
      }
    }
    console.log(`组件陈列页：${unique}/${total} 个元素生成了唯一定位器`);
    assert.deepEqual(wrong, []);
    assert.ok(unique / total >= 0.9, `唯一率 ${unique}/${total}`);
  });

  test('坐标换算成定位器（含 iframe 内）', async () => {
    const pageId = await env.open('/pages/locator-dynamic.html');
    await waitFrames(env, pageId);
    const s = env.session;
    const page = s.pages.get(pageId);
    const box = await (await page.$('[data-k=audit-1]'))?.boundingBox();
    assert.ok(box);
    const at = await locatorAtPoint(s, pageId, box.x + box.width / 2, box.y + box.height / 2);
    assert.ok(at?.unique);
    assert.equal(at.role, 'button');
    assert.equal(await keyOf(s, pageId, at.locator), 'audit-1');

    const frameEl = await page.$('iframe[title="内嵌表单"]');
    const frame = await frameEl?.contentFrame();
    const sendBox = await (await frame?.$('[data-k=frame-send]'))?.boundingBox();
    assert.ok(sendBox);
    const inFrame = await locatorAtPoint(s, pageId, sendBox.x + 2, sendBox.y + 2);
    assert.equal(await keyOf(s, pageId, inFrame?.locator as Locator), 'frame-send');

    await rejectsWithCode(locatorAtPoint(s, pageId, Number.NaN, 0), 'invalid_params');
  });
});
