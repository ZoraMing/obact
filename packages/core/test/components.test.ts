// 组件识别验收（用户重点）：components.html 中带期望值的常见组件都应被识别为可操作功能，
// 角色、名称、可用操作正确；纯网页信息不被编号。observe 实现后，同一页面还用于验收 observe 的输出。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ACT_DEPS, obActInfo } from '../src/act/page.ts';
import { markPage } from '../src/index.ts';
import { bundle } from '../src/page/bundle.ts';
import { DOM_LIB, obActions, obHint, obName, obOptions, obRole } from '../src/page/dom.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

type Got = {
  label: string;
  ref: string | null;
  role: string;
  name: string;
  actions: string[];
  options: number | null;
  hint: string;
  expect: {
    role: string;
    name: string;
    actions: string[];
    options: number | null;
    hint: string | null;
  };
};

/** 在页面内收集每个带期望值元素的实际识别结果。 */
const COLLECT = bundle((attr: string) => {
  const out: Got[] = [];
  const all = [...document.querySelectorAll('[data-x-actions]')];
  for (const el of all) {
    const opts = obOptions(el, 100);
    out.push({
      label: `${el.closest('section')?.id}/${el.getAttribute('data-x-name')}`,
      ref: el.getAttribute(attr),
      role: obRole(el),
      name: obName(el),
      actions: obActions(el),
      options: opts ? opts.options.length : null,
      hint: obHint(el),
      expect: {
        role: el.getAttribute('data-x-role') ?? '',
        name: el.getAttribute('data-x-name') ?? '',
        actions: (el.getAttribute('data-x-actions') ?? '').split(',').filter(Boolean),
        hint: el.getAttribute('data-x-hint'),
        options: el.hasAttribute('data-x-options')
          ? Number(el.getAttribute('data-x-options'))
          : null,
      },
    });
  }
  return out;
}, DOM_LIB);

/** 被编号但没有期望值的元素（误识别），select 内的 option 除外。 */
const UNEXPECTED = bundle((attr: string) => {
  return [...document.querySelectorAll(`[${attr}]`)]
    .filter((el) => !el.hasAttribute('data-x-actions') && !el.closest('select, datalist'))
    .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 20)}"`);
}, DOM_LIB);

/** 清单里列了 fill、act 却没有填写方式的元素（按清单操作会被 act 拒绝）。 */
const FILL_GAP = bundle(() => {
  return [...document.querySelectorAll('[data-x-actions]')]
    .filter((el) => obActions(el).includes('fill') && obActInfo(el).fill === null)
    .map((el) => `${el.closest('section')?.id}/${el.getAttribute('data-x-name')}`);
}, ACT_DEPS);

describe('组件识别：可操作功能与纯网页信息', { skip: SKIP }, () => {
  let env: TestEnv;
  let got: Got[] = [];

  before(async () => {
    env = await setup();
    const pageId = await env.open('/pages/components.html');
    await markPage(env.session, pageId);
    got = await env.session.pages.get(pageId).evaluate(COLLECT, env.session.attr);
  });
  after(async () => {
    await env?.close();
  });

  test('陈列页包含足够多的组件', () => {
    assert.ok(got.length >= 40, `组件数 ${got.length}`);
  });

  test('每个组件都被编号（识别为可操作功能）', () => {
    const missing = got.filter((g) => !g.ref).map((g) => g.label);
    assert.deepEqual(missing, [], `未识别：${missing.join('、')}`);
  });

  test('角色与名称正确', () => {
    const wrong = got
      .filter((g) => g.role !== g.expect.role || g.name !== g.expect.name)
      .map((g) => `${g.label}: ${g.role} "${g.name}"（期望 ${g.expect.role} "${g.expect.name}"）`);
    assert.deepEqual(wrong, []);
  });

  test('可用操作正确', () => {
    const wrong = got
      .filter((g) => [...g.actions].sort().join() !== [...g.expect.actions].sort().join())
      .map((g) => `${g.label}: ${g.actions.join(',')}（期望 ${g.expect.actions.join(',')}）`);
    assert.deepEqual(wrong, []);
  });

  test('清单里的 fill，act 都填得了（actions 与 act 的填写能力一致）', async () => {
    const pageId = env.session.pages.list().at(-1)?.pageId as string;
    assert.deepEqual(await env.session.pages.get(pageId).evaluate(FILL_GAP), []);
  });

  test('下拉框、列表框、datalist 的选项', () => {
    const wrong = got
      .filter((g) => g.expect.options !== null && g.options !== g.expect.options)
      .map((g) => `${g.label}: ${g.options}（期望 ${g.expect.options}）`);
    assert.deepEqual(wrong, []);
  });

  test('没有可访问名称的图标元素给出提示', () => {
    const icons = got.filter((g) => g.expect.hint !== null);
    assert.ok(icons.length >= 2);
    const wrong = icons
      .filter((g) => g.hint !== g.expect.hint)
      .map((g) => `${g.label}: "${g.hint}"（期望 "${g.expect.hint}"）`);
    assert.deepEqual(wrong, []);
  });

  test('纯网页信息不被编号，没有误识别', async () => {
    const pageId = env.session.pages.list().at(-1)?.pageId as string;
    const extra = await env.session.pages.get(pageId).evaluate(UNEXPECTED, env.session.attr);
    assert.deepEqual(extra, []);
  });
});
