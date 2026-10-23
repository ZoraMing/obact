// 敏感值统一遮蔽（DEV_PLAN 第 6 节规则 6）：observe 与 act 共用 obIsSensitive 一份判定。
// 覆盖：observe 的 elements/snapshot_text、可访问性树（含被预算挤出、零尺寸的字段）、act 断言失败详情。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Action, ActResult, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { act, observe } from '../src/index.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

const contracts = new Contracts();

/** sensitive.html 里的敏感值与普通值。 */
const SECRETS = [
  'Hunter2-pw',
  'otp-246810',
  'tok-ce-777',
  'tok-far-1234',
  'pw-far-5678',
  'tok-zero-9012',
  'pw-zero-3456',
];

const byName = (r: ObserveResult, name: string): ObservedElement => {
  const e = r.elements.find((x) => x.name === name);
  assert.ok(e, `找不到元素：${name}`);
  return e;
};

describe('敏感值统一遮蔽（observe 与 act 共用判定）', { skip: SKIP }, () => {
  let env: TestEnv;
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

  test('observe：password、one-time-code 的 textarea、名称含 token 的 contenteditable 都打码，普通词不误遮', async () => {
    const pageId = await env.open('/pages/sensitive.html');
    const ob = await observe(env.session, { pageId, views: ['text', 'axtree'] });
    contracts.assert('observe.Result', ob);
    assert.equal(byName(ob, '登录凭据').value, '***', 'type=password');
    assert.equal(byName(ob, '校验输入').value, '***', 'textarea 的 autocomplete=one-time-code');
    assert.equal(byName(ob, 'API token editor').value, '***', '名称含 token 的 contenteditable');
    assert.equal(byName(ob, '键盘布局').value, 'dvorak', 'keyboard 不是敏感词');
    assert.equal(byName(ob, '方位').value, 'north', 'cardinal 不含 card 这个词');
    assert.equal(byName(ob, '片段').value, 'chapter-one', 'passage 不是敏感词');
    assert.equal(byName(ob, 'hotpot base').value, 'spicy', 'hotpot 里的 otp 不在词边界上');
    const all = JSON.stringify(ob);
    for (const secret of SECRETS) assert.ok(!all.includes(secret), `返回中泄露了 ${secret}`);
    assert.ok(ob.snapshot_text?.includes('dvorak'));
  });

  test('名称判定：敏感词按词边界匹配，驼峰、连字符、连写的 password 都认', async () => {
    const hit = [
      'name="otp"',
      'name="OTPCode"',
      'name="totp"',
      'name="emailOtp"',
      'name="cvv"',
      'name="cc_cvv2"',
      'name="cardNumber"',
      'name="card-no"',
      'name="apiKey"',
      'name="x-api-key"',
      'name="accessKey"',
      'name="access-key"',
      'name="newpassword"',
      'name="confirmPassword"',
      'name="authtoken"',
      'id="user_secret"',
      'aria-label="验证码"',
      'placeholder="Security code (CVV)"',
      'autocomplete="cc-exp-month"',
      'autocomplete="new-password"',
    ];
    const miss = [
      'name="keyboard"',
      'name="cardinal"',
      'name="discard"',
      'name="scorecard"',
      'name="passage"',
      'name="passenger"',
      'name="hotpot"',
      'name="footprint"',
      'name="monkey"',
      'autocomplete="username"',
    ];
    const cases = [...hit, ...miss];
    const pageId = await env.open('/pages/basic.html');
    const page = env.session.pages.get(pageId);
    const html = cases.map((attrs, i) => `<input ${attrs} value="V${i}">`).join('<br>');
    await page.evaluate((h) => {
      document.body.innerHTML = h;
    }, html);
    // 页面上只有这些输入框，elements 与 cases 按文档顺序一一对应（aria-label 会改名，不能按名称找）
    const { elements } = await observe(env.session, { pageId });
    assert.equal(elements.length, cases.length);
    cases.forEach((attrs, i) => {
      assert.equal(elements[i]?.value, i < hit.length ? '***' : `V${i}`, attrs);
    });
  });

  test('可访问性树：被字符预算挤出 elements 的、零尺寸的敏感框，值同样不泄露', async () => {
    const pageId = await env.open('/pages/sensitive.html');
    // 最小预算：视口外的远端框被挤出 elements；零尺寸的框本来就不列出
    const ob = await observe(env.session, { pageId, views: ['axtree'], max_chars: 1000 });
    assert.ok(ob.truncated, '前提：预算触发了截断');
    for (const name of ['远端甲', '远端乙']) {
      assert.ok(!ob.elements.some((e) => e.name === name), `前提：${name} 不在 elements 里`);
    }
    const ax = ob.axtree ?? '';
    assert.match(ax, /textbox "远端甲"/, '前提：可访问性树读到了这些输入框');
    for (const secret of ['tok-far-1234', 'pw-far-5678', 'tok-zero-9012', 'pw-zero-3456']) {
      assert.ok(!ax.includes(secret), `可访问性树泄露了 ${secret}：${ax}`);
    }
    assert.ok(!ax.includes('•'), `密码框的圆点泄露了长度：${ax}`);
    const all = JSON.stringify(ob);
    for (const secret of SECRETS) assert.ok(!all.includes(secret), `返回中泄露了 ${secret}`);
  });

  test('act：value_equals 失败时 detail 不含敏感字段的值；比较仍用真实值，普通字段照常回显', async () => {
    const pageId = await env.open('/pages/sensitive.html');
    const wrong = (css: string) => ({ value_equals: { target: { css }, value: 'wrong' } });
    // 值相同照常通过（比较用真实值）
    const same = await run({
      op: 'assert',
      pageId,
      checks: [{ value_equals: { target: { css: '#pw1' }, value: 'Hunter2-pw' } }],
    });
    assert.equal(same.status, 'ok');
    for (const [css, secret] of [
      ['#pw1', 'Hunter2-pw'],
      ['#ta1', 'otp-246810'],
      ['#ed1', 'tok-ce-777'],
    ] as const) {
      const r = await run({ op: 'assert', pageId, checks: [wrong(css)] });
      assert.equal(r.status, 'error', css);
      assert.equal(r.error?.code, 'assertion_failed', css);
      assert.equal(r.assertions?.[0]?.detail, '当前值已隐藏（敏感字段）', css);
      assert.ok(!JSON.stringify(r).includes(secret), `${css} 的值泄露到 assert 的返回`);
      // wait_for 超时的错误信息里也会带上这个 detail
      const w = await run({ op: 'wait_for', pageId, until: [wrong(css)], timeout_ms: 300 });
      assert.equal(w.error?.code, 'timeout', css);
      assert.ok(!JSON.stringify(w).includes(secret), `${css} 的值泄露到 wait_for 的返回`);
    }
    const plain = await run({ op: 'assert', pageId, checks: [wrong('#plain1')] });
    assert.equal(plain.assertions?.[0]?.detail, '当前值：dvorak');
  });
});
