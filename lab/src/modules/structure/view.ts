/**
 * 复杂结构模块的页面：/structure 主页面、内嵌 frame、嵌套外层、新标签页报表、Shoelace 组件库页面。
 *
 * 页面骨架由服务端渲染；交互脚本是同目录的静态 js，配置（base、本次加载的随机 id）通过 window.__XXX__ 注入。
 * 随机性：每次加载 /structure 取一次 space.rng() 作种子，用它派生本次所有的 id 与哈希类名
 * （同一个空间、同样的访问次序得到同样的结果；每次加载都不一样）。
 */
import { readFileSync } from 'node:fs';
import { type Ctx, esc, type LabModule, page, seeded } from '../../core.ts';
import { CABINS, CITIES, ROWS, TRANSPORTS, type Who } from './data.ts';
import { VENDOR_PREFIX } from './vendor.ts';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const COMMON_JS = read('common.js');
const CLIENT_JS = read('client.js');
const FRAME_JS = read('frame.js');
const REPORT_JS = read('report.js');
const LIBRARY_JS = read('library.js');
const READY_JS = read('ready.js');

/** 注入到页面的配置：JSON 里的 < 转义，避免提前结束 script 标签。 */
const inject = (name: string, value: unknown) =>
  `<script>window.${name} = ${JSON.stringify(value).replace(/</g, '\\u003c')};</script>`;

const STYLE = `<style>
  .st h2 { margin: 24px 0 8px; font-size: 18px; }
  .st section { margin-bottom: 16px; }
  .st iframe { width: 380px; height: 190px; border: 1px solid #ccc; vertical-align: top; }
  .st #nested-frame { width: 440px; height: 300px; }
  .st table td, .st table th { padding: 6px 10px; }
  .st tr.selected { background: #fef3c7; }
  .st .dyn-box { border: 1px solid #ddd; padding: 8px 12px; max-width: 460px; }
  .st .hint { color: #666; font-size: 13px; }
</style>`;

/** 每次加载随机的 id 与哈希类名生成器：只取 space.rng() 一次，其余由本地种子派生。 */
function loadTokens(ctx: Ctx): { id(prefix: string): string; cls(prefix?: string): string } {
  const g = seeded(Math.floor(ctx.space.rng() * 4294967296));
  const hash = () => {
    // 字母数字混合的 6 位串，必含数字（贴近 CSS-in-JS 与自动生成 id 的样子）
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(g() * chars.length)];
    return /\d/.test(s) ? s : `${s.slice(0, 5)}${Math.floor(g() * 10)}`;
  };
  return { id: (p) => `${p}-${hash()}`, cls: (p = 'css') => `${p}-${hash()}` };
}

/** /structure 主页面。 */
export function indexPage(ctx: Ctx, self: LabModule): string {
  const t = loadTokens(ctx);
  const ids = {
    log: t.id('log'),
    status: t.id('status'),
    table: t.id('tbl'),
    detail: t.id('detail'),
    dyn: t.id('dyn'),
    note: t.id('note'),
    draft: t.id('btn'),
    approve: t.id('btn'),
    dynStatus: t.id('dst'),
  };
  const rows = ROWS.map(
    (r) =>
      `<tr id="${t.id('row')}" class="${t.cls()}" data-row-key="${esc(r.id)}"><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.owner)}</td><td>${r.amount.toLocaleString('en-US')}</td><td><button type="button" id="${t.id('v')}" class="${t.cls()} ${t.cls('sc')}">查看</button></td></tr>`,
  ).join('\n');
  const body = `<div class="st">
<h1>复杂结构</h1>
<p class="hint">同源与跨域 iframe、嵌套 frame、开放与封闭的 Shadow DOM、新标签页、同名按钮、每次加载都变的 id 与类名。
组件库版本见 <a href="${ctx.base}/structure/library">Shoelace 组件库页面</a>。</p>
<section aria-label="Shadow DOM">
  <h2>Shadow DOM</h2>
  <lab-profile></lab-profile>
  <lab-paybox></lab-paybox>
</section>
<section aria-label="框架">
  <h2>iframe</h2>
  <iframe id="same-frame" title="同源表单" src="${ctx.base}/structure/frame?who=same"></iframe>
  <iframe id="cross-frame" title="跨域表单"></iframe>
  <iframe id="nested-frame" title="嵌套框架" src="${ctx.base}/structure/outer"></iframe>
  <lab-frame-host></lab-frame-host>
</section>
<section aria-label="新标签页">
  <h2>新标签页</h2>
  <a href="${ctx.base}/structure/report?from=link" target="_blank">在新标签页打开报表</a>
  <button type="button" id="open-window">弹出窗口</button>
</section>
<section aria-label="同名按钮">
  <h2>合同列表</h2>
  <table id="${ids.table}" class="${t.cls()}">
    <thead><tr><th>合同号</th><th>名称</th><th>负责人</th><th>金额（元）</th><th>操作</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p id="${ids.detail}" role="status">尚未查看任何合同</p>
</section>
<section aria-label="动态属性">
  <h2>审批单</h2>
  <div id="${ids.dyn}" class="dyn-box ${t.cls()}">
    <p><label for="${ids.note}">备注</label> <input id="${ids.note}" class="${t.cls()}" type="text"></p>
    <button type="button" id="${ids.draft}" class="${t.cls()} ${t.cls('sc')}">保存草稿</button>
    <button type="button" id="${ids.approve}" class="${t.cls()} ${t.cls('sc')}">提交审批</button>
    <p id="${ids.dynStatus}" role="status">尚未操作</p>
  </div>
</section>
<p id="${ids.status}" role="status">尚无提交</p>
<section aria-label="操作记录"><h2>操作记录</h2><ol id="${ids.log}"></ol></section>
</div>
${inject('__STRUCTURE__', { base: ctx.base, ids })}
<script>${COMMON_JS}</script>
<script>${CLIENT_JS}</script>`;
  return page(ctx, [self], '复杂结构', body, { head: `${STYLE}<script>${READY_JS}</script>` });
}

/** 内嵌表单页（同源 / 跨域 / 嵌套的内层 / 组件内框架共用；?who= 区分）。 */
export function framePage(ctx: Ctx, self: LabModule, who: Who): string {
  const body = `<strong id="where"></strong>
<div><label for="email">邮箱</label> <input id="email" name="email" type="email"></div>
<button type="button" id="submit">提交</button>
<p id="result">未提交</p>
${inject('__FRAME__', { base: ctx.base, who })}
<script>${COMMON_JS}</script>
<script>${FRAME_JS}</script>`;
  return page(ctx, [self], '内嵌表单', body, { nav: false });
}

/** 嵌套外层：与顶层同源，里面再嵌一个跨域 iframe。 */
export function outerPage(ctx: Ctx, self: LabModule): string {
  const body = `<p>外层框架（同源），里面嵌着跨域框架。 <button type="button" id="outer-btn">外层按钮</button></p>
<iframe id="inner-frame" title="内层跨域" style="width:380px;height:190px;border:1px solid #ccc"></iframe>
${inject('__FRAME__', { base: ctx.base, page: 'outer' })}
<script>${COMMON_JS}</script>
<script>${FRAME_JS}</script>`;
  return page(ctx, [self], '外层框架', body, { nav: false });
}

/** 新标签页：报表页。 */
export function reportPage(ctx: Ctx, self: LabModule, from: string): string {
  const body = `<h1>月度报表</h1>
<p id="from">打开方式：${esc(from)}</p>
<button type="button" id="ack">确认收到</button>
<p id="ack-result" role="status"></p>
${inject('__REPORT__', { base: ctx.base, from })}
<script>${COMMON_JS}</script>
<script>${REPORT_JS}</script>`;
  return page(ctx, [self], '报表（新标签页）', body);
}

const LIBRARY_STYLE = (
  base: string,
) => `<link rel="stylesheet" href="${base}${VENDOR_PREFIX}/themes/light.css">
<style>
  .lib { max-width: 640px; }
  .lib sl-input, .lib sl-select, .lib sl-radio-group { display: block; margin-bottom: 16px; }
  .lib .row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .lib .hint { color: #666; font-size: 13px; }
  .lib #result { margin-top: 16px; padding: 8px 12px; background: #f3f4f6; border-radius: 4px; }
  .lib ul { margin: 0 0 16px; padding-left: 20px; }
  .lib .err { color: #b91c1c; }
</style>`;

/** /structure/library：用 Shoelace（Web Components，带 Shadow DOM）实现的差旅申请流程。 */
export function libraryPage(ctx: Ctx, self: LabModule): string {
  const dir = `${ctx.base}${VENDOR_PREFIX}`;
  const options = (list: readonly { value: string; label: string }[]) =>
    list.map((o) => `<sl-option value="${o.value}">${esc(o.label)}</sl-option>`).join('');
  const body = `<div class="lib">
<h1>差旅申请（组件库）</h1>
<p class="hint">本页用 Shoelace 组件库实现（sl-tab-group、sl-input、sl-select、sl-dropdown、sl-radio-group、sl-checkbox、sl-switch、sl-dialog 等），组件都带 Shadow DOM。
返回 <a href="${ctx.base}/structure">复杂结构主页面</a>。</p>
<sl-alert id="error-alert" variant="danger" closable><span id="error-text"></span></sl-alert>
<sl-tab-group id="wizard">
  <sl-tab slot="nav" panel="info">填写信息</sl-tab>
  <sl-tab slot="nav" panel="choose">选择行程</sl-tab>
  <sl-tab slot="nav" panel="confirm">核对信息</sl-tab>
  <sl-tab-panel name="info">
    <sl-input id="f-name" name="name" label="姓名" placeholder="请输入姓名" clearable></sl-input>
    <sl-input id="f-email" name="email" type="email" label="邮箱" placeholder="name@example.com"></sl-input>
    <sl-button variant="primary" data-next="choose">下一步</sl-button>
  </sl-tab-panel>
  <sl-tab-panel name="choose">
    <sl-select id="f-city" name="city" label="目的地城市" placeholder="请选择城市" clearable>${options(CITIES)}</sl-select>
    <div class="row">
      <sl-dropdown id="f-transport">
        <sl-button slot="trigger" caret>出行方式</sl-button>
        <sl-menu id="f-transport-menu">${TRANSPORTS.map((o) => `<sl-menu-item value="${o.value}">${esc(o.label)}</sl-menu-item>`).join('')}</sl-menu>
      </sl-dropdown>
      <span id="transport-value">未选择</span>
    </div>
    <sl-radio-group id="f-cabin" name="cabin" label="座位等级" value="economy">
      ${CABINS.map((o) => `<sl-radio value="${o.value}">${esc(o.label)}</sl-radio>`).join('')}
    </sl-radio-group>
    <sl-button variant="primary" data-next="confirm">下一步</sl-button>
  </sl-tab-panel>
  <sl-tab-panel name="confirm">
    <ul id="summary"></ul>
    <p><sl-checkbox id="f-agree">我已阅读并同意差旅规定</sl-checkbox></p>
    <p><sl-switch id="f-hotel">需要预订酒店</sl-switch></p>
    <sl-button id="btn-submit" variant="primary" disabled>提交申请</sl-button>
  </sl-tab-panel>
</sl-tab-group>
<div id="result" role="status" aria-live="polite">尚未提交</div>
<sl-dialog id="confirm-dialog" label="确认提交申请">
  <p>请核对申请信息：</p>
  <ul id="dialog-summary"></ul>
  <p id="dialog-error" class="err" role="alert"></p>
  <sl-button id="btn-cancel" slot="footer">取消</sl-button>
  <sl-button id="btn-confirm" slot="footer" variant="primary">确认提交</sl-button>
</sl-dialog>
</div>
${inject('__LIBRARY__', { base: ctx.base, cities: CITIES, transports: TRANSPORTS, cabins: CABINS })}
<script type="module" data-shoelace="${dir}" src="${dir}/shoelace.js"></script>
<script>${LIBRARY_JS}</script>`;
  return page(ctx, [self], '差旅申请（组件库）', body, { head: LIBRARY_STYLE(ctx.base) });
}
