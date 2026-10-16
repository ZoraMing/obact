// BW-6 / BW-12 基准脚本的测试：脚本导出 run()，这里调用并断言达标。
//
// 覆盖：
//   1. BW-6 本地全部场景：动态属性 40 项全部命中；误点为 0；每一项与期望一致；改版夹具、Lab 改版按版本逐项核对；
//      遮挡有规则命中、无规则转人工；报告文件与逐项结果表齐全；
//   2. BW-12 本地全部场景：全部完成；DOM 位置全部换算成定位器，Canvas 上的点击保留坐标并标记易失效；
//      固化后的步骤逐行符合 step.json；回放一致；窗口缩小后定位器步骤照常成功；
//   3. BW-12 的读图与固化辅助：PNG 解码（五种行过滤）、读柱子、读节点、坐标换算的各条规则（单测）；
//   4. --live 模式的逻辑：容器访问不了公开站点，所以用本文件里按站点公开页面结构复刻的桩页跑通脚本逻辑，
//      并用桩站点收到的事件核对脚本确实点中了该点的元素。桩页通过不等于真实站点通过，真实站点没有实测过；
//   5. 站点不可达时如实报告；脚本里没有固定延时；
//   6. 内核问题（todo）：元素被祖先滚动容器裁掉、几何上却仍在视口内时，act 不滚动容器、报 obscured
//      （本地虚拟表格场景与桩站点的 Overlapped Element、Scrollbars 都是这一类）。按正确行为写断言，内核修好后去掉 todo。
//
// 单独运行：node --test bench/test/bw6-12.test.ts（BW-6 约 80 秒，BW-12 约 40 秒）
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { Contracts } from '@obact/schemas';
import { SKIP } from '../../fixtures/test/helpers.ts';
import { type Bw6Report, type Item, run as run6 } from '../bw6.ts';
import {
  type Bw12Report,
  decodePng,
  type Env,
  findBlob,
  type Raw,
  readBars,
  run as run12,
  solidify,
  startEnv,
} from '../bw12.ts';

const BENCH = new URL('..', import.meta.url).pathname;
const contracts = new Contracts();

// ---------------------------------------------------------------------------------------------
// 桩站点：按 UI Testing Playground 公开页面的结构复刻（页面结构、选择器、文案与站点一致）
// ---------------------------------------------------------------------------------------------

type Stub = { base: string; events: string[]; close(): Promise<void> };

const doc = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 14px/1.5 sans-serif; margin: 20px; }
  .btn { padding: 6px 12px; border: 1px solid #888; background: #eee; cursor: pointer; }
  .btn-success { background: #5cb85c; }
  .btn-primary { background: #337ab7; color: #fff; }
</style></head>
<body>${body}<script>
  function ev(n) { navigator.sendBeacon('/__e?n=' + encodeURIComponent(n)); }
  ${script}
</script></body></html>`;

const rid = () => Math.random().toString(36).slice(2, 10);

/** 站点各页：dynamicid、classattr、hiddenlayers、overlapped、animation、shadowdom、scrollbars、textinput、click、sampleapp。 */
const PAGES: Record<string, () => string> = {
  '/dynamicid': () =>
    doc(
      'Dynamic ID',
      `<h3>Dynamic ID</h3><button class="btn btn-primary" id="${rid()}" onclick="ev('dynamicid')">Button with Dynamic ID</button>`,
    ),
  // class 的组成与顺序每次加载都变；点击弹出 alert
  '/classattr': () => {
    const pick = ['class1', 'class2', 'class3', 'class4'].filter(() => Math.random() > 0.5);
    const cls = ['btn', 'btn-primary', ...pick].sort(() => Math.random() - 0.5).join(' ');
    return doc(
      'Class Attribute',
      `<h3>Class Attribute</h3>
<button class="${cls}" onclick="ev('classattr:primary'); alert('Primary button pressed')">Primary</button>
<button class="btn btn-warning" onclick="ev('classattr:warning')">Warning</button>
<button class="btn btn-success" onclick="ev('classattr:success')">Success</button>`,
    );
  },
  // 点绿色按钮后，蓝色层盖在它上面
  '/hiddenlayers': () =>
    doc(
      'Hidden Layers',
      `<h3>Hidden Layers</h3>
<button id="greenButton" class="btn btn-success" style="position:absolute;left:40px;top:100px;width:120px;height:40px"
  onclick="ev('hidden:green'); if (!document.getElementById('blueButton')) {
    var b = document.createElement('div'); b.id = 'blueButton'; b.className = 'btn btn-primary';
    b.style.cssText = 'position:absolute;left:40px;top:100px;width:120px;height:40px';
    b.onclick = function () { ev('hidden:blue'); }; document.body.appendChild(b); }">Button</button>`,
    ),
  // Name 输入框在内部滚动容器里，要滚动才露出来
  '/overlapped': () =>
    doc(
      'Overlapped Element',
      `<h3>Overlapped Element</h3>
<div id="box" style="width:300px;height:80px;overflow:auto;border:1px solid #888">
  <label for="id">Id</label> <input id="id" placeholder="Id">
  <div style="height:220px"></div>
  <label for="name">Name</label> <input id="name" placeholder="Name" oninput="ev('overlapped:name')">
</div>`,
    ),
  // 点“Start Animation”后，目标按钮用 600 毫秒平移到位
  '/animation': () =>
    doc(
      'Animation',
      `<h3>Animation</h3>
<button id="animationButton" class="btn btn-primary" onclick="ev('animation:start'); var t = document.getElementById('movingTarget'); t.style.transition = 'transform 600ms linear'; t.style.transform = 'translateX(300px)'">Start Animation</button>
<p><button id="movingTarget" class="btn btn-primary" onclick="ev('animation:target')">Moving Target</button></p>`,
    ),
  '/shadowdom': () =>
    doc(
      'Shadow DOM',
      '<h3>Shadow DOM</h3><guid-generator></guid-generator>',
      `customElements.define('guid-generator', class extends HTMLElement {
        connectedCallback() {
          const r = this.attachShadow({ mode: 'open' });
          r.innerHTML = '<input id="editField"><button id="buttonGenerate" class="btn btn-primary">Generate</button><button id="buttonCopy" class="btn btn-primary">Copy</button>';
          r.getElementById('buttonGenerate').onclick = () => ev('shadow:generate');
          r.getElementById('buttonCopy').onclick = () => ev('shadow:copy');
        }
      });`,
    ),
  '/scrollbars': () =>
    doc(
      'Scrollbars',
      `<h3>Scrollbars</h3>
<div style="width:250px;height:200px;overflow:scroll;border:1px solid #888"><div style="width:800px;height:800px">
<button id="hidingButton" class="btn btn-primary" style="margin:500px 0 0 450px" onclick="ev('scrollbars')">Hiding Button</button></div></div>`,
    ),
  '/textinput': () =>
    doc(
      'Text Input',
      `<h3>Text Input</h3>
<div class="form-group"><label for="newButtonName">Set New Button Name</label>
<input class="form-control" id="newButtonName" placeholder="MyButton" type="text"></div>
<button class="btn btn-primary" id="updatingButton" type="button"
  onclick="this.textContent = document.getElementById('newButtonName').value">Button That Should Change it's Name Based on Input Value</button>`,
    ),
  // 只认真实鼠标：脚本合成的 click 无效，可信的 mouseup 才生效
  '/click': () =>
    doc(
      'Click',
      `<h3>Click</h3><button id="badButton" class="btn btn-primary">Button That Ignores DOM Click Event</button>`,
      `document.getElementById('badButton').addEventListener('mouseup', function (e) {
        if (e.isTrusted) { this.className = 'btn btn-success'; ev('click:real'); }
      });`,
    ),
  '/sampleapp': () =>
    doc(
      'Sample App',
      `<h3>Sample App</h3>
<div><input type="text" name="UserName" placeholder="User Name"></div>
<div><input type="password" name="Password" placeholder="********"></div>
<button type="button" class="btn btn-primary" id="login">Log In</button>
<label id="loginstatus">User logged out.</label>`,
      `document.getElementById('login').onclick = function () {
        var u = document.querySelector('[name=UserName]').value, p = document.querySelector('[name=Password]').value;
        document.getElementById('loginstatus').textContent = u && p === 'pwd' ? 'Welcome, ' + u + '!' : 'Invalid username/password';
      };`,
    ),
};

async function startStub(): Promise<Stub> {
  const events: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/__e') {
      events.push(url.searchParams.get('n') ?? '');
      res.writeHead(204).end();
      return;
    }
    const page = PAGES[url.pathname];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    events,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const count = (events: string[], name: string) => events.filter((e) => e === name).length;

// ---------------------------------------------------------------------------------------------
// BW-6
// ---------------------------------------------------------------------------------------------

describe('BW-6 定位可靠性', { skip: SKIP }, () => {
  let out: string;
  let report: Bw6Report;
  const by = (group: string): Item[] => report.items.filter((i) => i.group === group);
  /** 按钮几何上在视口内、却被滚动容器裁掉：内核问题（act 不滚动容器），见本文件最后的 todo。 */
  const clippedInView = (i: Item) => i.group === '滚动到可见' && i.scenario.includes('在视口内');

  before(async () => {
    out = mkdtempSync(join(tmpdir(), 'obact-bw6-test-'));
    report = await run6({ outDir: out, quiet: true });
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('动态属性：4 种刷新方式 × 10 项全部命中，且刷新后 id 与类名确实全变', () => {
    const dyn = by('动态属性');
    assert.equal(dyn.length, 40);
    assert.ok(
      dyn.every((i) => i.outcome === 'hit'),
      dyn
        .filter((i) => i.outcome !== 'hit')
        .map((i) => `${i.scenario} ${i.element}：${i.detail}`)
        .join('\n'),
    );
    // 场景名里记着刷新后沿用的 id 与类名个数：指定 seed 时必须全是新的；不带 seed 的随机刷新偶尔会撞上个别名字
    for (const i of dyn) {
      const kept = Number(/沿用 (\d+)\//.exec(i.scenario)?.[1]);
      const max = i.scenario.includes('随机') ? 3 : 0;
      assert.ok(kept <= max, `${i.scenario}：沿用 ${kept} 个，最多 ${max} 个`);
    }
    assert.equal(new Set(dyn.map((i) => i.scenario)).size, 4);
  });

  test('误点为 0；转人工的错误码都在允许范围内；定位器命中都走 css 或 role', () => {
    assert.equal(
      report.summary.wrong,
      0,
      JSON.stringify(report.items.filter((i) => i.outcome === 'wrong')),
    );
    assert.equal(report.summary.unexpected, 0);
    for (const i of report.items.filter((x) => x.outcome === 'hit')) {
      assert.ok(i.via === 'css' || i.via === 'role', `${i.scenario} ${i.element} 走了 ${i.via}`);
    }
    for (const i of report.items.filter((x) => x.outcome === 'manual')) {
      assert.ok(i.code, `${i.scenario} ${i.element} 转人工没有错误码`);
    }
  });

  test('每一项的结果与期望一致（按钮在视口内却被滚动容器裁掉的一项另见 todo）', () => {
    const bad = report.items.filter((i) => i.outcome !== i.expected && !clippedInView(i));
    assert.deepEqual(
      bad.map(
        (i) =>
          `${i.group} | ${i.scenario} | ${i.element}：期望 ${i.expected}，实际 ${i.outcome}（${i.detail}）`,
      ),
      [],
    );
  });

  test('各场景都有结果，数量与设计一致', () => {
    const n = (g: string) => by(g).length;
    assert.equal(n('动态属性'), 40);
    assert.equal(n('Shadow DOM'), 12);
    assert.equal(n('隐藏层'), 2);
    assert.equal(n('遮挡'), 6);
    assert.equal(n('动画按钮'), 3);
    assert.equal(n('滚动到可见'), 3);
    assert.equal(n('改版夹具'), 126, '7 个版本 × 18 个元素');
    assert.equal(n('Lab 改版'), 45, '5 个改版 × 9 个元素');
    assert.equal(report.summary.total, report.items.length);
    assert.equal(
      report.summary.hit + report.summary.manual + report.summary.wrong,
      report.items.length,
    );
  });

  test('隐藏层与遮挡：盖住时转人工（obscured），有规则处理后命中，没有误点', () => {
    const hidden = by('隐藏层');
    assert.equal(hidden[0]?.outcome, 'hit');
    assert.equal(hidden[1]?.outcome, 'manual');
    assert.equal(hidden[1]?.code, 'obscured');
    const cover = by('遮挡');
    assert.equal(cover.length, 6);
    for (const [k, i] of cover.entries()) {
      assert.equal(i.outcome, k % 2 === 0 ? 'manual' : 'hit', `${i.scenario}：${i.detail}`);
      if (k % 2 === 0) assert.equal(i.code, 'obscured', i.scenario);
    }
  });

  test('动画按钮：等位置稳定后命中；一直在动的按钮转人工 not_actionable', () => {
    const anim = by('动画按钮');
    assert.deepEqual(
      anim.map((i) => i.outcome),
      ['hit', 'hit', 'manual'],
    );
    assert.equal(anim[2]?.code, 'not_actionable');
  });

  test('滚动到可见：刷新后回放先滚动再点击，命中（前提：按钮确实被容器裁掉或在视口下方）', () => {
    const sc = by('滚动到可见');
    assert.equal(sc.length, 3);
    // 虚拟表格：按钮在视口外、被容器裁掉；Lab 订单列表：按钮在视口下方
    assert.ok(sc[0]?.scenario.includes('在视口外，被滚动容器裁掉'), sc[0]?.scenario);
    assert.ok(sc[1]?.scenario.includes('在视口内，但被滚动容器裁掉'), sc[1]?.scenario);
    assert.ok(sc[2]?.scenario.includes('在视口下方'), sc[2]?.scenario);
    for (const i of sc.filter((x) => !clippedInView(x))) {
      assert.equal(i.outcome, 'hit', `${i.scenario}：${i.detail}`);
    }
    // 在视口内的那一项：前提要成立（按钮确实被容器裁掉、整个在视口内），否则场景本身就错了
    assert.ok(!sc[1]?.detail.includes('前提不成立'), sc[1]?.detail);
    assert.notEqual(sc[1]?.outcome, 'wrong', '不能误点');
  });

  test('Shadow DOM：开放、嵌套开放、封闭（刷新后直接回放与先 observe 再回放）全部命中', () => {
    const sh = by('Shadow DOM');
    assert.equal(sh.length, 12);
    for (const i of sh) assert.equal(i.outcome, 'hit', `${i.scenario} ${i.element}：${i.detail}`);
    assert.equal(
      sh.filter((i) => i.scenario.includes('直接回放') && i.element.includes('封闭')).length,
      4,
    );
    assert.equal(sh.filter((i) => i.scenario.includes('先 observe')).length, 4);
  });

  test('改版夹具逐版本：v0~v3 全部命中；v4、v5 冲突的元素转人工；v6 全部转人工；误点为 0', () => {
    const per = (v: string) => by('改版夹具').filter((i) => i.scenario.startsWith(`${v} `));
    const count = (xs: Item[], o: Item['outcome']) => xs.filter((i) => i.outcome === o).length;
    for (const v of ['v0', 'v1', 'v2', 'v3']) {
      assert.equal(count(per(v), 'hit'), 18, `${v} 应全部命中`);
    }
    assert.equal(count(per('v4'), 'manual'), 4);
    assert.equal(count(per('v4'), 'hit'), 14);
    assert.equal(count(per('v5'), 'manual'), 4);
    assert.equal(count(per('v5'), 'hit'), 14);
    assert.equal(count(per('v6'), 'manual'), 18);
    for (const v of ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'])
      assert.equal(count(per(v), 'wrong'), 0, v);
  });

  test('Lab 订单列表逐改版：原版全命中；改版后失效的转人工，没有误点；全面改版全部转人工', () => {
    const per = (k: number) =>
      by('Lab 改版').filter((i) => i.scenario.startsWith(`redesign=${k} `));
    for (const k of [0, 1, 2, 3, 4]) {
      assert.equal(per(k).length, 9, `redesign=${k}`);
      assert.equal(per(k).filter((i) => i.outcome === 'wrong').length, 0, `redesign=${k} 误点`);
    }
    assert.equal(per(0).filter((i) => i.outcome === 'hit').length, 9);
    assert.equal(per(4).filter((i) => i.outcome === 'manual').length, 9);
    // 改 id 与类名（1）：只有靠类名的行内勾选框失效；改文案（2）：只有靠文案的“下一页”失效
    const manual1 = per(1).filter((i) => i.outcome === 'manual');
    assert.equal(manual1.length, 1);
    assert.match(manual1[0]?.element ?? '', /^勾选订单 \d+$/);
    const manual2 = per(2).filter((i) => i.outcome === 'manual');
    assert.deepEqual(
      manual2.map((i) => i.element),
      ['分页“下一页”'],
    );
  });

  test('报告：结论、汇总、逐项结果表齐全；逐项条数与结果一致；写入输出目录', () => {
    assert.ok(report.reportPath.startsWith(out));
    assert.ok(existsSync(report.reportPath) && existsSync(report.jsonPath));
    const md = readFileSync(report.reportPath, 'utf8');
    for (const s of [
      '## 结论',
      '## 汇总',
      '## 改版夹具逐版本',
      '## Lab 订单列表逐改版',
      '## 逐项结果',
      '| 命中 | 转人工 | 误点 |',
    ]) {
      assert.ok(md.includes(s), `报告缺少 ${s}`);
    }
    const rows = md.split('\n').filter((l) => /^\| \d+ \| /.test(l));
    assert.equal(rows.length, report.items.length);
    const json = JSON.parse(readFileSync(report.jsonPath, 'utf8')) as Bw6Report;
    assert.equal(json.items.length, report.items.length);
    assert.equal(json.pass, report.pass);
    // 与期望不一致的项在表里有标记
    const flagged = rows.filter((l) => l.includes('与期望不符')).length;
    assert.equal(flagged, report.summary.mismatched);
  });

  test('与期望不符的项只有“按钮在视口内却被滚动容器裁掉”一项（内核问题，见 todo）', () => {
    const bad = report.items.filter((i) => i.outcome !== i.expected);
    assert.equal(bad.length, report.summary.mismatched);
    assert.ok(bad.every(clippedInView), bad.map((i) => i.element).join('、'));
  });

  // 内核问题（todo）：写基准脚本时发现，按正确行为断言；内核修好后去掉 todo
  test('按钮几何上在视口内、却被滚动容器裁掉：存下的定位器回放应先滚动容器再点中', {
    todo: '内核：act 判断“在视口内”时没有考虑祖先滚动容器的裁剪，不会滚动容器，点击点落在容器外的 html 上，连续 3 次后报 obscured（hit 为 html）；元素整个在视口外时才会滚动。对 click、hover、fill 都一样',
  }, () => {
    const item = by('滚动到可见').find(clippedInView);
    assert.ok(item);
    assert.equal(item.outcome, 'hit', `${item.outcome}：${item.detail}`);
  });
});

// ---------------------------------------------------------------------------------------------
// BW-12
// ---------------------------------------------------------------------------------------------

describe('BW-12 视觉观察与坐标动作', { skip: SKIP }, () => {
  let out: string;
  let report: Bw12Report;
  const scene = (id: string) => {
    const s = report.scenes.find((x) => x.id === id);
    assert.ok(s, `没有场景 ${id}`);
    return s;
  };

  before(async () => {
    out = mkdtempSync(join(tmpdir(), 'obact-bw12-test-'));
    report = await run12({ outDir: out, quiet: true });
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('全部完成：坐标阶段、固化后回放、窗口缩小后的定位器步骤都通过', () => {
    assert.deepEqual(report.failures, []);
    assert.equal(report.pass, true);
    const s = report.summary;
    assert.equal(s.scenes, 4);
    assert.equal(s.plans, 20);
    assert.equal(s.coordsFailed, 0);
    assert.equal(s.replayFailed, 0);
    assert.equal(s.resizedFailed, 0);
    assert.equal(s.kindMismatch, 0);
    assert.equal(s.stepErrors, 0);
    assert.equal(s.factsFailed, 0);
  });

  test('有 DOM 元素的位置全部换算成定位器；Canvas 上的点保留坐标并标记易失效', () => {
    // 只要在 Canvas 里（柱子、节点）就保留坐标；其余坐标动作都换算成定位器或滚动
    for (const sc of report.scenes) {
      for (const p of sc.plans) {
        for (const r of p.rows) {
          if (r.kind === 'plain') continue;
          if (r.under.startsWith('canvas'))
            assert.equal(r.kind, 'volatile', `${sc.title}：${r.coord}`);
          else
            assert.notEqual(r.kind, 'volatile', `${sc.title}：${r.coord} 落在 ${r.under}，应换算`);
        }
      }
    }
    const s = report.summary;
    assert.equal(s.coordinateSteps, 20);
    assert.equal(s.volatile, 4, '3 根柱子 + 1 个节点拖拽');
    assert.equal(s.locator, 13);
    assert.equal(s.page, 2);
    assert.equal(s.container, 1);
    // 画布夹具：三次点柱子是 volatile，两个按钮和悬停是定位器
    const kinds = scene('canvas').plans.map((p) => p.rows.map((r) => r.kind).join());
    assert.deepEqual(kinds, ['locator', 'locator', 'volatile', 'volatile', 'locator', 'volatile']);
  });

  test('读图：编号框截图尺寸、框的位置、读出的柱子与节点都核对通过', () => {
    for (const sc of report.scenes) {
      assert.ok(sc.facts.length >= 2, sc.title);
      for (const f of sc.facts) assert.ok(f.ok, `${sc.title}：${f.label}（${f.detail}）`);
    }
    const labels = scene('canvas').facts.map((f) => f.label);
    assert.ok(labels.includes('从截图读出的柱子数量'));
    assert.ok(labels.includes('读出的柱高与数据成比例'));
    assert.ok(scene('board').facts.some((f) => f.label.includes('节点')));
  });

  test('固化后的步骤：JSONL 逐行符合 step.json；带坐标的步骤都标了 volatile，其余没有坐标；不含编号', () => {
    for (const sc of report.scenes) {
      assert.ok(sc.jsonlPath && existsSync(sc.jsonlPath), `${sc.id} 的 JSONL 没写出来`);
      const lines = readFileSync(sc.jsonlPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, sc.steps.length);
      const ids = new Set<string>();
      for (const [k, line] of lines.entries()) {
        const row = JSON.parse(line) as Record<string, unknown>;
        assert.deepEqual(row, sc.steps[k], `${sc.id} 第 ${k + 1} 行与结果不一致`);
        assert.equal(contracts.check('step', row), null, `${sc.id} 第 ${k + 1} 行：${line}`);
        assert.equal(row.pageId, 'main');
        assert.ok(!ids.has(row.step_id as string), `${sc.id} step_id 重复`);
        ids.add(row.step_id as string);
        const coords =
          row.x !== undefined ||
          row.at !== undefined ||
          Array.isArray(row.from) ||
          Array.isArray(row.to);
        assert.equal(
          row.volatile === true,
          coords,
          `${sc.id} ${row.step_id}：volatile 与坐标不一致`,
        );
        assert.ok(!line.includes('"ref"'), '步骤里不能有编号');
      }
      assert.equal((sc.steps[0] as { op: string }).op, 'navigate_page');
      assert.equal((sc.steps[0] as { section: string }).section, 'preamble');
    }
  });

  test('各类换算的结果：按钮 → click/hover 定位器；拖拽卡片 → 两端都是定位器；整页滚轮去掉坐标；滚动容器 → 定位器', () => {
    const rows = (id: string) => scene(id).steps as Record<string, unknown>[];
    const loc = (r: Record<string, unknown> | undefined) =>
      (r?.target ?? {}) as { css?: string; role?: string; within?: string };
    const canvas = rows('canvas');
    assert.equal(canvas[2]?.op, 'hover');
    assert.equal(loc(canvas[2]).role, 'button');
    assert.equal(canvas.filter((r) => r.op === 'click_at' && r.volatile === true).length, 3);
    const lab = rows('lab-orders');
    const scrolls = lab.filter((r) => r.op === 'scroll');
    assert.equal(scrolls.length, 2);
    for (const s of scrolls) {
      assert.equal(s.at, undefined);
      assert.equal(s.target, undefined);
      assert.equal(s.volatile, undefined);
    }
    const approve = lab.find(
      (r) => r.op === 'click' && (r.target as { css?: string }).css === 'button.row-approve',
    );
    assert.match(loc(approve).within ?? '', /^tr\[data-id='\d+'\]$/);
    const vt = rows('virtual-table').find((r) => r.op === 'scroll');
    assert.equal(loc(vt).css, 'div[id="viewport"]');
    const drags = rows('board').filter((r) => r.op === 'drag');
    assert.equal(drags.length, 3);
    assert.ok(
      !Array.isArray(drags[0]?.from) && !Array.isArray(drags[0]?.to),
      '卡片拖到列：两端都是定位器',
    );
    assert.equal(drags[0]?.volatile, undefined);
    assert.ok(
      Array.isArray(drags[2]?.from) && Array.isArray(drags[2]?.to),
      '画布里拖节点：保留坐标',
    );
    assert.equal(drags[2]?.volatile, true);
  });

  test('窗口缩小后：定位器步骤全部照常成功，易失效的坐标步骤结果变了（所以要标易失效）', () => {
    const volatilePlans = report.scenes.flatMap((s) => s.plans).filter((p) => p.volatile);
    assert.equal(volatilePlans.length, 4);
    for (const p of report.scenes.flatMap((s) => s.plans).filter((x) => !x.volatile)) {
      assert.ok(p.resized.ok, `${p.title}：${p.resized.detail}`);
    }
    // 柱子的坐标在窗口缩小后点偏（点在空隙上或出了视口）；画布里的节点也抓不到
    assert.ok(
      report.summary.resizedVolatileDiverged >= 3,
      `易失效步骤变化 ${report.summary.resizedVolatileDiverged}`,
    );
  });

  test('报告：结论、汇总、逐场景表和 JSONL 齐全；步骤目录里每个场景一个文件', () => {
    const md = readFileSync(report.reportPath, 'utf8');
    for (const s of [
      '## 结论：通过',
      '## 汇总',
      '## 逐场景',
      '```jsonl',
      '| 坐标阶段 | 固化后回放 | 窗口缩小后回放 |',
    ]) {
      assert.ok(md.includes(s), `报告缺少 ${s}`);
    }
    for (const sc of report.scenes) assert.ok(md.includes(`### ${sc.title}`), sc.title);
    const json = JSON.parse(readFileSync(report.jsonPath, 'utf8')) as Bw12Report;
    assert.equal(json.summary.plans, 20);
    assert.deepEqual(readdirSync(report.stepsDir).sort(), [
      'board.jsonl',
      'canvas.jsonl',
      'lab-orders.jsonl',
      'virtual-table.jsonl',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// BW-12 的读图辅助（单测，不需要浏览器）
// ---------------------------------------------------------------------------------------------

/** 测试用的 PNG 编码：按行轮换五种过滤类型（含 Paeth），RGB 或 RGBA。 */
function encodePng(w: number, h: number, rgba: Uint8Array, opts: { rgb?: boolean } = {}): Buffer {
  const bpp = opts.rgb ? 3 : 4;
  const stride = w * bpp;
  const px = new Uint8Array(h * stride);
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < bpp; c++) px[i * bpp + c] = rgba[i * 4 + c] as number;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ft = y % 5;
    raw[y * (stride + 1)] = ft;
    for (let i = 0; i < stride; i++) {
      const cur = px[y * stride + i] as number;
      const left = i >= bpp ? (px[y * stride + i - bpp] as number) : 0;
      const up = y > 0 ? (px[(y - 1) * stride + i] as number) : 0;
      const upLeft = y > 0 && i >= bpp ? (px[(y - 1) * stride + i - bpp] as number) : 0;
      let pred = 0;
      if (ft === 1) pred = left;
      else if (ft === 2) pred = up;
      else if (ft === 3) pred = (left + up) >> 1;
      else if (ft === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      raw[y * (stride + 1) + 1 + i] = (cur - pred) & 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opts.rgb ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画布：白底，按需画矩形和圆（颜色 RGB，坐标为图像像素）。 */
function canvas(w: number, h: number) {
  const data = new Uint8Array(w * h * 4).fill(255);
  const set = (x: number, y: number, c: [number, number, number]) => {
    const o = (y * w + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
  };
  return {
    data,
    rect(x: number, y: number, rw: number, rh: number, c: [number, number, number]) {
      for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) set(i, j, c);
    },
    disc(cx: number, cy: number, r: number, c: [number, number, number]) {
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) if (Math.hypot(i + 0.5 - cx, j + 0.5 - cy) <= r) set(i, j, c);
    },
  };
}

describe('BW-12 读图辅助', () => {
  test('PNG 解码：RGBA 与 RGB，五种行过滤类型，像素原样还原', () => {
    const w = 37;
    const h = 23;
    const src = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = (i * 7) & 255;
      src[i * 4 + 1] = (i * 13 + (i >> 3)) & 255;
      src[i * 4 + 2] = (i * 29 + 5) & 255;
      src[i * 4 + 3] = 255;
    }
    for (const rgb of [false, true]) {
      const png = decodePng(encodePng(w, h, src, { rgb }));
      assert.equal(png.w, w);
      assert.equal(png.h, h);
      assert.deepEqual(Buffer.from(png.rgba), Buffer.from(src), rgb ? 'RGB' : 'RGBA');
    }
    assert.throws(() => decodePng(Buffer.from('not a png')), /PNG/);
  });

  test('读柱子：按缩放比例换回视口像素；柱底、柱顶、数量都对；也认被点中的橙色柱', () => {
    // 视口 300×200，缩放 2：图像 600×400。5 根柱子，宽 30、间隔 20（视口像素），柱底在视口 y=150
    const scale = 2;
    const c = canvas(600, 400);
    const heights = [40, 90, 60, 100, 20];
    heights.forEach((hh, i) => {
      const color: [number, number, number] = i === 2 ? [0xe6, 0x7e, 0x22] : [0x4a, 0x90, 0xd9];
      c.rect((30 + i * 50) * scale, (150 - hh) * scale, 30 * scale, hh * scale, color);
    });
    c.rect(20 * scale, 150 * scale, 260 * scale, 2, [0x99, 0x99, 0xaa]); // 坐标轴不是柱子
    const png = decodePng(encodePng(600, 400, c.data));
    const bars = readBars(png, [10, 10, 280, 180], scale);
    assert.equal(bars.length, 5);
    bars.forEach((b, i) => {
      assert.ok(Math.abs(b.cx - (30 + i * 50 + 15)) <= 1, `第 ${i + 1} 根 cx=${b.cx}`);
      assert.ok(Math.abs(b.bottom - 150) <= 1, `第 ${i + 1} 根柱底 ${b.bottom}`);
      assert.ok(
        Math.abs(b.bottom - b.top - (heights[i] as number)) <= 1,
        `第 ${i + 1} 根高度 ${b.bottom - b.top}`,
      );
    });
    assert.deepEqual(readBars(png, [0, 0, 20, 20], scale), [], '区域里没有柱子');
  });

  test('读节点：按颜色找一团像素，给出中心与半径；找不到返回 null', () => {
    const c = canvas(400, 300);
    c.disc(120.5, 90.5, 15, [0xe6, 0x7e, 0x22]);
    c.disc(300.5, 200.5, 15, [0x27, 0xae, 0x60]);
    const png = decodePng(encodePng(400, 300, c.data));
    const a = findBlob(png, [0, 0, 400, 300], [0xe6, 0x7e, 0x22], 1);
    assert.ok(
      a && Math.abs(a.cx - 120.5) < 0.6 && Math.abs(a.cy - 90.5) < 0.6 && Math.abs(a.r - 15) < 1,
      JSON.stringify(a),
    );
    const b = findBlob(png, [200, 100, 200, 200], [0x27, 0xae, 0x60], 1);
    assert.ok(b && Math.abs(b.cx - 300.5) < 0.6 && Math.abs(b.cy - 200.5) < 0.6, JSON.stringify(b));
    assert.equal(findBlob(png, [0, 0, 100, 100], [0x27, 0xae, 0x60], 1), null);
    // 缩放 2：同一团像素换回视口像素
    const c2 = canvas(400, 300);
    c2.disc(120, 90, 30, [0xe6, 0x7e, 0x22]);
    const big = findBlob(
      decodePng(encodePng(400, 300, c2.data)),
      [0, 0, 200, 150],
      [0xe6, 0x7e, 0x22],
      2,
    );
    assert.ok(
      big && Math.abs(big.cx - 60) < 0.6 && Math.abs(big.cy - 45) < 0.6 && Math.abs(big.r - 15) < 1,
      JSON.stringify(big),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// BW-12 坐标换算的各条规则（单测，需要浏览器）
// ---------------------------------------------------------------------------------------------

describe('BW-12 坐标固化规则', { skip: SKIP }, () => {
  let env: Env;
  before(async () => {
    env = await startEnv({ local: true });
  });
  after(async () => {
    await env?.close();
  });

  const solid = async (pageId: string, raw: Raw) => solidify(env, pageId, raw);
  const base = () => (env.fixtures as { base: string }).base;
  const centerOf = async (pageId: string, selector: string): Promise<[number, number]> =>
    env.session.pages.get(pageId).evaluate((sel) => {
      const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2] as [number, number];
    }, selector);

  test('按钮 → 定位器；Canvas → 保留坐标；页面背景 → 保留坐标；悬停同理', async () => {
    const pageId = await env.newPage();
    await env.session.pages.get(pageId).goto(`${base()}/canvas/?seed=3`, { waitUntil: 'load' });
    const [bx, by] = await centerOf(pageId, '#export');
    const click = await solid(pageId, { op: 'click_at', x: bx, y: by });
    assert.equal(click.kind, 'locator');
    assert.equal(click.row.op, 'click');
    assert.equal(click.row.x, undefined);
    assert.equal(click.row.volatile, undefined);
    assert.equal((click.row.target as { name: string }).name, '导出图片');
    const hover = await solid(pageId, { op: 'mouse_move', x: bx, y: by });
    assert.equal(hover.kind, 'locator');
    assert.equal(hover.row.op, 'hover');
    // 双击、右键等修饰字段带到定位器写法里
    const dbl = await solid(pageId, {
      op: 'click_at',
      x: bx,
      y: by,
      double: true,
      button: 'right',
    });
    assert.equal(dbl.row.op, 'click');
    assert.equal(dbl.row.double, true);
    assert.equal(dbl.row.button, 'right');

    const [cx, cy] = await centerOf(pageId, '#chart');
    const onCanvas = await solid(pageId, { op: 'click_at', x: cx, y: cy });
    assert.equal(onCanvas.kind, 'volatile');
    assert.equal(onCanvas.row.op, 'click_at');
    assert.equal(onCanvas.row.volatile, true);
    assert.equal(onCanvas.row.x, cx);
    assert.match(onCanvas.under, /^canvas/);
    const move = await solid(pageId, { op: 'mouse_move', x: cx, y: cy });
    assert.equal(move.kind, 'volatile');
    assert.equal(move.row.op, 'mouse_move');

    const bg = await solid(pageId, { op: 'click_at', x: 3, y: 3 });
    assert.equal(bg.kind, 'volatile', `页面背景：${bg.why}`);
    assert.equal(bg.row.volatile, true);
    // 不是坐标动作：原样
    const key = await solid(pageId, { op: 'press_key', key: 'Enter' });
    assert.equal(key.kind, 'plain');
    assert.deepEqual(key.row, { op: 'press_key', key: 'Enter' });
  });

  test('定位器不唯一的位置保留坐标并说明原因', async () => {
    const pageId = await env.newPage();
    const page = env.session.pages.get(pageId);
    // 两张一模一样的卡片，没有任何可区分的属性或文字以外的特征
    await page.setContent(
      '<div class="card" style="width:200px;height:40px;margin:10px" onclick="1">甲</div><div class="card" style="width:200px;height:40px;margin:10px" onclick="1">甲</div>',
    );
    const [x, y] = await centerOf(pageId, '.card');
    const s = await solid(pageId, { op: 'click_at', x, y });
    assert.equal(s.kind, 'volatile');
    assert.match(s.why, /不唯一/);
    assert.equal(s.row.volatile, true);
    assert.match(String(s.row.note), /不唯一/);
  });

  test('拖拽：两端都在 DOM 元素上 → 都换成定位器；一端在 Canvas 里 → 该端保留坐标并标记易失效', async () => {
    const pageId = await env.newPage();
    await env.session.pages.get(pageId).goto(`${base()}/canvas/?seed=3`, { waitUntil: 'load' });
    const a = await centerOf(pageId, '#refresh');
    const b = await centerOf(pageId, '#clear');
    const both = await solid(pageId, { op: 'drag', from: a, to: b });
    assert.equal(both.kind, 'locator');
    assert.ok(!Array.isArray(both.row.from) && !Array.isArray(both.row.to));
    assert.equal(both.row.volatile, undefined);
    const c = await centerOf(pageId, '#chart');
    const mixed = await solid(pageId, { op: 'drag', from: a, to: c });
    assert.equal(mixed.kind, 'volatile');
    assert.ok(!Array.isArray(mixed.row.from), '起点是按钮，换成定位器');
    assert.deepEqual(mixed.row.to, c, '终点在 Canvas 里，保留坐标');
    assert.equal(mixed.row.volatile, true);
  });

  test('滚轮：坐标下没有内部滚动容器 → 整页滚动；有 → 以容器的定位器为目标；方向没有可滚的内容 → 仍是整页', async () => {
    const pageId = await env.newPage();
    const page = env.session.pages.get(pageId);
    await page.goto(`${base()}/virtual-table/?seed=3`, { waitUntil: 'load' });
    await env.run({
      op: 'wait_for',
      pageId,
      until: [{ element_present: { role: 'button', name: '查看' } }],
    });
    const [vx, vy] = await centerOf(pageId, '#viewport');
    const inner = await solid(pageId, { op: 'scroll', at: [vx, vy], dy: 500 });
    assert.equal(inner.kind, 'container');
    assert.equal(inner.row.at, undefined);
    assert.equal((inner.row.target as { css: string }).css, 'div[id="viewport"]');
    assert.equal(inner.row.dy, 500);
    // 容器只能纵向滚：横向滚轮不归它管
    const sideways = await solid(pageId, { op: 'scroll', at: [vx, vy], dx: 300 });
    assert.equal(sideways.kind, 'page');
    // 标题上方：不在容器里
    const [hx, hy] = await centerOf(pageId, 'h1');
    const outer = await solid(pageId, { op: 'scroll', at: [hx, hy], dy: 300 });
    assert.equal(outer.kind, 'page');
    assert.equal(outer.row.at, undefined);
    assert.equal(outer.row.target, undefined);
    assert.equal(outer.row.volatile, undefined);
    assert.equal(outer.row.dy, 300);
    // 不给坐标的滚动原样
    assert.equal((await solid(pageId, { op: 'scroll', dy: 100 })).kind, 'plain');
  });
});

// ---------------------------------------------------------------------------------------------
// --live 模式：桩站点
// ---------------------------------------------------------------------------------------------

describe('--live 模式（桩站点，真实站点未实测）', { skip: SKIP }, () => {
  let stub: Stub;
  let out: string;
  /** BW-6 公开站点的结果与桩站点收到的事件（第一个测试填，内核问题的 todo 复用）。 */
  let live6: { report: Bw6Report; events: string[] } | undefined;
  before(async () => {
    stub = await startStub();
    out = mkdtempSync(join(tmpdir(), 'obact-bw-live-test-'));
  });
  after(async () => {
    await stub?.close();
    rmSync(out, { recursive: true, force: true });
  });

  test('BW-6：7 个公开页面的逻辑跑通，结果与期望一致，桩站点收到的点击落在对的元素上', async () => {
    stub.events.length = 0;
    const r = await run6({
      local: false,
      live: true,
      liveBase: stub.base,
      outDir: out,
      quiet: true,
    });
    live6 = { report: r, events: [...stub.events] };
    assert.equal(r.live.reachable, true);
    assert.equal(r.live.items.length, 10);
    assert.ok(r.live.note.includes('未实测'));
    // Overlapped Element 与 Scrollbars 两项因内核问题暂时不过，单独放在下面的 todo 里
    const skip = (x: Item) => x.element.startsWith('Name 输入框') || x.element === 'Hiding Button';
    for (const i of r.live.items.filter((x) => !skip(x)))
      assert.equal(i.outcome, i.expected, `${i.scenario} ${i.element}：${i.detail}`);
    assert.equal(r.live.summary.wrong, 0);
    assert.ok(r.live.items.every((i) => i.live === true));
    // 隐藏层：第二次点击被蓝色层盖住，转人工 obscured，蓝色层没有收到点击
    const hidden = r.live.items.filter((i) => i.element === '绿色按钮');
    assert.deepEqual(
      hidden.map((i) => i.outcome),
      ['hit', 'manual'],
    );
    assert.equal(hidden[1]?.code, 'obscured');
    const ev = stub.events;
    assert.equal(count(ev, 'dynamicid'), 1);
    assert.equal(count(ev, 'classattr:primary'), 1);
    assert.equal(
      count(ev, 'classattr:warning') + count(ev, 'classattr:success'),
      0,
      '没有点到别的按钮',
    );
    assert.equal(count(ev, 'hidden:green'), 1);
    assert.equal(count(ev, 'hidden:blue'), 0, '没有误点到盖住的蓝色层');
    assert.equal(count(ev, 'animation:start'), 1);
    assert.equal(count(ev, 'animation:target'), 1);
    assert.equal(count(ev, 'shadow:generate'), 1);
    assert.equal(count(ev, 'shadow:copy'), 1);
    // 只跑公开站点时另存报告，不覆盖本地场景的报告
    assert.ok(r.reportPath.endsWith('bw6-live-report.md') && existsSync(r.reportPath));
    assert.ok(readFileSync(r.reportPath, 'utf8').includes('未实测'));
  });

  // 内核问题（todo）：用桩站点的 Overlapped Element 页发现，按正确行为断言；内核修好后去掉 todo
  test('BW-6 公开站点 Overlapped Element：输入框在滚动容器里、几何上在视口内却被容器裁掉，应先滚动容器再填写', {
    todo: '内核：act 判断“在视口内”时没有考虑祖先滚动容器的裁剪，不会滚动容器，点击点落在容器外的 html 上，连续 3 次后报 obscured（hit 为 html）；元素整个在视口外时才会滚动。对 click、hover、fill 都一样',
  }, () => {
    assert.ok(live6, '前一个测试没有跑完');
    const item = live6.report.live.items.find((i) => i.element.startsWith('Name 输入框'));
    assert.equal(item?.outcome, 'hit', `${item?.outcome}：${item?.detail}`);
    assert.ok(count(live6.events, 'overlapped:name') >= 1, '填写应触发输入事件');
  });

  test('BW-12：Text Input、Click（只认真实鼠标）、Sample App 的逻辑跑通，步骤固化成定位器', async () => {
    stub.events.length = 0;
    const r = await run12({
      local: false,
      live: true,
      liveBase: stub.base,
      outDir: out,
      quiet: true,
    });
    assert.equal(r.live.reachable, true);
    assert.equal(r.live.scenes.length, 3);
    for (const sc of r.live.scenes) {
      assert.deepEqual(sc.stepErrors, [], sc.title);
      assert.ok(
        sc.facts.every((f) => f.ok),
        `${sc.title} ${JSON.stringify(sc.facts)}`,
      );
      for (const p of sc.plans) {
        assert.ok(p.coords.ok, `${sc.title}：${p.coords.detail}`);
        assert.ok(p.replay.ok, `${sc.title}：${p.replay.detail}`);
        assert.ok(p.resized.ok, `${sc.title}：${p.resized.detail}`);
        assert.ok(p.rows.every((x) => x.kind === x.expectedKind));
        assert.ok(
          p.rows.every((x) => x.kind === 'plain' || x.kind === 'locator'),
          '页面上都是 DOM 元素，全部换算成定位器',
        );
      }
    }
    // 录制一次（坐标）+ 回放两次（定位器）：只认真实鼠标的按钮收到 3 次可信点击
    assert.equal(count(stub.events, 'click:real'), 3);
    assert.ok(r.live.note.includes('未实测'));
    assert.ok(r.reportPath.endsWith('bw12-live-report.md'));
    assert.ok(readFileSync(r.reportPath, 'utf8').includes('Sample App'));
  });

  test('站点不可达时如实报告：没有结果、不报失败的项，说明未实测', async () => {
    const dead = 'http://127.0.0.1:9';
    const r6 = await run6({ local: false, live: true, liveBase: dead, outDir: out, quiet: true });
    assert.equal(r6.live.requested, true);
    assert.equal(r6.live.reachable, false);
    assert.equal(r6.live.items.length, 0);
    assert.ok(readFileSync(r6.reportPath, 'utf8').includes('访问不了公开站点'));
    const r12 = await run12({ local: false, live: true, liveBase: dead, outDir: out, quiet: true });
    assert.equal(r12.live.reachable, false);
    assert.equal(r12.live.scenes.length, 0);
    assert.ok(readFileSync(r12.reportPath, 'utf8').includes('访问不了公开站点'));
  });
});

// ---------------------------------------------------------------------------------------------
// 脚本自检
// ---------------------------------------------------------------------------------------------

describe('脚本自检', () => {
  test('脚本里没有固定延时：不用 waitForTimeout，也没有 sleep；等待都是条件等待（只有 BW-12 的 poll 里有一处轮询间隔）', () => {
    for (const f of ['bw6.ts', 'bw12.ts']) {
      const src = readFileSync(join(BENCH, f), 'utf8');
      assert.ok(!/waitForTimeout|\bsleep\(/.test(src), `${f} 有固定延时`);
      assert.equal(
        src.match(/setTimeout\(/g)?.length ?? 0,
        f === 'bw12.ts' ? 1 : 0,
        `${f} 里的 setTimeout 数量`,
      );
    }
    const src = readFileSync(join(BENCH, 'bw12.ts'), 'utf8');
    const start = src.indexOf('async function poll');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(body.includes('setTimeout('), 'setTimeout 应只在 poll 里');
  });
});
