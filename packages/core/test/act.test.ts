import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import { type ActOptions, act, checkAssertions } from '../src/index.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

const FILES = join(dirname(fileURLToPath(import.meta.url)), 'files');
const contracts = new Contracts();

describe('act（FR-12~FR-15、FR-32）', { skip: SKIP }, () => {
  let env: TestEnv;
  let polls = 0;
  /** /api/hold 的请求挂起，直到测试放行：页面用同步请求占住主线程，占多久由测试决定。 */
  const held: ServerResponse[] = [];
  let onHold: () => void = () => {};
  before(async () => {
    env = await setup({
      '/api/poll': (_req, res) => {
        polls++;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      },
      '/api/hold': (_req, res) => {
        held.push(res);
        onHold();
      },
      // 永不响应：导航一直等不到结果
      '/api/hang': () => {},
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
    // 填错目标的报错不回显调用方给的值（可能是密码），只给长度
    const secret = 'S3cr3t-PW!';
    for (const [css, code] of [
      ['#sel', 'not_found'],
      ['#cb', 'invalid_params'],
    ] as const) {
      const r = await err({ op: 'fill', pageId, target: { css }, value: secret }, code);
      assert.ok(!JSON.stringify(r.error).includes(secret), `${css} 的报错回显了值`);
      assert.equal(r.error?.details?.value_length, secret.length);
    }
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

  test('勾选框的 onchange 会导航：勾选已经生效，fill 不能因为旧文档的句柄失效报 internal', async () => {
    const pageId = await env.open('/pages/act-fill.html');
    await ok({ op: 'fill', pageId, target: { css: '#jumpcb' }, value: true });
    await env.session.pages
      .get(pageId)
      .waitForFunction(() => location.search === '?cb=true', { timeout: 3000 });
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
      { op: 'fill', pageId, target: { css: '#color' }, value: 'S3cr3t-PW!' },
      'invalid_params',
    );
    assert.equal(bad.error?.details?.actual, '#000000');
    assert.ok(!JSON.stringify(bad.error).includes('S3cr3t-PW!'), '报错不回显调用方给的值');
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

  test('opacity:0 的原生控件（铺在自绘外观上、没有 label）：点击、填写都真正生效；点击点上不是它的透明蜜罐照样被拒', async () => {
    const pageId = await env.open('/pages/act-opacity.html');
    await ok({ op: 'click', pageId, target: { css: '#cb' } });
    await ok({ op: 'click', pageId, target: { role: 'switch', name: '消息通知' } });
    await ok({ op: 'fill', pageId, target: { css: '#rd' }, value: true });
    await ok({ op: 'fill', pageId, target: { css: '#tx' }, value: '月付' });
    assert.deepEqual(await events(pageId), [
      'cb:true:true',
      'sw:true:true',
      'rd:true:true',
      'tx:月付:true',
    ]);
    // 可见性断言与动作同一判据：透明但铺在外观上的控件算存在
    await ok({
      op: 'assert',
      pageId,
      checks: [{ element_present: { role: 'checkbox', name: '选择此行' } }],
    });
    // 蜜罐同样透明，但点击点上是别的元素：落点防护拦下，页面没有收到任何事件
    await err({ op: 'click', pageId, target: { css: '#trap' }, timeout_ms: 1500 }, 'obscured');
    assert.equal((await events(pageId)).length, 4);
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
    assert.match(r.error?.message ?? '', /连续 3 次/, '连续 3 次命中不符才报错');
    // 遮罩有点击记录：没有任何记录，说明既没点到按钮，也没点到遮罩
    assert.deepEqual(await events(pageId), [], '被遮挡时不能派发点击');
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
    assert.equal(b.effects.new_pages.length, 1, 'new_page 报告新开的标签页');
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

  test('怪异模式（无 doctype）页面：视口是窗口大小不是内容高度，折叠线以下的按钮先滚动再点，不报 obscured', async () => {
    const pageId = await env.open('/pages/act-quirks.html');
    const page = env.session.pages.get(pageId);
    assert.deepEqual(
      await page.evaluate(() => [
        document.compatMode,
        document.documentElement.clientHeight > innerHeight,
      ]),
      ['BackCompat', true],
      '夹具页处于怪异模式：documentElement.clientHeight 是内容高度',
    );
    await ok({ op: 'click', pageId, target: { css: '#far' } });
    assert.deepEqual(await events(pageId), ['far:true']);
    assert.ok((await page.evaluate(() => scrollY)) > 0, '先把页面滚动到按钮处');
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

  test('对话框落在可操作性检查的最后一次求值里：dialog_blocking 就是没有派发，处理对话框后不会补发输入', {
    timeout: 60_000,
  }, async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    const value = () => page.$eval('#text', (e) => (e as HTMLInputElement).value);
    const actions: Action[] = [
      { op: 'fill', pageId, target: { css: '#text' }, value: 'AB' },
      { op: 'type_text', pageId, target: { css: '#text' }, text: 'AB' },
    ];
    for (const a of actions) {
      // 稳定性采样要等页面渲染两帧：在第一次 requestAnimationFrame 里弹出对话框，它就落在这次求值里
      await page.evaluate(() => {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => {
          window.requestAnimationFrame = raf;
          alert('求值期间的对话框');
          return raf(cb);
        };
      });
      const r = await err(a, 'dialog_blocking');
      assert.equal(r.effects.dialogs[0]?.handled, 'pending');
      // handle_dialog 会等悬空的处理函数收尾：它要是没停下，输入此时已经补发了
      await ok({ op: 'handle_dialog', pageId, action: 'accept' });
      assert.equal(await value(), '旧值', `${a.op} 没执行，输入框不该变`);
      assert.ok(!(await events(pageId)).some((e) => e.startsWith('input:')), '没有输入事件');
    }
    await ok({ op: 'fill', pageId, target: { css: '#text' }, value: 'AB' });
    assert.equal(await value(), 'AB');
  });

  test('页面第一次被 act 之前弹出的对话框也有记录：动作报 dialog_blocking，handle_dialog 能关掉它', {
    timeout: 60_000,
  }, async () => {
    // 页面只经过标签页登记，从没被 act 过（接管已有标签页、直接用 pages.newPage 开的页面都是这样）
    const pageId = await env.session.pages.newPage();
    const page = env.session.pages.get(pageId);
    const opened = new Promise<void>((resolve) => page.once('dialog', () => resolve()));
    await page.evaluate(() => {
      setTimeout(() => alert('act 之前弹出的提示'), 0);
    });
    await opened;
    await err({ op: 'click', pageId, target: { css: 'body' } }, 'dialog_blocking');
    const h = await ok({ op: 'handle_dialog', pageId, action: 'accept' });
    assert.deepEqual(h.effects.dialogs, [
      { type: 'alert', message: 'act 之前弹出的提示', handled: 'accept' },
    ]);
    assert.equal(await page.evaluate(() => 1 + 1), 2, '页面脚本已恢复');
    await ok({ op: 'close_page', pageId });
  });

  test('beforeunload：接受后导航完成，handle_dialog 的 navigated 为 true；取消离开页面没变', async () => {
    const leave = async () => {
      const pageId = await open();
      await env.session.pages.get(pageId).evaluate(() => {
        window.onbeforeunload = (e) => {
          e.preventDefault();
          return 'x';
        };
      });
      // 点击带用户激活，beforeunload 才会弹出
      const c = await ok({ op: 'click', pageId, target: { css: '#nav' } });
      assert.equal(c.effects.dialogs[0]?.type, 'beforeunload');
      assert.equal(c.effects.navigated, false, '对话框拦住了，导航还没发生');
      return pageId;
    };
    const stay = await leave();
    const dismissed = await ok({ op: 'handle_dialog', pageId: stay, action: 'dismiss' });
    assert.equal(dismissed.effects.navigated, false);
    assert.match(env.session.pages.get(stay).url(), /act-main/);
    const go = await leave();
    const accepted = await ok({ op: 'handle_dialog', pageId: go, action: 'accept' });
    assert.equal(accepted.effects.navigated, true);
    assert.match(env.session.pages.get(go).url(), /act-target/);
  });

  test('等待与后置检查期间弹出对话框：wait_for、post 报 dialog_blocking（条件未验证），不返回 ok、不等到超时', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    const later = () =>
      page.evaluate(() => {
        setTimeout(() => alert('稍后的提示'), 600);
      });
    // wait_for 没有页面副作用：对话框中途弹出时条件没验证出结果，不能当作“已执行”按 ok 返回
    await later();
    const t = Date.now();
    const w = await err(
      { op: 'wait_for', pageId, until: [{ text_present: '永远不会出现' }], timeout_ms: 8000 },
      'dialog_blocking',
    );
    assert.ok(Date.now() - t < 5000, `耗时 ${Date.now() - t}`);
    assert.deepEqual(w.effects.dialogs, [
      { type: 'alert', message: '稍后的提示', handled: 'pending' },
    ]);
    await ok({ op: 'handle_dialog', pageId, action: 'accept' });
    // 动作已派发、后置检查轮询时才弹出：检查的求值被挂起，不等满超时再报 assertion_failed
    await later();
    const t2 = Date.now();
    const p = await err(
      {
        op: 'press_key',
        pageId,
        key: 'Shift',
        post: [{ text_present: '永远不会出现' }],
        timeout_ms: 8000,
      },
      'dialog_blocking',
    );
    assert.ok(Date.now() - t2 < 5000, `耗时 ${Date.now() - t2}`);
    assert.equal(p.error?.details?.dispatched, true, '动作已执行，调用方不能当作可重试');
    await ok({ op: 'handle_dialog', pageId, action: 'accept' });
  });

  test('页面主线程无响应时动作按期限报 timeout，不等 CDP 的 180 秒；别的标签页有未处理的对话框时在 details 里列出', {
    timeout: 60_000,
  }, async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    const other = await open();
    await ok({ op: 'click', pageId: other, target: { css: '#alert' } });
    const arrived = new Promise<void>((resolve) => {
      onHold = resolve;
    });
    // 同步请求占住页面主线程（同进程的弹窗对话框、长任务造成的效果相同），直到放行
    const blocked = page
      .evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/api/hold', false);
        x.send();
      })
      .catch(() => {});
    try {
      await arrived;
      const t = Date.now();
      const r = await err(
        { op: 'click', pageId, target: { css: '#btn' }, timeout_ms: 1000 },
        'timeout',
      );
      assert.ok(Date.now() - t < 20_000, `耗时 ${Date.now() - t}`);
      assert.match(r.error?.message ?? '', /无响应.*handle_dialog.*close_page/);
      assert.deepEqual(r.error?.details?.dialogs, [
        { pageId: other, type: 'alert', message: '提示一下' },
      ]);
      await err({ op: 'press_key', pageId, key: 'Shift', timeout_ms: 1000 }, 'timeout');
    } finally {
      for (const res of held.splice(0)) res.writeHead(200).end('ok');
      await blocked;
    }
    // 别的标签页的对话框不影响本页：恢复响应后照常点击，超时的那次点击没有残留输入
    await ok({ op: 'click', pageId, target: { css: '#btn' } });
    assert.deepEqual(await events(pageId), ['click:true']);
    await ok({ op: 'handle_dialog', pageId: other, action: 'accept' });
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
    const bad = await err(
      { op: 'navigate_page', pageId, url: 'http://127.0.0.1:1/' },
      'navigation_failed',
    );
    assert.equal(bad.effects.navigated, false, '导航没有提交，页面没有变');
  });

  test('new_page 失败不留标签页：URL 无效、导航失败（含 timeout_ms 为 0）；页面挂着对话框时保留', async () => {
    const count = () => env.session.pages.list().length;
    const before = count();
    const bad = await err({ op: 'new_page', url: 'not a url' }, 'invalid_params');
    assert.deepEqual(bad.effects.new_pages, []);
    assert.equal(bad.effects.navigated, false);
    // timeout_ms 为 0 按立即超时处理（puppeteer 的 0 是不限时，会一直等下去）
    const hang = await err(
      { op: 'new_page', url: `${env.server.base}/api/hang`, timeout_ms: 0 },
      'navigation_failed',
    );
    assert.deepEqual(hang.effects.new_pages, [], '失败的标签页已关闭，不在 new_pages 里');
    assert.equal(count(), before, '没有留下标签页');
    // 加载时弹出对话框：导航等不到结果，但页面要留着让调用方 handle_dialog
    const alerted = await err(
      { op: 'new_page', url: `${env.server.base}/pages/act-alert-load.html`, timeout_ms: 800 },
      'navigation_failed',
    );
    const [kept] = alerted.effects.new_pages;
    assert.ok(kept, '有对话框挂着的标签页保留');
    await ok({ op: 'handle_dialog', pageId: kept, action: 'accept' });
    await ok({ op: 'close_page', pageId: kept });
    assert.equal(count(), before);
    // 带 pageId 的 new_page 失败后，编号随标签页一起释放，可以再用
    await err(
      { op: 'new_page', pageId: 'act-named', url: `${env.server.base}/api/hang`, timeout_ms: 0 },
      'navigation_failed',
    );
    assert.equal(count(), before, '带 pageId 失败的标签页也已关闭');
    await ok({ op: 'new_page', pageId: 'act-named' });
    await ok({ op: 'close_page', pageId: 'act-named' });
    assert.equal(count(), before);
  });

  test('导航地址白名单：只放行 http、https、about:blank 和工作区内的 file:，其余协议报 invalid_params 且不留标签页', async () => {
    const pageId = await open();
    const count = () => env.session.pages.list().length;
    const before = count();
    const inside = pathToFileURL(join(FILES, 'hello.txt')).href;
    // 工作区内的 file: 可以打开
    await ok({ op: 'navigate_page', pageId, url: inside });
    assert.equal(env.session.pages.get(pageId).url(), inside);
    await ok({ op: 'navigate_page', pageId, url: 'about:blank' });
    // 工作区外的 file:（含目录列表）、没配置 filesRoot 时的 file: 都不行
    const outside = pathToFileURL(join(FILES, '..', '..', 'package.json')).href;
    await err({ op: 'navigate_page', pageId, url: outside }, 'path_outside_workspace');
    await err(
      { op: 'navigate_page', pageId, url: pathToFileURL(dirname(FILES)).href },
      'path_outside_workspace',
    );
    await err({ op: 'navigate_page', pageId, url: inside }, 'invalid_params', {
      filesRoot: undefined,
    });
    for (const url of [
      'data:text/html,<h1>x</h1>',
      `view-source:${env.server.base}/pages/act-main.html`,
      'javascript:document.title="x"',
      'chrome://version/',
      'blob:http://127.0.0.1/x',
    ]) {
      await err({ op: 'navigate_page', pageId, url }, 'invalid_params');
      const r = await err({ op: 'new_page', url }, 'invalid_params');
      assert.deepEqual(r.effects.new_pages, []);
    }
    const bad = await err({ op: 'new_page', url: outside }, 'path_outside_workspace');
    assert.deepEqual(bad.effects.new_pages, []);
    assert.equal(count(), before, 'new_page 被拒绝时没有开标签页');
    const good = await ok({ op: 'new_page', url: inside });
    await ok({ op: 'close_page', pageId: good.effects.new_pages[0] as string });
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
    // 脚本自己抛出的文字像断连（Session closed、detached）也只是脚本出错，不能被当成浏览器断开
    await err(
      {
        op: 'evaluate_script',
        pageId,
        function: '() => { throw new Error("Session closed by server: element detached") }',
      },
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
    // 选择器无效不能当作“元素不存在”
    await err(
      { op: 'assert', pageId, checks: [{ element_absent: { css: '###' } }] },
      'invalid_params',
    );
    await err(
      { op: 'assert', pageId, checks: [{ element_present: { css: '###' } }] },
      'invalid_params',
    );
    const after = await ok({
      op: 'click',
      pageId,
      target: { css: '#btn' },
      screenshot: true,
      diff: true,
    });
    assert.ok(after.screenshot_path && existsSync(after.screenshot_path));
  });

  test('页面无响应时，element_absent、text_absent 不通过：求值没有结果不等于“没有”', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    const arrived = new Promise<void>((resolve) => {
      onHold = resolve;
    });
    // 同步请求占住页面主线程，直到放行
    const blocked = page
      .evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/api/hold', false);
        x.send();
      })
      .catch(() => {});
    try {
      await arrived;
      const r = await checkAssertions(
        env.session,
        pageId,
        [
          { element_absent: { css: '#btn' } },
          { text_absent: '点我' },
          { element_present: { css: '#btn' } },
          { text_present: '点我' },
        ],
        { timeoutMs: 300 },
      );
      assert.deepEqual(
        r.map((x) => x.pass),
        [false, false, false, false],
      );
      assert.match(r[0]?.detail ?? '', /无响应/);
      assert.match(r[1]?.detail ?? '', /无响应/);
    } finally {
      for (const res of held.splice(0)) res.writeHead(200).end('ok');
      await blocked;
    }
    // 恢复响应后按页面实际内容判定
    const after = await checkAssertions(
      env.session,
      pageId,
      [{ element_absent: { css: '#btn' } }, { text_absent: '不存在的文字' }],
      { timeoutMs: 3000 },
    );
    assert.deepEqual(
      after.map((x) => x.pass),
      [false, true],
    );
  });

  test('截图的 path 补 .png 后缀后仍在工作区内：指向工作区根目录本身时报错，不写到根目录的同级', async () => {
    const base = mkdtempSync(join(tmpdir(), 'obact-shot-'));
    const ws = join(base, 'ws');
    mkdirSync(ws);
    try {
      const pageId = await open();
      const opts = { filesRoot: ws, outDir: ws };
      await err({ op: 'take_screenshot', pageId, path: '.' }, 'path_outside_workspace', opts);
      await err({ op: 'take_screenshot', pageId, path: 'sub/..' }, 'path_outside_workspace', opts);
      assert.equal(existsSync(`${ws}.png`), false, '根目录的同级没有多出文件');
      const good = await ok({ op: 'take_screenshot', pageId, path: 'shots/a' }, opts);
      assert.equal(good.screenshot_path, join(ws, 'shots', 'a.png'));
      assert.ok(existsSync(join(ws, 'shots', 'a.png')));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('截图的 path 越出工作区被拒绝且不写盘：../、绝对路径、符号链接目录、悬空链接', async () => {
    const base = mkdtempSync(join(tmpdir(), 'obact-shot-'));
    const ws = join(base, 'ws');
    const out = join(base, 'out');
    mkdirSync(ws);
    mkdirSync(out);
    symlinkSync(out, join(ws, 'link'));
    symlinkSync(join(base, 'escape.png'), join(ws, 'dangling.png'));
    try {
      const pageId = await open();
      const opts = { filesRoot: ws, outDir: ws };
      const cases: [string, string][] = [
        ['../x.png', join(base, 'x.png')],
        [join(base, 'abs.png'), join(base, 'abs.png')],
        ['link/x.png', join(out, 'x.png')],
        ['dangling.png', join(base, 'escape.png')],
      ];
      for (const [path, written] of cases) {
        await err({ op: 'take_screenshot', pageId, path }, 'path_outside_workspace', opts);
        assert.equal(existsSync(written), false, `${path} 不应写到 ${written}`);
      }
      await ok({ op: 'take_screenshot', pageId, path: 'sub/ok.png' }, opts);
      assert.ok(existsSync(join(ws, 'sub', 'ok.png')), '工作区内的路径对照应写盘成功');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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

  test('失败结果统一带 error.details.dispatched：派发后才失败的为 true（含后置阶段的 page_not_found、invalid_params），派发前失败的为 false', async () => {
    const pageId = await open();
    // 输入已派发，后置检查阶段出错：调用方（工作流的单次提交）据此知道动作可能已生效，不能当作未发出重试
    const sig = await err(
      { op: 'press_key', pageId, key: 'Shift', post: [{ signature: '没有这个签名' }] },
      'invalid_params',
    );
    assert.equal(sig.error?.details?.dispatched, true);
    const gone = await err(
      { op: 'close_page', pageId, post: [{ text_present: '页面已经没了' }] },
      'page_not_found',
    );
    assert.equal(gone.error?.details?.dispatched, true);
    // 派发之前：定位失败、页面不存在、参数不符合契约
    const other = await open();
    const before: [Action, string][] = [
      [
        { op: 'click', pageId: other, target: { css: '#没有这个元素' }, timeout_ms: 300 },
        'not_found',
      ],
      [{ op: 'click', pageId: 'act-no-such', target: { css: '#btn' } }, 'page_not_found'],
      [{ op: 'click', pageId: other, target: { ref: 1 } } as unknown as Action, 'invalid_params'],
    ];
    for (const [a, code] of before) {
      const r = await err(a, code);
      assert.equal(r.error?.details?.dispatched, false, `${code}：${r.error?.message}`);
    }
  });

  test('参数不符合契约报 invalid_params；extract 在 M2', async () => {
    await err({ op: 'click', target: { ref: 1 } } as unknown as Action, 'invalid_params');
    // 入口收到 null、undefined 也只返回错误，不抛异常
    for (const bad of [null, undefined]) {
      const r = await act(env.session, bad as unknown as Action);
      assert.equal(r.status, 'error');
      assert.equal(r.error?.code, 'invalid_params');
    }
    const pageId = await open();
    await err(
      { op: 'extract', pageId, source: { type: 'response', url: 'x', path: 'a' } },
      'invalid_params',
    );
  });
});
