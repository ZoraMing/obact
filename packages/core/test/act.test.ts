import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type ActOptions, act } from '../src/index.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

const FILES = join(dirname(fileURLToPath(import.meta.url)), 'files');
const contracts = new Contracts();

describe('act（FR-12~FR-15、FR-32）', { skip: SKIP }, () => {
  let env: TestEnv;
  let polls = 0;
  before(async () => {
    env = await setup({
      '/api/poll': (_req, res) => {
        polls++;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      },
    });
  });
  after(async () => {
    await env?.close();
  });

  /** 执行动作并校验返回值符合契约。 */
  async function run(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await act(env.session, a, { filesRoot: FILES, ...opts });
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action, opts?: ActOptions): Promise<ActResult> {
    const r = await run(a, opts);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  async function err(a: Action, code: string, opts?: ActOptions): Promise<ActResult> {
    const r = await run(a, opts);
    assert.equal(r.status, 'error', `${a.op} 应失败`);
    assert.equal(r.error?.code, code, r.error?.message);
    return r;
  }
  const events = (pageId: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(() => (window as unknown as { events: string[] }).events);
  const open = () => env.open('/pages/act-main.html');

  test('可信点击：按定位器与按编号，返回动作序号与方式', async () => {
    const pageId = await open();
    const r1 = await ok({ op: 'click', pageId, target: { css: '#btn' } });
    assert.equal(r1.locator_used, 'css');
    const r2 = await ok({ op: 'click', pageId, target: { role: 'button', name: '点我' } });
    assert.equal(r2.locator_used, 'role');
    assert.ok((r2.action_seq ?? 0) > (r1.action_seq ?? 0));
    assert.deepEqual(await events(pageId), ['click:true', 'click:true']);
    assert.equal(r1.effects.changed, false, '只记日志，没有 DOM 变化');
  });

  test('按编号点击；编号失效报 stale_ref', async () => {
    const pageId = await open();
    const { observe } = await import('../src/index.ts');
    const ob = await observe(env.session, { pageId });
    const btn = ob.elements.find((e) => e.name === '点我');
    assert.ok(btn);
    const r = await ok({ op: 'click', pageId, target: { ref: btn.ref } });
    assert.equal(r.locator_used, 'ref');
    await env.session.pages.get(pageId).evaluate(() => {
      // 克隆重绘：新节点带着旧属性，但不是原来的元素
      const b = document.getElementById('btn') as HTMLElement;
      b.replaceWith(b.cloneNode(true));
    });
    await err({ op: 'click', pageId, target: { ref: btn.ref } }, 'stale_ref');
  });

  test('填写：文本框、多行、下拉框（文本或值）、复选框、可编辑区，输入是可信的', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await ok({ op: 'fill', pageId, target: { css: '#text' }, value: '新值' });
    await ok({ op: 'fill', pageId, target: { css: '#area' }, value: '第一行' });
    await ok({ op: 'fill', pageId, target: { role: 'combobox', name: '状态' }, value: '待审核' });
    assert.equal(await page.$eval('#sel', (e) => (e as HTMLSelectElement).value), 'p');
    await ok({ op: 'fill', pageId, target: { css: '#sel' }, value: 'd' });
    assert.equal(await page.$eval('#sel', (e) => (e as HTMLSelectElement).value), 'd');
    await ok({ op: 'fill', pageId, target: { css: '#cb' }, value: true });
    await ok({ op: 'fill', pageId, target: { css: '#cb' }, value: true }); // 已勾选时不再点
    await ok({ op: 'fill', pageId, target: { css: '#editor' }, value: '新内容' });
    assert.equal(await page.$eval('#text', (e) => (e as HTMLInputElement).value), '新值');
    assert.equal(await page.$eval('#area', (e) => (e as HTMLTextAreaElement).value), '第一行');
    assert.equal(await page.$eval('#cb', (e) => (e as HTMLInputElement).checked), true);
    assert.equal(await page.$eval('#editor', (e) => (e as HTMLElement).innerText.trim()), '新内容');
    const ev = await events(pageId);
    assert.ok(ev.includes('input:text:true'));
    assert.ok(ev.includes('input:editor:true'));
    assert.equal(ev.filter((x) => x.startsWith('cb:')).length, 1, '复选框只切换一次');
    assert.ok(ev.includes('cb:true:true'));
  });

  test('不支持的操作被拒绝：只读输入框、按钮、下拉框不能点', async () => {
    const pageId = await open();
    await err({ op: 'fill', pageId, target: { css: '#ro' }, value: 'x' }, 'not_actionable');
    await err({ op: 'fill', pageId, target: { css: '#btn' }, value: 'x' }, 'not_actionable');
    await err({ op: 'fill', pageId, target: { css: '#sel' }, value: '不存在' }, 'not_found');
  });

  test('视觉隐藏的原生复选框：点可见的 label', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { role: 'checkbox', name: '自动续费' } });
    assert.ok((await events(pageId)).includes('hcb:true'));
  });

  test('被遮挡：重试 3 次后报 obscured；onObscured 处理后成功', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await page.$eval('#mask', (e) => {
      (e as HTMLElement).style.display = 'block';
    });
    const r = await err(
      { op: 'click', pageId, target: { css: '#btn' }, timeout_ms: 1500 },
      'obscured',
    );
    assert.equal((await events(pageId)).length, 0, '被遮挡时不能点到遮罩上');
    let calls = 0;
    await ok(
      { op: 'click', pageId, target: { css: '#btn' } },
      {
        onObscured: async (info) => {
          calls++;
          assert.equal(info.op, 'click');
          await page.$eval('#mask', (e) => {
            (e as HTMLElement).style.display = 'none';
          });
          return true;
        },
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await events(pageId), ['click:true']);
    assert.ok(r.duration_ms < 4000);
  });

  test('落点防护：最后一次复核之后布局又变了，点击被拦截，不会落到别的元素上；重试后点中目标', async () => {
    const pageId = await env.open('/pages/act-shift.html');
    let calls = 0;
    const r = await ok(
      { op: 'click', pageId, target: { css: '#target' } },
      {
        onObscured: async (info) => {
          calls++;
          assert.match(info.hit, /横幅/);
          return true;
        },
      },
    );
    assert.equal(calls, 1, '第一次落在横幅上被拦截，回调一次');
    assert.deepEqual(await events(pageId), ['target'], '横幅没有收到点击；目标只点了一次');
    assert.equal(r.status, 'ok');
  });

  test('落点防护：布局一直在变，连续 3 次不符报 landing_mismatch，页面没有收到任何误点', async () => {
    const pageId = await env.open('/pages/act-shift.html?mode=always');
    let calls = 0;
    const r = await err({ op: 'click', pageId, target: { css: '#target' } }, 'landing_mismatch', {
      onObscured: async () => {
        calls++;
        return false;
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(await events(pageId), [], '横幅、别的按钮、目标都没有收到点击');
    assert.match(r.error?.message ?? '', /已拦截/);
  });

  test('移动中的按钮等位置稳定后再点；禁用按钮报 not_actionable', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await page.$eval('#moving', (e) => {
      (e as HTMLElement).style.left = '500px';
    });
    await ok({ op: 'click', pageId, target: { css: '#moving' } });
    assert.ok((await events(pageId)).includes('moving:true'));
    await err(
      { op: 'click', pageId, target: { css: '#disabled' }, timeout_ms: 600 },
      'not_actionable',
    );
  });

  test('页面外的元素先滚动到视口再点', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { css: '#far' } });
    assert.ok((await events(pageId)).includes('far:true'));
  });

  test('对话框：alert 记为 pending、阻塞后续动作、handle_dialog 处理；confirm 取消；prompt 填写', async () => {
    const pageId = await open();
    const r = await ok({ op: 'click', pageId, target: { css: '#alert' } });
    assert.deepEqual(r.effects.dialogs, [
      { type: 'alert', message: '提示一下', handled: 'pending' },
    ]);
    await err({ op: 'click', pageId, target: { css: '#btn' } }, 'dialog_blocking');
    await ok({ op: 'handle_dialog', pageId, action: 'accept' });
    await ok({ op: 'click', pageId, target: { css: '#btn' } });

    await ok({ op: 'click', pageId, target: { css: '#confirm' } });
    await ok({ op: 'handle_dialog', pageId, action: 'dismiss' });
    await ok({ op: 'click', pageId, target: { css: '#prompt' } });
    await ok({ op: 'handle_dialog', pageId, action: 'accept', prompt_text: '小明' });
    const ev = await events(pageId);
    assert.ok(ev.includes('confirm:false'), ev.join());
    assert.ok(ev.includes('prompt:小明'), ev.join());
    await err({ op: 'handle_dialog', pageId, action: 'accept' }, 'invalid_params');
  });

  test('新标签页与导航效果', async () => {
    const pageId = await open();
    const r = await ok({ op: 'click', pageId, target: { css: '#newtab' } });
    assert.equal(r.effects.new_pages.length, 1);
    const popup = env.session.pages.get(r.effects.new_pages[0] as string);
    await popup.waitForFunction(() => document.title === '目标页');
    const nav = await ok({ op: 'click', pageId, target: { css: '#nav' } });
    assert.equal(nav.effects.navigated, true);
    assert.equal(nav.effects.changed, true);
    const back = await ok({ op: 'navigate_page', pageId, type: 'back' });
    assert.equal(back.effects.navigated, true);
    assert.match(env.session.pages.get(pageId).url(), /act-main/);
    await ok({ op: 'navigate_page', pageId, type: 'reload' });
    await err({ op: 'navigate_page', pageId, url: 'http://127.0.0.1:1/' }, 'navigation_failed');
  });

  test('后置检查：通过即继续；不通过报 assertion_failed', async () => {
    const pageId = await open();
    const r = await ok({
      op: 'click',
      pageId,
      target: { css: '#later' },
      post: [{ text_present: '完成' }],
    });
    assert.equal(r.assertions?.[0]?.pass, true);
    assert.ok(r.duration_ms < 2000);
    const bad = await err(
      {
        op: 'click',
        pageId,
        target: { css: '#btn' },
        post: [{ text_present: '永远不会出现' }],
        timeout_ms: 500,
      },
      'assertion_failed',
    );
    assert.equal(bad.assertions?.[0]?.pass, false);
  });

  test('常驻轮询（每 100 毫秒）不拖慢等待', async () => {
    const pageId = await open();
    const before = polls;
    const t = Date.now();
    await ok({ op: 'click', pageId, target: { css: '#btn' } });
    await ok({ op: 'fill', pageId, target: { css: '#text' }, value: 'x' });
    assert.ok(Date.now() - t < 1500, `耗时 ${Date.now() - t}`);
    assert.ok(polls > before, '轮询确实在进行');
  });

  test('坐标动作：Canvas 上点击、按下拖动、移动', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    const box = await (await page.$('#pad'))?.boundingBox();
    assert.ok(box);
    const r = await ok({ op: 'click_at', pageId, x: box.x + 50, y: box.y + 40 });
    assert.equal(r.locator_used, 'coord');
    const padEv = await events(pageId);
    assert.ok(padEv.includes('pad:50,40:true'), padEv.join());
    await ok({ op: 'drag', pageId, from: [box.x + 10, box.y + 10], to: [box.x + 150, box.y + 90] });
    const ev = await events(pageId);
    assert.ok(ev.includes('down') && ev.includes('up'));
    await ok({ op: 'mouse_move', pageId, x: 5, y: 5 });
  });

  test('拖放：元素拖到元素（HTML5 拖放）', async () => {
    const pageId = await open();
    await ok({ op: 'drag', pageId, from: { css: '#card' }, to: { css: '#drop' } });
    assert.ok((await events(pageId)).includes('drop:card'));
  });

  test('滚动：元素、坐标处、页面', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await ok({ op: 'scroll', pageId, target: { css: '#scrollbox' }, dy: 60 });
    assert.ok((await page.evaluate(() => (window as unknown as { boxTop: number }).boxTop)) > 0);
    await ok({ op: 'scroll', pageId, dy: 400 });
    assert.ok((await page.evaluate(() => scrollY)) > 0);
  });

  test('键入与按键：聚焦后键入，回车提交，组合键全选', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await ok({ op: 'type_text', pageId, target: { css: '#q' }, text: 'obact' });
    await ok({ op: 'press_key', pageId, key: 'Enter' });
    assert.ok((await events(pageId)).includes('submit:obact'));
    await ok({ op: 'press_key', pageId, key: 'Control+A' });
    await ok({ op: 'type_text', pageId, text: '替换' });
    assert.equal(await page.$eval('#q', (e) => (e as HTMLInputElement).value), '替换');
  });

  test('上传：工作区内的文件；越出工作区报 path_outside_workspace', async () => {
    const pageId = await open();
    await ok({ op: 'upload_file', pageId, target: { css: '#file' }, files: ['hello.txt'] });
    assert.ok((await events(pageId)).includes('file:hello.txt'));
    await err(
      { op: 'upload_file', pageId, target: { css: '#file' }, files: ['../act.test.ts'] },
      'path_outside_workspace',
    );
  });

  test('脚本、等待、断言、截图', async () => {
    const pageId = await open();
    const r = await ok({
      op: 'evaluate_script',
      pageId,
      function: '(a, b) => a + b',
      args: [2, 3],
    });
    assert.equal(r.data, 5);
    await err(
      { op: 'evaluate_script', pageId, function: '() => { throw new Error("坏了") }' },
      'script_error',
    );
    await ok({ op: 'click', pageId, target: { css: '#later' } });
    await ok({ op: 'wait_for', pageId, until: [{ text_present: '完成' }], timeout_ms: 2000 });
    await err(
      { op: 'wait_for', pageId, until: [{ text_present: '不会出现' }], timeout_ms: 300 },
      'timeout',
    );
    await ok({
      op: 'assert',
      pageId,
      checks: [{ title_matches: '动作测试' }, { element_present: { css: '#btn' } }],
    });
    await err(
      { op: 'assert', pageId, checks: [{ element_absent: { css: '#btn' } }] },
      'assertion_failed',
    );
    const shot = await ok({ op: 'take_screenshot', pageId });
    assert.ok(shot.screenshot_path && existsSync(shot.screenshot_path));
    const after = await ok({
      op: 'click',
      pageId,
      target: { css: '#btn' },
      screenshot: true,
      diff: true,
    });
    assert.ok(after.screenshot_path && existsSync(after.screenshot_path));
  });

  test('标签页：新建、切换、关闭', async () => {
    const r = await ok({
      op: 'new_page',
      pageId: 'act-new',
      url: `${env.server.base}/pages/act-target.html`,
    });
    assert.deepEqual(r.effects.new_pages, ['act-new']);
    await ok({ op: 'select_page', pageId: 'act-new' });
    await ok({ op: 'close_page', pageId: 'act-new' });
    await err({ op: 'click', pageId: 'act-new', target: { css: '#back-btn' } }, 'page_not_found');
  });

  test('参数不符合契约报 invalid_params；extract 在 M2', async () => {
    await err({ op: 'click', target: { ref: 1 } } as unknown as Action, 'invalid_params');
    const pageId = await open();
    await err(
      { op: 'extract', pageId, source: { type: 'response', url: 'x', path: 'a' } },
      'invalid_params',
    );
  });
});
