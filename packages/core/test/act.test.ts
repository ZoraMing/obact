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

  /** 取出并清空页面记录的事件（act-fill.html：类型:控件:值:是否可信）。 */
  const drain = (pageId: string) =>
    env.session.pages
      .get(pageId)
      .evaluate(() => (window as unknown as { events: string[] }).events.splice(0));

  test('下拉框填值：跳过的中间项不触发事件，页面只收到目标项一组可信的 input/change；onchange 导航也能完成', async () => {
    const pageId = await env.open('/pages/act-fill.html');
    await ok({ op: 'fill', pageId, target: { css: '#sort' }, value: '五' });
    assert.deepEqual(await drain(pageId), ['input:sort:5:true', 'change:sort:5:true']);
    await ok({ op: 'fill', pageId, target: { css: '#sort' }, value: '一' });
    assert.deepEqual(await drain(pageId), ['input:sort:1:true', 'change:sort:1:true']);
    // 当前项被禁用（占位项）时先按 Home 再逐项移动
    await ok({ op: 'fill', pageId, target: { css: '#menu' }, value: '页面C' });
    assert.deepEqual(await drain(pageId), ['input:menu:c:true', 'change:menu:c:true']);
    // 中间项的 onchange 会导航：不能在第一个中间项就跳走
    const jump = await env.open('/pages/act-fill.html');
    await ok({ op: 'fill', pageId: jump, target: { css: '#jump' }, value: '页面C' });
    assert.match(env.session.pages.get(jump).url(), /act-target\.html\?to=c$/);
  });

  test('多选下拉框：点选项按 Ctrl 切换、Shift 连选，fill 用逗号分隔多项，每次只派发一组事件', async () => {
    const pageId = await env.open('/pages/act-fill.html');
    const page = env.session.pages.get(pageId);
    const picked = () =>
      page.$eval('#multi', (e) =>
        [...(e as HTMLSelectElement).selectedOptions].map((o) => o.value).join('|'),
      );
    const opt = (name: string) => ({ role: 'option' as const, name });
    await ok({ op: 'click', pageId, target: opt('紧急') });
    assert.deepEqual(await drain(pageId), ['input:multi:1:true', 'change:multi:1:true']);
    await ok({ op: 'click', pageId, target: opt('普通'), modifiers: ['Control'] });
    assert.equal(await picked(), '1|3');
    await ok({ op: 'click', pageId, target: opt('紧急'), modifiers: ['Control'] });
    assert.equal(await picked(), '3', 'Ctrl 点已选项取消该项');
    assert.equal((await drain(pageId)).length, 2 * 2, '两次 Ctrl 点击各一组 input/change');
    await ok({ op: 'click', pageId, target: opt('重要') });
    await ok({ op: 'click', pageId, target: opt('低'), modifiers: ['Shift'] });
    assert.equal(await picked(), '2|3|4');
    await drain(pageId);
    await ok({ op: 'fill', pageId, target: { css: '#multi' }, value: '紧急,很低' });
    assert.equal(await picked(), '1|5');
    assert.deepEqual(await drain(pageId), ['input:multi:1|5:false', 'change:multi:1|5:false']);
    await ok({ op: 'fill', pageId, target: { css: '#multi' }, value: '紧急，很低' });
    assert.deepEqual(await drain(pageId), [], '选中状态没变化时不派发事件');
    await err(
      { op: 'fill', pageId, target: { css: '#multi' }, value: '紧急,不存在', timeout_ms: 800 },
      'not_found',
    );
    assert.equal(await picked(), '1|5', '有选项找不到时不改动');
    await ok({ op: 'fill', pageId, target: { css: '#multi' }, value: '' });
    assert.equal(await picked(), '');
  });

  test('填日期、颜色、滑块：浏览器会改写或丢弃的值报 invalid_params，页面的原值和事件不受影响', async () => {
    const pageId = await env.open('/pages/act-fill.html');
    const page = env.session.pages.get(pageId);
    const value = (id: string) => page.$eval(id, (e) => (e as HTMLInputElement).value);
    await ok({ op: 'fill', pageId, target: { css: '#date' }, value: '2026-01-05' });
    assert.equal((await drain(pageId)).length, 2);
    await err(
      { op: 'fill', pageId, target: { css: '#date' }, value: '2026/01/06' },
      'invalid_params',
    );
    assert.equal(await value('#date'), '2026-01-05', '写错格式不能清掉原有的值');
    const bad = await err(
      { op: 'fill', pageId, target: { css: '#color' }, value: 'red' },
      'invalid_params',
    );
    assert.equal(bad.error?.details?.actual, '#000000');
    await err({ op: 'fill', pageId, target: { css: '#range' }, value: 99 }, 'invalid_params');
    assert.deepEqual(await drain(pageId), [], '被拒绝的值不派发事件');
    assert.equal(await value('#range'), '5');
    await ok({ op: 'fill', pageId, target: { css: '#color' }, value: '#FF0000' });
    await ok({ op: 'fill', pageId, target: { css: '#range' }, value: 7 });
    assert.equal(await value('#color'), '#ff0000');
    assert.equal(await value('#range'), '7');
  });

  test('type_text 带 target：新聚焦的元素光标在末尾；已有焦点的元素保持用户放的选区', async () => {
    const pageId = await env.open('/pages/act-fill.html');
    const page = env.session.pages.get(pageId);
    const type = (css: string, text: string) =>
      ok({ op: 'type_text', pageId, target: { css }, text });
    await type('#pre', 'X');
    await type('#note', 'Y');
    await type('#mail', 'Z'); // email 不支持选区，靠全选加右方向键折叠到末尾
    await type('#rich', '尾');
    assert.equal(await page.$eval('#pre', (e) => (e as HTMLInputElement).value), 'abcX');
    assert.equal(
      await page.$eval('#note', (e) => (e as HTMLTextAreaElement).value),
      '第一行\n第二行Y',
    );
    assert.equal(await page.$eval('#mail', (e) => (e as HTMLInputElement).value), 'a@b.cZ');
    assert.equal(await page.$eval('#rich', (e) => (e as HTMLElement).innerText), '原有内容尾');
    // #pre 已有焦点时不动光标：全选后再带 target 键入是替换
    await type('#pre', '1');
    await ok({ op: 'press_key', pageId, key: 'Control+A' });
    await type('#pre', 'R');
    assert.equal(await page.$eval('#pre', (e) => (e as HTMLInputElement).value), 'R');
  });

  test('视觉隐藏的原生复选框：点可见的 label', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { role: 'checkbox', name: '自动续费' } });
    assert.ok((await events(pageId)).includes('hcb:true'));
  });

  test('隐藏的原生复选框的 label 里带链接：点在链接以外的地方，不会跟随链接；click 和 fill 都一样', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { css: '#agree' } });
    await ok({ op: 'fill', pageId, target: { css: '#agree' }, value: false });
    assert.deepEqual(await events(pageId), ['agree:true', 'agree:false'], '链接没有被点到');
    assert.match(env.session.pages.get(pageId).url(), /act-main\.html$/);
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

  test('onObscured 返回 true 的不计入连续不符次数：三层遮罩逐层处理后点击成功；总说已处理而遮罩不消失时有上限', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await page.evaluate(() => {
      for (let i = 1; i <= 3; i++) {
        const m = document.createElement('div');
        m.className = 'layer';
        m.style.cssText = `position:fixed;inset:0;z-index:${100 + i}`;
        document.body.append(m);
      }
    });
    let calls = 0;
    await ok(
      { op: 'click', pageId, target: { css: '#btn' } },
      {
        onObscured: async () => {
          calls++;
          await page.evaluate(() => [...document.querySelectorAll('.layer')].pop()?.remove());
          return true;
        },
      },
    );
    assert.equal(calls, 3);
    assert.deepEqual(await events(pageId), ['click:true']);

    const stuck = await open();
    await env.session.pages.get(stuck).$eval('#mask', (e) => {
      (e as HTMLElement).style.display = 'block';
    });
    let tries = 0;
    await err({ op: 'click', pageId: stuck, target: { css: '#btn' } }, 'obscured', {
      onObscured: async () => {
        tries++;
        return true;
      },
    });
    assert.ok(tries > 3, `已处理的不按 3 次截断：${tries}`);
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

  test('后台标签页：点击先切到前台，不多等；iframe 里的可编辑区 fill 真正写入', async () => {
    const a = await open();
    const b = await ok({ op: 'new_page', url: `${env.server.base}/pages/basic.html` });
    assert.ok(b.effects.new_pages.length >= 0);
    // a 现在是后台标签页（新开的标签页在前台）
    const t = Date.now();
    await ok({ op: 'click', pageId: a, target: { css: '#btn' } });
    assert.ok(Date.now() - t < 2500, `对后台标签页点击耗时 ${Date.now() - t} 毫秒`);
    assert.deepEqual(await events(a), ['click:true']);

    const c = await env.open('/pages/act-main.html');
    const page = env.session.pages.get(c);
    await page.setContent(
      '<iframe id="ed" srcdoc="<body contenteditable>初始内容</body>" style="width:300px;height:100px"></iframe>',
    );
    await page.waitForFunction(
      () => !!(document.querySelector('#ed') as HTMLIFrameElement | null)?.contentDocument?.body,
    );
    await ok({
      op: 'fill',
      pageId: c,
      target: { css: 'body', frame: ['iframe#ed'] },
      value: '新的内容',
    });
    const text = await page.evaluate(
      () => (document.querySelector('#ed') as HTMLIFrameElement).contentDocument?.body.innerText,
    );
    assert.equal(text, '新的内容');
  });

  test('移动中的按钮等位置稳定后再点；禁用按钮不能点，但能悬停和截图', async () => {
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
    // 悬停和截图不要求启用：禁用按钮上的悬停提示、禁用态的截图都要能做，不能白等满超时
    await ok({ op: 'hover', pageId, target: { css: '#disabled' }, timeout_ms: 600 });
    await ok({ op: 'take_screenshot', pageId, target: { css: '#disabled' }, timeout_ms: 600 });
  });

  test('定位器目标在可操作性检查期间被框架重绘替换：重新定位后 fill、type_text、下拉框、勾选都用新节点', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    // 第一次取该元素位置之后 20 毫秒，把它换成克隆出来的新节点（模拟框架重渲染）
    const swapAfterProbe = (css: string) =>
      page.evaluate((sel) => {
        const orig = Element.prototype.getBoundingClientRect;
        let done = false;
        Element.prototype.getBoundingClientRect = function (this: Element) {
          if (!done && this.matches(sel)) {
            done = true;
            setTimeout(() => this.replaceWith(this.cloneNode(true)), 20);
          }
          return orig.call(this);
        };
      }, css);
    const value = (css: string) => page.$eval(css, (e) => (e as HTMLInputElement).value);
    await swapAfterProbe('#text');
    await ok({ op: 'fill', pageId, target: { css: '#text' }, value: '新值' });
    assert.equal(await value('#text'), '新值');
    await swapAfterProbe('#area');
    await ok({ op: 'type_text', pageId, target: { css: '#area' }, text: 'abc' });
    assert.equal(await value('#area'), 'abc');
    await swapAfterProbe('#sel');
    await ok({ op: 'fill', pageId, target: { css: '#sel' }, value: '待审核' });
    assert.equal(await value('#sel'), 'p');
    await swapAfterProbe('#cb');
    await ok({ op: 'fill', pageId, target: { css: '#cb' }, value: true });
    assert.equal(await page.$eval('#cb', (e) => (e as HTMLInputElement).checked), true);
  });

  test('目标在比视口高的 iframe 深处：先对目标本身居中，把父文档带到目标处再点', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await page.setContent(
      '<!doctype html><body style="margin:0"><div style="height:100px"></div><iframe id="tall" style="display:block;width:600px;height:1200px;border:0"></iframe>',
    );
    await page.evaluate(() => {
      (window as unknown as { events: string[] }).events = [];
      (document.getElementById('tall') as HTMLIFrameElement).srcdoc =
        "<body style='margin:0'><div style='height:1000px'></div><button id='deep' onclick=\"parent.events.push('deep')\">深处的按钮</button>";
    });
    await page.waitForFunction(
      () =>
        !!(document.getElementById('tall') as HTMLIFrameElement).contentDocument?.getElementById(
          'deep',
        ),
    );
    await ok({ op: 'click', pageId, target: { css: '#deep', frame: ['iframe#tall'] } });
    assert.deepEqual(await events(pageId), ['deep']);
    assert.ok((await page.evaluate(() => scrollY)) > 0, '父文档被滚动到目标处');
  });

  test('页面外的元素先滚动到视口再点', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { css: '#far' } });
    assert.ok((await events(pageId)).includes('far:true'));
  });

  test('目标被祖先滚动容器裁掉时先滚动容器再点；position:fixed 的元素不算被裁掉', async () => {
    const pageId = await env.open('/pages/act-clip.html');
    const page = env.session.pages.get(pageId);
    const scrolls = () =>
      page.evaluate(() => [
        (document.getElementById('outer') as HTMLElement).scrollTop,
        (document.getElementById('inner') as HTMLElement).scrollTop,
      ]);
    // 按钮的几何位置在 800 高的视口内，被两层 overflow 容器裁掉
    await ok({ op: 'click', pageId, target: { css: '#pinned' } });
    assert.deepEqual(await scrolls(), [0, 0], '固定定位的按钮不该触发容器滚动');
    await ok({ op: 'click', pageId, target: { css: '#deep' } });
    const [outer, inner] = await scrolls();
    assert.ok((outer ?? 0) > 0 && (inner ?? 0) > 0, `两层容器都应滚动：${outer} ${inner}`);
    assert.deepEqual(await events(pageId), ['pinned', 'deep']);
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

  test('拖放：终点只有一部分在视口内时落在可见部分的中心，不是整个矩形的中心', async () => {
    const pageId = await open();
    // 放置区上沿在视口底边上方 40 像素、高 400：矩形中心在视口外，可见部分只有一条
    await env.session.pages.get(pageId).$eval('#drop', (e) => {
      (e as HTMLElement).style.cssText =
        `position:absolute;left:300px;top:${innerHeight - 40}px;width:200px;height:400px`;
    });
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
