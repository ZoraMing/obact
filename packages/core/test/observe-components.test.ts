// observe 组件陈列验收（用户重点）：可操作功能与纯网页信息的区分、每个元素的可用操作。
// observe 合并后移到 packages/core/test/observe-components.test.ts。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { observe } from '../src/index.ts';
import { bundle } from '../src/page/bundle.ts';
import { DOM_LIB } from '../src/page/dom.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

type Expect = {
  ref: number;
  label: string;
  role: string;
  name: string;
  actions: string[];
  options: number | null;
  hint: string | null;
};

const EXPECTS = bundle((attr: string) => {
  return [...document.querySelectorAll('[data-x-actions]')].map((el) => ({
    ref: Number(el.getAttribute(attr)),
    label: `${el.closest('section')?.id}/${el.getAttribute('data-x-name')}`,
    role: el.getAttribute('data-x-role') ?? '',
    name: el.getAttribute('data-x-name') ?? '',
    actions: (el.getAttribute('data-x-actions') ?? '').split(',').filter(Boolean),
    options: el.hasAttribute('data-x-options') ? Number(el.getAttribute('data-x-options')) : null,
    hint: el.getAttribute('data-x-hint'),
  }));
}, DOM_LIB);

describe('observe：组件陈列验收', { skip: SKIP }, () => {
  let env: TestEnv;
  let r: ObserveResult;
  let pageId = '';
  let expects: Expect[] = [];

  before(async () => {
    env = await setup();
    pageId = await env.open('/pages/components.html');
    r = await observe(env.session, { pageId, views: ['text'] });
    expects = await env.session.pages.get(pageId).evaluate(EXPECTS, env.session.attr);
  });
  after(async () => {
    await env?.close();
  });

  test('返回值符合契约', () => {
    new Contracts().assert('observe.Result', r);
    assert.equal(r.truncated, false);
    assert.equal(r.canvas_warning, false);
  });

  test('每个组件都在可操作功能里，角色、名称、可用操作、选项、提示正确', () => {
    const byRef = new Map(r.elements.map((e) => [e.ref, e]));
    const problems: string[] = [];
    for (const x of expects) {
      const e = byRef.get(x.ref);
      if (!e) {
        problems.push(`${x.label}: 不在 elements 中`);
        continue;
      }
      if (e.role !== x.role || e.name !== x.name)
        problems.push(`${x.label}: ${e.role} "${e.name}"`);
      if ([...e.actions].sort().join() !== [...x.actions].sort().join()) {
        problems.push(`${x.label}: actions=${e.actions.join(',')}`);
      }
      if (x.options !== null && e.options?.length !== x.options) {
        problems.push(`${x.label}: options=${e.options?.length}`);
      }
      if (x.hint !== null && e.hint !== x.hint) problems.push(`${x.label}: hint=${e.hint}`);
    }
    assert.deepEqual(problems, []);
  });

  test('snapshot_text 每个元素一行，带可用操作', () => {
    for (const e of r.elements) {
      const line = (r.snapshot_text ?? '').split('\n').find((l) => l.startsWith(`[${e.ref}] `));
      assert.ok(line, `缺少 [${e.ref}]`);
      // 操作列表在最后一个“ → ”之后；整段精确比较，名称里出现操作名不算
      assert.equal(
        line.slice(line.lastIndexOf(' → ') + 3),
        e.actions.join(','),
        `[${e.ref}] 行：${line}`,
      );
    }
  });

  test('透明的原生控件（没有可见 label）：act 按命中测试操作，observe 照普通控件列为可点击，不标 transparent；有 label 代点的仍可点击', async () => {
    // 陈列页比视口长：先滚到这些控件处，不在视口内的元素只显示 offscreen
    await env.session.pages
      .get(pageId)
      .evaluate(() => document.querySelector('.bare')?.scrollIntoView());
    const seen = await observe(env.session, { pageId });
    const bare = seen.elements.find((e) => e.name === '选择此行');
    assert.ok(bare);
    assert.equal(bare.clickable, true);
    const line = (seen.snapshot_text ?? '').split('\n').find((l) => l.startsWith(`[${bare.ref}] `));
    assert.doesNotMatch(line ?? '', /transparent|covered/);
    assert.equal(seen.elements.find((e) => e.name === '自动续费')?.clickable, true);
  });

  test('纯网页信息：含页面内容，不含可操作元素的文字，表格里用 [编号] 引用', () => {
    const md = r.text_md;
    for (const t of [
      '组件陈列',
      '纯网页信息',
      '本页用于验收组件识别能力',
      '88231',
      '1,280.00',
      '账户余额',
      '12,000.00',
      '说明一',
      '示意图',
    ]) {
      assert.ok(md.includes(t), `text_md 缺少：${t}`);
    }
    for (const t of ['加入购物车', '自绘按钮', '帮助中心', '夜间模式', '卡片A', '同意条款']) {
      assert.ok(!md.includes(t), `text_md 不应包含可操作元素文字：${t}`);
    }
    const audit = expects.find((x) => x.label === 'info/审核');
    assert.ok(audit);
    assert.ok(md.includes(`[${audit.ref}]`), `表格中应以 [${audit.ref}] 引用“审核”按钮`);
  });
});
