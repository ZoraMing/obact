// BW-12 视觉观察与坐标动作（PRD 9.1；FR-31、FR-32）：只用编号框截图的信息和坐标动作完成一组操作，
// 再把坐标步骤“固化”：有 DOM 元素的位置换算成定位器，Canvas 上的点保留坐标并标记为易失效（volatile）。
//
// 做法：
//   1. 读图：observe 的 views 含 'som'，拿到编号框截图。“从截图上读到的位置”分两种：
//      框住的元素，用编号框对应的 bbox 的中心（编号与框是截图上画出来的，bbox 就是框的位置）；
//      Canvas 里画出来的东西（柱子、流程图节点）没有框，直接读截图像素（本文件自带 PNG 解码，
//      按颜色找柱子和节点），不读页面里的数据，也不用 DOM。
//   2. 坐标动作：click_at、mouse_move、drag、scroll（给坐标）、type_text、press_key 完成一组操作；
//      每一步按页面上的真实状态检查效果（夹具的日志、列表的状态……）。
//   3. 固化：在派发每个坐标动作之前，用 locatorAtPoint 看该坐标上是什么：
//        指向具体 DOM 元素、定位器唯一且解析回包含该点的元素 → 换成 click / hover / drag 的定位器写法；
//        Canvas 本身、定位器不唯一、落在页面背景上          → 保留坐标，标记 volatile；
//        滚轮：坐标下没有内部滚动容器 → 整页滚动（去掉坐标）；有 → 以该滚动容器的定位器为目标。
//      固化后的步骤写成 JSONL（逐行用 packages/schemas 的 step.json 校验）。
//   4. 验证：用固化后的步骤在新页面上回放一遍，各步效果与录制时一致，且换算过的步骤确实走定位器
//      （locator_used 不是 coord）、保留坐标的步骤走坐标；再把窗口缩小后回放一遍，
//      定位器步骤必须照常成功，易失效步骤的结果只如实报告（版面一变，坐标就可能点偏）。
//
// 场景（默认跑本地）：
//   画布夹具   fixtures/canvas：柱状图，点柱子（坐标，易失效）与页头按钮（换算成定位器）
//   Lab 订单   lab 订单列表：排序、整页滚轮、翻页、输入关键字并回车、勾选、点“审核”（确认框取消）
//   虚拟表格   fixtures/virtual-table：在内部滚动容器上滚轮，再点出现的行
//   看板与画布 本文件自带的页面（Lab 看板在 M5 才有，先用它顶替）：HTML5 拖放卡片，画布里拖节点
// --live：UI Testing Playground 的 textinput、click、sampleapp（未实测）。
//
// 用法：
//   node bench/bw12.ts            本地全部场景
//   node bench/bw12.ts --live     只跑公开站点（未实测）
//   node bench/bw12.ts --all      两者都跑
// 结果表打印到终端，同时写到 bench/out/bw12-report.md、bw12-results.json，
// 固化后的步骤写到 bench/out/bw12-steps/<场景>.jsonl。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  type ActOptions,
  act,
  generateLocatorForHandle,
  launchBrowser,
  locatorAtPoint,
  observe,
  resolveLocator,
  Session,
} from '@obact/core';
import type { Action, ActResult, Locator, ObservedElement, ObserveResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import type { Browser, ElementHandle } from 'puppeteer-core';
import { type FixtureServer, startFixtures } from '../fixtures/server.ts';
import { createLab, type Lab } from '../lab/src/app.ts';
import auth from '../lab/src/modules/auth.ts';
import orders from '../lab/src/modules/orders.ts';
import { testChrome } from '../tools/browser.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, 'out');

/** UI Testing Playground 的地址（--live 用）。 */
export const LIVE_BASE = 'http://www.uitestingplayground.com';
export const LIVE_NOTE =
  '未实测：本环境访问不了公开站点，按站点公开的页面结构写成，只做了类型检查，需要在能上网的机器上跑一遍确认';

/** 缩小窗口回放用的视口（默认视口是 1280×713）。 */
const SMALL_VIEWPORT = { width: 1024, height: 640 };
const LAB_SEED = 20260101;

// ---------------------------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------------------------

type Pt = [number, number];
type Rect = [number, number, number, number];
/** 不带 pageId 的动作或步骤（pageId 在执行时补上）。 */
export type Raw = { op: string; [k: string]: unknown };

/**
 * 固化后每个步骤属于哪一类：
 *   locator   坐标换算成了元素定位器
 *   volatile  保留坐标，标记易失效
 *   page      滚轮换算成整页滚动（去掉坐标）
 *   container 滚轮换算成以内部滚动容器的定位器为目标
 *   plain     本来就不是坐标动作（键入、按键、对话框、导航、等待）
 */
export type Kind = 'locator' | 'volatile' | 'page' | 'container' | 'plain';
export const KIND_LABEL: Record<Kind, string> = {
  locator: '定位器',
  volatile: '保留坐标（易失效）',
  page: '整页滚动',
  container: '滚动容器定位器',
  plain: '原样',
};

export type Fact = { label: string; ok: boolean; detail: string };

export type RowItem = {
  /** 坐标动作（读图所得）。 */
  coord: string;
  /** 该坐标上是什么。 */
  under: string;
  /** 固化后的写法。 */
  solid: string;
  kind: Kind;
  expectedKind: Kind;
  /** 固化的依据或不能换算的原因。 */
  why: string;
};

export type Verdict = { ok: boolean; detail: string };

export type PlanItem = {
  no: number;
  title: string;
  rows: RowItem[];
  /** 阶段一：用坐标动作完成，并达到预期效果。 */
  coords: Verdict;
  /** 阶段二：固化后的步骤在新页面上回放。 */
  replay: Verdict;
  /** 阶段三：窗口缩小后回放（易失效步骤的结果只作报告）。 */
  resized: Verdict;
  /** 这一步含易失效的坐标步骤。 */
  volatile: boolean;
};

export type SceneResult = {
  id: string;
  title: string;
  live: boolean;
  plans: PlanItem[];
  /** 固化后的步骤（JSONL 的每一行）。 */
  steps: Record<string, unknown>[];
  /** step.json 校验不通过的行。 */
  stepErrors: string[];
  facts: Fact[];
  jsonlPath: string | null;
};

export type Summary = {
  scenes: number;
  plans: number;
  /** 坐标动作的步骤数（固化前）。 */
  coordinateSteps: number;
  locator: number;
  volatile: number;
  page: number;
  container: number;
  /** 固化类型与预期不一致的步骤数。 */
  kindMismatch: number;
  coordsFailed: number;
  replayFailed: number;
  /** 窗口缩小后，不含易失效步骤的步骤失败数（必须为 0）。 */
  resizedFailed: number;
  /** 窗口缩小后，含易失效步骤的步骤中，结果与录制时不同的数量（报告用，不要求）。 */
  resizedVolatileDiverged: number;
  volatilePlans: number;
  stepErrors: number;
  factsFailed: number;
};

export type Bw12Report = {
  scenes: SceneResult[];
  summary: Summary;
  live: { requested: boolean; reachable: boolean; note: string; scenes: SceneResult[] };
  pass: boolean;
  failures: string[];
  reportPath: string;
  jsonPath: string;
  stepsDir: string;
};

export type RunOptions = {
  local?: boolean;
  live?: boolean;
  outDir?: string;
  chromePath?: string;
  /** 公开站点的地址，默认 LIVE_BASE；可改成自己部署的同款站点。 */
  liveBase?: string;
  quiet?: boolean;
};

// ---------------------------------------------------------------------------------------------
// PNG 解码与读图：编号框截图是模型“看”到的东西，位置从它的像素里读，不去问页面
// ---------------------------------------------------------------------------------------------

export type Png = { w: number; h: number; rgba: Uint8Array };
type Rgb = [number, number, number];

/** 最小 PNG 解码：8 位、RGB 或 RGBA、非隔行（Chrome 截图的格式）。 */
export function decodePng(buf: Uint8Array): Png {
  const b = Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`不支持的 PNG 格式：位深 ${depth}，颜色类型 ${colorType}，隔行 ${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const cur = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? (cur[i - bpp] as number) : 0;
      const up = prev[i] as number;
      const upLeft = i >= bpp ? (prev[i - bpp] as number) : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      cur[i] = ((cur[i] as number) + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = cur[x * bpp] as number;
      rgba[o + 1] = cur[x * bpp + 1] as number;
      rgba[o + 2] = cur[x * bpp + 2] as number;
      rgba[o + 3] = bpp === 4 ? (cur[x * bpp + 3] as number) : 255;
    }
    prev = cur;
  }
  return { w, h, rgba };
}

function pixel(p: Png, x: number, y: number): Rgb {
  const o = (y * p.w + x) * 4;
  return [p.rgba[o] as number, p.rgba[o + 1] as number, p.rgba[o + 2] as number];
}

const near = (c: Rgb, t: Rgb, tol = 16) =>
  Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol;

/** 柱状图夹具的柱子颜色：蓝（默认）与橙（被点中）。 */
const BAR_COLORS: Rgb[] = [
  [0x4a, 0x90, 0xd9],
  [0xe6, 0x7e, 0x22],
];
const isBar = (c: Rgb) => BAR_COLORS.some((t) => near(c, t));

export type Bar = { x0: number; x1: number; cx: number; top: number; bottom: number };

/**
 * 从截图里读柱子：先自下而上找到柱子最低的一行（柱底），在柱底往上几像素处横扫，
 * 一段连续的柱色就是一根柱子；再沿柱子中线往上数到柱顶。坐标按缩放比例换回视口像素。
 */
export function readBars(png: Png, region: Rect, scale: number): Bar[] {
  const x0 = Math.max(0, Math.floor(region[0] * scale));
  const y0 = Math.max(0, Math.floor(region[1] * scale));
  const x1 = Math.min(png.w, Math.ceil((region[0] + region[2]) * scale));
  const y1 = Math.min(png.h, Math.ceil((region[1] + region[3]) * scale));
  const runsAt = (y: number): [number, number][] => {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const on = x < x1 && isBar(pixel(png, x, y));
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start >= 6) runs.push([start, x - 1]);
        start = -1;
      }
    }
    return runs;
  };
  let bottom = -1;
  for (let y = y1 - 1; y >= y0 && bottom < 0; y--) if (runsAt(y).length) bottom = y;
  if (bottom < 0) return [];
  const bars: Bar[] = [];
  for (const [a, b] of runsAt(bottom - 4)) {
    const cx = Math.round((a + b) / 2);
    let top = bottom;
    while (top - 1 >= y0 && isBar(pixel(png, cx, top - 1))) top--;
    bars.push({
      x0: a / scale,
      x1: (b + 1) / scale,
      cx: (cx + 0.5) / scale,
      top: top / scale,
      bottom: (bottom + 1) / scale,
    });
  }
  return bars;
}

/** 在区域内找某种颜色的一团像素，返回它的中心与半径（视口像素）；找不到返回 null。 */
export function findBlob(
  png: Png,
  region: Rect,
  color: Rgb,
  scale: number,
): { cx: number; cy: number; r: number; pixels: number } | null {
  const x0 = Math.max(0, Math.floor(region[0] * scale));
  const y0 = Math.max(0, Math.floor(region[1] * scale));
  const x1 = Math.min(png.w, Math.ceil((region[0] + region[2]) * scale));
  const y1 = Math.min(png.h, Math.ceil((region[1] + region[3]) * scale));
  let n = 0;
  let sx = 0;
  let sy = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!near(pixel(png, x, y), color, 14)) continue;
      n++;
      sx += x;
      sy += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  if (!n) return null;
  return {
    cx: (sx / n + 0.5) / scale,
    cy: (sy / n + 0.5) / scale,
    r: (maxX - minX + 1) / 2 / scale,
    pixels: n,
  };
}

// ---------------------------------------------------------------------------------------------
// 读图：observe（含编号框截图）+ 在截图里按名称选框
// ---------------------------------------------------------------------------------------------

type Query = {
  name?: string | RegExp;
  role?: string;
  within?: RegExp;
  /** 只要整个框都在视口内的。 */
  full?: boolean;
};

export type Seen = {
  ref: number;
  role: string;
  name: string;
  within: string | undefined;
  /** 框在视口内可见的部分（视口像素）。 */
  box: Rect;
  center: Pt;
};

type Vision = {
  pageId: string;
  ob: ObserveResult;
  png: Png;
  scale: number;
  /** 符合条件的框，自上而下、自左而右。 */
  all(q?: Query): Seen[];
  /** 恰好一个。 */
  one(q: Query): Seen;
  /** 最靠上的一个。 */
  top(q: Query): Seen;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const center = (r: Rect): Pt => [round1(r[0] + r[2] / 2), round1(r[1] + r[3] / 2)];
const qs = (q: Query) =>
  JSON.stringify({ ...q, name: q.name?.toString(), within: q.within?.toString() });

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y;
  return [x, y, Math.max(0, w), Math.max(0, h)];
}

const matches = (v: string | undefined, want: string | RegExp | undefined) =>
  want === undefined || (typeof want === 'string' ? v === want : want.test(v ?? ''));

function makeVision(pageId: string, ob: ObserveResult, png: Png): Vision {
  const view: Rect = [0, 0, ob.viewport.width, ob.viewport.height];
  const seen: Seen[] = [];
  for (const e of ob.elements as ObservedElement[]) {
    if (e.visible_ratio <= 0) continue;
    const box = intersect(e.bbox as Rect, view);
    if (box[2] <= 0 || box[3] <= 0) continue;
    seen.push({
      ref: e.ref,
      role: e.role,
      name: e.name,
      within: e.within,
      box,
      center: center(box),
    });
  }
  const all = (q: Query = {}) => {
    const full = (s: Seen) => {
      const e = (ob.elements as ObservedElement[]).find((x) => x.ref === s.ref) as ObservedElement;
      const b = e.bbox as Rect;
      return Math.abs(b[2] - s.box[2]) < 0.5 && Math.abs(b[3] - s.box[3]) < 0.5;
    };
    return seen
      .filter(
        (s) =>
          matches(s.name, q.name) &&
          (q.role === undefined || s.role === q.role) &&
          matches(s.within, q.within) &&
          (!q.full || full(s)),
      )
      .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  };
  return {
    pageId,
    ob,
    png,
    scale: ob.viewport.scale,
    all,
    one(q) {
      const list = all(q);
      if (list.length !== 1) throw new Error(`截图上应有一个框 ${qs(q)}，实际 ${list.length} 个`);
      return list[0] as Seen;
    },
    top(q) {
      const first = all(q)[0];
      if (!first) throw new Error(`截图上找不到框 ${qs(q)}`);
      return first;
    },
  };
}

/** 编号框截图上，每个可见元素的框确实画在 bbox 的位置：取上沿或左沿的像素，与不带框的截图比对。 */
function boxesDrawn(som: Png, plain: Png, ob: ObserveResult): { total: number; drawn: number } {
  const view: Rect = [0, 0, ob.viewport.width, ob.viewport.height];
  const scale = ob.viewport.scale;
  const differs = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= som.w || py >= som.h) continue;
        const a = pixel(som, px, py);
        const b = pixel(plain, px, py);
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 40) return true;
      }
    }
    return false;
  };
  let total = 0;
  let drawn = 0;
  for (const e of ob.elements as ObservedElement[]) {
    if (e.visible_ratio <= 0) continue;
    const r = intersect(e.bbox as Rect, view);
    if (r[2] < 8 || r[3] < 8) continue;
    total++;
    const share = (pts: [number, number][]) =>
      pts.filter(([x, y]) => differs(x, y)).length / pts.length;
    const top: [number, number][] = [];
    for (let x = r[0] + 3; x < r[0] + r[2] - 3; x += 3)
      top.push([Math.round(x * scale), Math.round(r[1] * scale)]);
    const left: [number, number][] = [];
    for (let y = r[1] + 3; y < r[1] + r[3] - 3; y += 3)
      left.push([Math.round(r[0] * scale), Math.round(y * scale)]);
    if (Math.max(top.length ? share(top) : 0, left.length ? share(left) : 0) >= 0.8) drawn++;
  }
  return { total, drawn };
}

// ---------------------------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------------------------

type Site = { base: string; close(): Promise<void> };

/** 运行环境（导出供测试用）。 */
export type Env = {
  fixtures: FixtureServer | null;
  lab: Lab | null;
  board: Site | null;
  browser: Browser;
  session: Session;
  shotDir: string;
  newPage(): Promise<string>;
  run(a: Action, opts?: ActOptions): Promise<ActResult>;
  close(): Promise<void>;
};

const contracts = new Contracts();

/** 本文件自带的看板与画布页（Lab 看板在 M5 才有）：HTML5 拖放的卡片，画布里可拖的节点。 */
const BOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>项目看板</title>
<style>
  body { margin: 0; padding: 12px 20px; font: 14px/1.5 sans-serif; color: #222; }
  header { display: flex; align-items: center; justify-content: space-between; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .board { display: flex; gap: 16px; margin: 12px 0; }
  .col { flex: 1; min-height: 180px; background: #eef3fb; border: 2px solid #c5d3ea; border-radius: 6px; padding: 8px; }
  .col.over { border-color: #4a90d9; }
  .card { background: #fff; border: 1px solid #b9c4d6; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; cursor: grab; }
  #flow { display: block; margin: 12px auto; border: 1px solid #ccd; background: #fff; }
  #log { margin: 4px 0; padding-left: 24px; }
</style>
</head>
<body>
  <header>
    <h1>项目看板</h1>
    <button type="button" id="save">保存布局</button>
  </header>
  <div class="board">
    <section class="col" data-col="todo" aria-label="待办" tabindex="0"><h2>待办</h2>
      <div class="card" draggable="true" data-testid="card-c1">写需求文档</div>
      <div class="card" draggable="true" data-testid="card-c2">评审方案</div>
      <div class="card" draggable="true" data-testid="card-c3">联调接口</div>
    </section>
    <section class="col" data-col="doing" aria-label="进行中" tabindex="0"><h2>进行中</h2></section>
    <section class="col" data-col="done" aria-label="已完成" tabindex="0"><h2>已完成</h2></section>
  </div>
  <h2>流程画布</h2>
  <canvas id="flow" width="640" height="220" role="img" aria-label="流程画布"></canvas>
  <h2>操作日志</h2>
  <ol id="log"></ol>
  <script>
    var state = (window.board = { cols: {}, nodes: { A: [110, 110], B: [330, 110] }, log: [] });
    function log(t) {
      state.log.push(t);
      var li = document.createElement('li');
      li.textContent = t;
      document.getElementById('log').appendChild(li);
    }
    function sync() {
      document.querySelectorAll('.col').forEach(function (c) {
        state.cols[c.dataset.col] = Array.prototype.map.call(c.querySelectorAll('.card'), function (x) {
          return x.dataset.testid.replace('card-', '');
        });
      });
    }
    sync();
    var dragging = null;
    document.addEventListener('dragstart', function (e) {
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) return;
      dragging = card;
      e.dataTransfer.setData('text/plain', card.dataset.testid);
      e.dataTransfer.effectAllowed = 'move';
    });
    document.querySelectorAll('.col').forEach(function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', function () { col.classList.remove('over'); });
      col.addEventListener('drop', function (e) {
        e.preventDefault();
        col.classList.remove('over');
        if (!dragging) return;
        var from = dragging.parentElement.getAttribute('aria-label');
        col.appendChild(dragging);
        sync();
        log('卡片“' + dragging.textContent + '”：' + from + ' → ' + col.getAttribute('aria-label'));
        dragging = null;
      });
    });
    document.getElementById('save').addEventListener('click', function () {
      log('已保存布局：' + JSON.stringify(state.cols));
    });

    var cv = document.getElementById('flow');
    var g = cv.getContext('2d');
    var COLORS = { A: '#e67e22', B: '#27ae60' };
    var R = 30;
    function draw() {
      g.clearRect(0, 0, cv.width, cv.height);
      g.strokeStyle = '#889';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(state.nodes.A[0], state.nodes.A[1]);
      g.lineTo(state.nodes.B[0], state.nodes.B[1]);
      g.stroke();
      Object.keys(state.nodes).forEach(function (k) {
        g.fillStyle = COLORS[k];
        g.beginPath();
        g.arc(state.nodes[k][0], state.nodes[k][1], R, 0, Math.PI * 2);
        g.fill();
      });
    }
    draw();
    var grab = null;
    function at(e) {
      var r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    cv.addEventListener('mousedown', function (e) {
      var p = at(e);
      var hit = Object.keys(state.nodes).filter(function (k) {
        return Math.hypot(p[0] - state.nodes[k][0], p[1] - state.nodes[k][1]) <= R;
      })[0];
      if (hit) grab = hit;
    });
    window.addEventListener('mousemove', function (e) {
      if (!grab) return;
      var p = at(e);
      state.nodes[grab] = [Math.round(p[0]), Math.round(p[1])];
      draw();
    });
    window.addEventListener('mouseup', function () {
      if (!grab) return;
      log('节点 ' + grab + ' 移到 (' + state.nodes[grab][0] + ', ' + state.nodes[grab][1] + ')');
      grab = null;
    });
    cv.addEventListener('click', function () {});
  </script>
</body>
</html>`;

async function startBoard(): Promise<Site> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://board').pathname;
    if (path === '/board') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(BOARD_HTML);
    } else res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

export async function startEnv(o: { local: boolean; chromePath?: string }): Promise<Env> {
  const chromePath = o.chromePath ?? process.env.CHROME_PATH ?? (await testChrome());
  const fixtures = o.local ? await startFixtures() : null;
  const lab = o.local ? await createLab({ modules: [auth, orders] }) : null;
  const board = o.local ? await startBoard() : null;
  const profileDir = mkdtempSync(join(tmpdir(), 'obact-bw12-'));
  const shotDir = mkdtempSync(join(tmpdir(), 'obact-bw12-shots-'));
  const browser = await launchBrowser({
    profileDir,
    chromePath,
    mode: process.env.HEADED === '1' ? 'headed' : 'headless',
  });
  const session = await Session.attach(browser);
  return {
    fixtures,
    lab,
    board,
    browser,
    session,
    shotDir,
    newPage: () => session.pages.newPage(),
    async run(a, opts) {
      const r = await act(session, a, opts);
      contracts.assert('act-result', r);
      return r;
    },
    async close() {
      await session.close({ closeBrowser: true });
      await lab?.close();
      await board?.close();
      await fixtures?.close();
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(shotDir, { recursive: true, force: true });
    },
  };
}

const pageOf = (env: Env, id: string) => env.session.pages.get(id);

/** 条件等待：反复取值，满足就返回，超时返回最后一次的值。没有固定延时。 */
async function poll<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 5000,
): Promise<{ value: T; ok: boolean }> {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return { value, ok: true };
    if (Date.now() - t0 >= timeoutMs) return { value, ok: false };
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** 读图：observe（文本 + 编号框截图 + 不带框的截图，后者只用来核对框画在哪里）。 */
async function see(
  env: Env,
  pageId: string,
): Promise<{ v: Vision; boxes: { total: number; drawn: number }; sizeOk: boolean }> {
  const ob = await observe(
    env.session,
    { pageId, views: ['text', 'som', 'screenshot'] },
    { outDir: env.shotDir },
  );
  contracts.assert('observe.Result', ob);
  if (!ob.som_path || !ob.screenshot_path) throw new Error('observe 没有返回编号框截图');
  const som = decodePng(readFileSync(ob.som_path));
  const plain = decodePng(readFileSync(ob.screenshot_path));
  const s = ob.viewport.scale;
  const sizeOk =
    som.w === Math.round(ob.viewport.width * s) && som.h === Math.round(ob.viewport.height * s);
  return { v: makeVision(pageId, ob, som), boxes: boxesDrawn(som, plain, ob), sizeOk };
}

// ---------------------------------------------------------------------------------------------
// 固化：坐标 → 定位器
// ---------------------------------------------------------------------------------------------

type Probe =
  | { kind: 'dom'; locator: Locator; label: string }
  | { kind: 'canvas'; label: string }
  | { kind: 'none'; label: string; why: string };

/** 坐标上是什么：能换算成唯一定位器、且解析回来的元素包含这个点，才算 DOM 元素。 */
async function probePoint(env: Env, pageId: string, x: number, y: number): Promise<Probe> {
  const at = await locatorAtPoint(env.session, pageId, x, y);
  if (!at) return { kind: 'none', label: '（取不到元素）', why: '该坐标处没有元素' };
  const label = `${at.role}${at.name ? ` "${at.name}"` : ''}`;
  if (!at.unique) {
    return { kind: 'none', label, why: `定位器不唯一：${JSON.stringify(at.locator)}` };
  }
  const r = await resolveLocator(env.session, pageId, at.locator).catch(() => null);
  if (!r) return { kind: 'none', label, why: '定位器解析不回这个元素' };
  try {
    const tag = await r.handle.evaluate((e) => e.tagName);
    const box = await r.handle.boundingBox();
    if (tag === 'CANVAS')
      return { kind: 'canvas', label: `canvas${at.name ? ` "${at.name}"` : ''}` };
    if (tag === 'BODY' || tag === 'HTML') {
      return { kind: 'none', label: '页面背景', why: '落在页面背景上，没有具体元素' };
    }
    if (
      !box ||
      x < box.x - 1 ||
      x > box.x + box.width + 1 ||
      y < box.y - 1 ||
      y > box.y + box.height + 1
    ) {
      return { kind: 'none', label, why: '定位器指向的元素不包含这个点' };
    }
    return { kind: 'dom', locator: at.locator, label };
  } finally {
    await r.handle.dispose();
  }
}

export type Solid = { row: Raw; kind: Kind; under: string; why: string };

/** 滚轮坐标下，沿父节点向上第一个能朝滚动方向滚动的内部容器；没有就是整页滚动。 */
const SCROLL_OWNER = (x: number, y: number, dx: number, dy: number): Element | null => {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement && el !== document.body) {
    const cs = getComputedStyle(el);
    const can = /(auto|scroll|overlay)/;
    const vertical = dy !== 0 && can.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const horizontal = dx !== 0 && can.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (vertical || horizontal) return el;
    el = el.parentElement;
  }
  return null;
};

const pt = (p: Pt): string => `(${Math.round(p[0])}, ${Math.round(p[1])})`;

/**
 * 把一个坐标动作换算成固化后的步骤（在派发它之前一刻，按页面当时的状态换算）。
 * 不是坐标动作的原样返回。
 */
export async function solidify(env: Env, pageId: string, raw: Raw): Promise<Solid> {
  const plain: Solid = { row: raw, kind: 'plain', under: '', why: '不是坐标动作' };
  const keep = (probe: Probe | string, row: Raw): Solid => {
    const why =
      typeof probe === 'string'
        ? probe
        : probe.kind === 'none'
          ? probe.why
          : 'Canvas 里的点，没有 DOM 元素可指';
    const under = typeof probe === 'string' ? '' : probe.label;
    return {
      row: { ...row, volatile: true, note: `坐标步骤，换算不了：${why}` },
      kind: 'volatile',
      under,
      why,
    };
  };

  if (raw.op === 'click_at' || raw.op === 'mouse_move') {
    const x = raw.x as number;
    const y = raw.y as number;
    const p = await probePoint(env, pageId, x, y);
    if (p.kind !== 'dom') return keep(p, raw);
    const { x: _x, y: _y, op, ...rest } = raw;
    return {
      row: {
        op: op === 'click_at' ? 'click' : 'hover',
        ...rest,
        target: p.locator,
        note: `坐标 ${pt([x, y])} 处是 ${p.label}`,
      },
      kind: 'locator',
      under: p.label,
      why: '定位器唯一，且解析回包含该坐标的元素',
    };
  }

  if (raw.op === 'drag') {
    const ends = await Promise.all(
      (['from', 'to'] as const).map(async (k) => {
        const [x, y] = raw[k] as Pt;
        return { k, p: await probePoint(env, pageId, x, y), at: [x, y] as Pt };
      }),
    );
    const row: Raw = { ...raw };
    for (const e of ends) if (e.p.kind === 'dom') row[e.k] = e.p.locator;
    const left = ends.filter((e) => e.p.kind !== 'dom');
    const under = ends.map((e) => e.p.label).join(' → ');
    if (!left.length) {
      return {
        row: { ...row, note: `坐标 ${pt(ends[0]?.at as Pt)} → ${pt(ends[1]?.at as Pt)}：${under}` },
        kind: 'locator',
        under,
        why: '起点和终点都换算成了定位器',
      };
    }
    const why = left
      .map(
        (e) =>
          `${e.k === 'from' ? '起点' : '终点'}${e.p.kind === 'canvas' ? '在 Canvas 里' : e.p.kind === 'none' ? e.p.why : ''}`,
      )
      .join('；');
    return { ...keep(why, row), under };
  }

  if (raw.op === 'scroll' && Array.isArray(raw.at)) {
    const [x, y] = raw.at as Pt;
    const dx = (raw.dx as number | undefined) ?? 0;
    const dy = (raw.dy as number | undefined) ?? 0;
    const page = pageOf(env, pageId);
    const h = await page.evaluateHandle(SCROLL_OWNER, x, y, dx, dy);
    const owner = h.asElement() as ElementHandle<Element> | null;
    const { at: _at, ...rest } = raw;
    try {
      if (!owner) {
        return {
          row: { ...rest, note: `滚轮 ${pt([x, y])} 下没有内部滚动容器，整页滚动` },
          kind: 'page',
          under: '页面',
          why: '坐标下没有内部滚动容器，滚轮滚的是整个页面',
        };
      }
      const g = await generateLocatorForHandle(env.session, pageId, page.mainFrame(), owner);
      const label = await owner.evaluate(
        (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}`,
      );
      if (!g.unique) return keep(`滚动容器 ${label} 的定位器不唯一`, raw);
      return {
        row: { ...rest, target: g.locator, note: `滚轮 ${pt([x, y])} 在滚动容器 ${label} 上` },
        kind: 'container',
        under: `滚动容器 ${label}`,
        why: '坐标下有内部滚动容器，以它的定位器为目标',
      };
    } finally {
      await h.dispose();
    }
  }
  return plain;
}

// ---------------------------------------------------------------------------------------------
// 场景与步骤
// ---------------------------------------------------------------------------------------------

type PlanStep = {
  title: string;
  /** 等到截图上出现需要的东西再读图（条件等待）。 */
  until?: (v: Vision) => boolean;
  /** 读图，给出坐标动作（不带 pageId）。 */
  actions(v: Vision): Promise<Raw[]>;
  /** 每个动作固化后应是哪一类。 */
  kinds: Kind[];
  /** 检查这一步的效果；返回 null 表示通过，否则是原因。 */
  expect(before: unknown, after: unknown, results: ActResult[]): string | null;
};

type Scene = {
  id: string;
  title: string;
  live?: boolean;
  /** 前置步骤（打开页面、等页面就绪），写进 JSONL 的 preamble 段。 */
  preamble: Raw[];
  /** 页面状态快照：每步前后各取一次，供 expect 比较。 */
  snap(env: Env, pageId: string): Promise<unknown>;
  plan: PlanStep[];
  /** 读图后的核对（例如读出的柱子数量、高度比例与页面数据一致）。 */
  verify?(env: Env, pageId: string, v: Vision): Promise<Fact[]>;
};

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (msg: string) => msg;

/** 取页面里的值：函数在浏览器里执行。 */
const evalIn = <T>(env: Env, pageId: string, fn: () => T): Promise<T> =>
  pageOf(env, pageId).evaluate(fn) as Promise<T>;

// ---------- 画布夹具（柱状图）

type CanvasSnap = { log: string[]; values: number[]; hoverRefresh: boolean };

function canvasScene(env: Env): Scene {
  const base = (env.fixtures as FixtureServer).base;
  const chart = (v: Vision) => v.one({ role: 'img', name: '月度销售额柱状图' });
  const bars = (v: Vision) => readBars(v.png, chart(v).box, v.scale);
  const click = (name: string): PlanStep => ({
    title: `点“${name}”按钮`,
    async actions(v) {
      const [x, y] = v.one({ role: 'button', name }).center;
      return [{ op: 'click_at', x, y }];
    },
    kinds: ['locator'],
    expect: (b, a) => {
      const d = (a as CanvasSnap).log.slice((b as CanvasSnap).log.length);
      return eq(d, [`按钮：${name}`])
        ? null
        : fail(`日志应新增“按钮：${name}”，实际 ${JSON.stringify(d)}`);
    },
  });
  const bar = (k: number): PlanStep => ({
    title: `点第 ${k} 根柱子（从截图上读出位置）`,
    async actions(v) {
      const found = bars(v);
      const b = found[k - 1];
      if (!b) throw new Error(`截图上只读到 ${found.length} 根柱子，没有第 ${k} 根`);
      return [{ op: 'click_at', x: round1(b.cx), y: round1(b.bottom - 8) }];
    },
    kinds: ['volatile'],
    expect: (b, a) => {
      const s = a as CanvasSnap;
      const d = s.log.slice((b as CanvasSnap).log.length);
      const want = `点中柱子 ${k}（${k}月，${s.values[k - 1]} 万元）`;
      return eq(d, [want]) ? null : fail(`日志应新增“${want}”，实际 ${JSON.stringify(d)}`);
    },
  });
  return {
    id: 'canvas',
    title: '画布夹具（柱状图）',
    preamble: [
      { op: 'navigate_page', url: `${base}/canvas/?seed=3`, section: 'preamble' },
      {
        op: 'wait_for',
        until: [{ element_present: { role: 'button', name: '刷新' } }],
        section: 'preamble',
      },
    ],
    snap: (e, p) =>
      evalIn(e, p, () => ({
        log: [...(window as unknown as { chartLog: string[] }).chartLog],
        values: [...(window as unknown as { chartValues: number[] }).chartValues],
        hoverRefresh: document.getElementById('refresh')?.matches(':hover') ?? false,
      })),
    plan: [
      {
        title: '鼠标移到“刷新”按钮上',
        async actions(v) {
          const [x, y] = v.one({ role: 'button', name: '刷新' }).center;
          return [{ op: 'mouse_move', x, y }];
        },
        kinds: ['locator'],
        expect: (_b, a) =>
          (a as CanvasSnap).hoverRefresh ? null : fail('鼠标移过去后按钮没有处在 :hover 状态'),
      },
      click('导出图片'),
      bar(3),
      bar(9),
      click('刷新'),
      bar(12),
    ],
    async verify(e, p, v) {
      const found = bars(v);
      const values = ((await this.snap(e, p)) as CanvasSnap).values;
      // 柱高之比应与数据之比一致（读图读对了：不只是数量对）
      const tallest = Math.max(...found.map((b) => b.bottom - b.top));
      const peak = Math.max(...values);
      const worst = Math.max(
        ...found.map((b, i) => Math.abs((b.bottom - b.top) / tallest - (values[i] ?? 0) / peak)),
      );
      return [
        {
          label: '从截图读出的柱子数量',
          ok: found.length === values.length,
          detail: `读到 ${found.length} 根，页面数据 ${values.length} 个`,
        },
        {
          label: '读出的柱高与数据成比例',
          ok: found.length === values.length && worst < 0.03,
          detail: `各柱高度比与数据比的最大偏差 ${worst.toFixed(4)}`,
        },
      ];
    },
  };
}

// ---------- Lab 订单列表

type LabSnap = {
  summary: string;
  sort: string;
  scrollY: number;
  keyword: string;
  selected: string;
  checked: string[];
  rows: string[];
  amounts: number[];
};

const labSnap = (e: Env, p: string): Promise<LabSnap> =>
  evalIn(e, p, () => {
    const th = [...document.querySelectorAll('th[aria-sort]')].find(
      (x) => x.getAttribute('aria-sort') !== 'none',
    );
    return {
      summary: document.getElementById('summary')?.textContent ?? '',
      sort: th ? `${th.textContent?.trim()}:${th.getAttribute('aria-sort')}` : '',
      scrollY: Math.round(scrollY),
      keyword: (document.getElementById('keyword') as HTMLInputElement | null)?.value ?? '',
      selected: document.getElementById('selected-count')?.textContent ?? '',
      checked: [...document.querySelectorAll<HTMLInputElement>('input.row-check:checked')].map(
        (b) => b.dataset.id ?? '',
      ),
      rows: [...document.querySelectorAll<HTMLElement>('tbody tr')].map((r) => r.dataset.id ?? ''),
      amounts: [...document.querySelectorAll('tbody td.num')].map((td) =>
        Number((td.textContent ?? '').replace(/,/g, '')),
      ),
    };
  });

const sorted = (xs: number[], dir: 1 | -1) =>
  xs.every((x, i) => i === 0 || (x - (xs[i - 1] as number)) * dir >= 0);

async function labScene(env: Env, space: string): Promise<Scene> {
  const lab = env.lab as Lab;
  const base = lab.url(space);
  // 登录（HTTP），把会话 cookie 交给浏览器；固定种子重置，订单可复现
  await fetch(`${base}/_lab/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: LAB_SEED }),
  });
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'alice', password: 'alice123' }).toString(),
    redirect: 'manual',
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const [name, value] = cookie.split('=') as [string, string];
  if (name !== 'lab_session') throw new Error(`Lab 登录失败：HTTP ${r.status}`);
  await env.browser.setCookie({
    name,
    value,
    domain: '127.0.0.1',
    path: `/s/${space}/`,
    httpOnly: true,
  });
  // 期望值：用接口里的订单独立算出关键字“orion”应匹配几条
  const all = (
    (await (await fetch(`${base}/api/orders?page_size=500`, { headers: { cookie } })).json()) as {
      items: { id: string; customer: string }[];
    }
  ).items;
  const KEYWORD = 'orion';
  const hits = all.filter(
    (o) => o.id.includes(KEYWORD) || o.customer.toLowerCase().includes(KEYWORD),
  );
  const pages = Math.ceil(all.length / 20);

  const sortBy = (col: string, dir: 'ascending' | 'descending'): PlanStep => ({
    title: `点表头“${col}”排序（${dir === 'ascending' ? '升序' : '降序'}）`,
    async actions(v) {
      const [x, y] = v.one({ role: 'button', name: col }).center;
      return [{ op: 'click_at', x, y }];
    },
    kinds: ['locator'],
    expect: (_b, a) => {
      const s = a as LabSnap;
      if (s.sort !== `${col}:${dir}`)
        return fail(`表头状态应为 ${col}:${dir}，实际 ${s.sort || '（无）'}`);
      return sorted(s.amounts, dir === 'ascending' ? 1 : -1) ? null : fail('金额列没有按序排列');
    },
  });

  let approveId = '';
  return {
    id: 'lab-orders',
    title: 'Lab 订单列表',
    preamble: [
      {
        op: 'navigate_page',
        url: `${base}/orders`,
        section: 'preamble',
        note: '前置：已登录（会话 cookie）',
      },
      { op: 'wait_for', until: [{ text_present: `共 ${all.length} 条` }], section: 'preamble' },
    ],
    snap: labSnap,
    plan: [
      sortBy('金额', 'ascending'),
      sortBy('金额', 'descending'),
      {
        title: '在订单表上滚轮向下（坐标）',
        async actions(v) {
          const [x, y] = v.top({ role: 'link', name: '详情' }).center;
          return [{ op: 'scroll', at: [x, y], dy: 800 }];
        },
        kinds: ['page'],
        expect: (_b, a) =>
          (a as LabSnap).scrollY > 100
            ? null
            : fail(`页面应向下滚动，scrollY=${(a as LabSnap).scrollY}`),
      },
      {
        title: '点分页“下一页”（滚到底后在截图上才看得见）',
        until: (v) => v.all({ role: 'button', name: '下一页', full: true }).length === 1,
        async actions(v) {
          const [x, y] = v.one({ role: 'button', name: '下一页' }).center;
          return [{ op: 'click_at', x, y }];
        },
        kinds: ['locator'],
        expect: (_b, a) => {
          const s = a as LabSnap;
          return s.summary.includes(`第 2 / ${pages} 页`)
            ? null
            : fail(`应翻到第 2 页，实际“${s.summary}”`);
        },
      },
      {
        title: '在页面上滚轮向上回到顶部（坐标）',
        async actions(v) {
          return [
            {
              op: 'scroll',
              at: [Math.round(v.ob.viewport.width / 2), Math.round(v.ob.viewport.height / 2)],
              dy: -1500,
            },
          ];
        },
        kinds: ['page'],
        expect: (_b, a) =>
          (a as LabSnap).scrollY === 0
            ? null
            : fail(`应回到顶部，scrollY=${(a as LabSnap).scrollY}`),
      },
      {
        title: `点关键字输入框、键入“${KEYWORD}”、回车`,
        async actions(v) {
          const [x, y] = v.one({ role: 'searchbox', name: '关键字' }).center;
          return [
            { op: 'click_at', x, y },
            { op: 'type_text', text: KEYWORD },
            { op: 'press_key', key: 'Enter' },
          ];
        },
        kinds: ['locator', 'plain', 'plain'],
        expect: (_b, a) => {
          const s = a as LabSnap;
          if (s.keyword !== KEYWORD) return fail(`输入框应为“${KEYWORD}”，实际“${s.keyword}”`);
          return s.summary.startsWith(`共 ${hits.length} 条`) && s.rows.length === hits.length
            ? null
            : fail(`应筛出 ${hits.length} 条，实际“${s.summary}”（${s.rows.length} 行）`);
        },
      },
      {
        title: '勾选最上面一行的复选框',
        async actions(v) {
          const [x, y] = v.top({ role: 'checkbox', name: /^选择订单 / }).center;
          return [{ op: 'click_at', x, y }];
        },
        kinds: ['locator'],
        expect: (_b, a) => {
          const s = a as LabSnap;
          return s.selected === '已选 1 条' && eq(s.checked, s.rows.slice(0, 1))
            ? null
            : fail(`应只勾上第一行，实际“${s.selected}” ${JSON.stringify(s.checked)}`);
        },
      },
      {
        title: '点最上面一个“审核”（弹出确认框，取消）',
        async actions(v) {
          const b = v.top({ role: 'button', name: '审核' });
          approveId = /data-id='(\d+)'/.exec(b.within ?? '')?.[1] ?? '';
          return [
            { op: 'click_at', x: b.center[0], y: b.center[1] },
            { op: 'handle_dialog', action: 'dismiss' },
          ];
        },
        kinds: ['locator', 'plain'],
        expect: (b, a, results) => {
          const msg = `确认审核订单 ${approveId}？`;
          const got = (results[0]?.effects.dialogs ?? []).map((d) => d.message);
          if (!got.includes(msg)) return fail(`应弹出确认框“${msg}”，实际 ${JSON.stringify(got)}`);
          const [s0, s1] = [b as LabSnap, a as LabSnap];
          return eq(s0.rows, s1.rows) && s0.summary === s1.summary
            ? null
            : fail('取消后列表不应变化');
        },
      },
    ],
  };
}

// ---------- 虚拟滚动表格：在内部滚动容器上滚轮

type VtSnap = { scrollTop: number; detail: string };

function virtualTableScene(env: Env): Scene {
  const base = (env.fixtures as FixtureServer).base;
  const DY = 1600;
  let rowId = '';
  return {
    id: 'virtual-table',
    title: '虚拟滚动表格（内部滚动容器）',
    preamble: [
      { op: 'navigate_page', url: `${base}/virtual-table/?seed=3`, section: 'preamble' },
      {
        op: 'wait_for',
        until: [{ element_present: { role: 'button', name: '查看' } }],
        section: 'preamble',
      },
    ],
    snap: (e, p) =>
      evalIn(e, p, () => ({
        scrollTop: Math.round((document.getElementById('viewport') as HTMLElement).scrollTop),
        detail: document.getElementById('detail')?.textContent ?? '',
      })),
    plan: [
      {
        title: `在表格上滚轮向下 ${DY} 像素（坐标）`,
        until: (v) => v.all({ role: 'button', name: '查看', full: true }).length >= 4,
        async actions(v) {
          const [x, y] = (v.all({ role: 'button', name: '查看', full: true })[3] as Seen).center;
          return [{ op: 'scroll', at: [x, y], dy: DY }];
        },
        kinds: ['container'],
        expect: (b, a) => {
          const moved = (a as VtSnap).scrollTop - (b as VtSnap).scrollTop;
          return Math.abs(moved - DY) <= 2 ? null : fail(`滚动容器应下移 ${DY}，实际 ${moved}`);
        },
      },
      {
        title: '点滚出来的第一行的“查看”（数据按块加载，等按钮出现）',
        until: (v) => v.all({ role: 'button', name: '查看', full: true }).length >= 4,
        async actions(v) {
          const b = v.top({ role: 'button', name: '查看', full: true });
          rowId = /data-id='(R\d+)'/.exec(b.within ?? '')?.[1] ?? '';
          return [{ op: 'click_at', x: b.center[0], y: b.center[1] }];
        },
        kinds: ['locator'],
        expect: (_b, a) => {
          const s = a as VtSnap;
          return rowId && s.detail.startsWith(`当前查看：${rowId}`)
            ? null
            : fail(`详情应是 ${rowId}，实际“${s.detail}”`);
        },
      },
    ],
  };
}

// ---------- 看板与画布（本文件自带）

type BoardSnap = {
  cols: Record<string, string[]>;
  nodes: Record<string, Pt>;
  log: string[];
  canvas: Pt;
};

function boardScene(env: Env): Scene {
  const base = (env.board as Site).base;
  // 节点 A 拖到画布内的哪个位置（相对画布框的比例），读图时换算成视口坐标
  let target: Pt = [0, 0];
  const dragCard = (card: string, testid: string, col: string): PlanStep => ({
    title: `把卡片“${card}”拖到“${col}”列`,
    async actions(v) {
      const from = v.one({ name: card }).center;
      const to = v.one({ name: col }).center;
      return [{ op: 'drag', from, to }];
    },
    kinds: ['locator'],
    expect: (_b, a) => {
      const s = a as BoardSnap;
      const colKey = { 进行中: 'doing', 已完成: 'done' }[col] as string;
      return (s.cols[colKey] ?? []).includes(testid)
        ? null
        : fail(`卡片 ${testid} 应在“${col}”，实际 ${JSON.stringify(s.cols)}`);
    },
  });
  return {
    id: 'board',
    title: '看板与画布（自带页面，M5 换成 Lab 看板）',
    preamble: [
      { op: 'navigate_page', url: `${base}/board`, section: 'preamble' },
      {
        op: 'wait_for',
        until: [{ element_present: { role: 'img', name: '流程画布' } }],
        section: 'preamble',
      },
    ],
    snap: (e, p) =>
      evalIn(e, p, () => {
        const w = window as unknown as {
          board: {
            cols: Record<string, string[]>;
            nodes: Record<string, [number, number]>;
            log: string[];
          };
        };
        const r = (document.getElementById('flow') as HTMLElement).getBoundingClientRect();
        return {
          cols: JSON.parse(JSON.stringify(w.board.cols)),
          nodes: JSON.parse(JSON.stringify(w.board.nodes)),
          log: [...w.board.log],
          canvas: [r.left, r.top] as [number, number],
        };
      }),
    plan: [
      dragCard('写需求文档', 'c1', '进行中'),
      dragCard('评审方案', 'c2', '已完成'),
      {
        title: '在画布里把橙色节点 A 拖到右下方（读图找到节点）',
        async actions(v) {
          const canvas = v.one({ role: 'img', name: '流程画布' });
          const a = findBlob(v.png, inset(canvas.box, 6), [0xe6, 0x7e, 0x22], v.scale);
          if (!a) throw new Error('截图上找不到橙色节点');
          target = [
            round1(canvas.box[0] + canvas.box[2] * 0.7),
            round1(canvas.box[1] + canvas.box[3] * 0.75),
          ];
          return [{ op: 'drag', from: [round1(a.cx), round1(a.cy)], to: target }];
        },
        kinds: ['volatile'],
        expect: (_b, a) => {
          const s = a as BoardSnap;
          const want: Pt = [
            Math.round(target[0] - s.canvas[0]),
            Math.round(target[1] - s.canvas[1]),
          ];
          const got = s.nodes.A as Pt;
          return Math.abs(got[0] - want[0]) <= 2 && Math.abs(got[1] - want[1]) <= 2
            ? null
            : fail(`节点 A 应在画布内 ${pt(want)}，实际 ${pt(got)}`);
        },
      },
      {
        title: '点“保存布局”按钮',
        async actions(v) {
          const [x, y] = v.one({ role: 'button', name: '保存布局' }).center;
          return [{ op: 'click_at', x, y }];
        },
        kinds: ['locator'],
        expect: (b, a) => {
          const s = a as BoardSnap;
          const d = s.log.slice((b as BoardSnap).log.length);
          return eq(d, [`已保存布局：${JSON.stringify(s.cols)}`])
            ? null
            : fail(`日志应记下布局，实际 ${JSON.stringify(d)}`);
        },
      },
    ],
    async verify(_e, _p, v) {
      const canvas = v.one({ role: 'img', name: '流程画布' });
      const a = findBlob(v.png, inset(canvas.box, 6), [0xe6, 0x7e, 0x22], v.scale);
      const b = findBlob(v.png, inset(canvas.box, 6), [0x27, 0xae, 0x60], v.scale);
      const ok = Boolean(
        a &&
          b &&
          Math.abs((a?.r ?? 0) - 30) < 2 &&
          Math.abs((b?.r ?? 0) - 30) < 2 &&
          (b?.cx ?? 0) > (a?.cx ?? 0),
      );
      return [
        {
          label: '从截图读出两个节点（橙、绿）',
          ok,
          detail:
            a && b
              ? `A 在 ${pt([a.cx, a.cy])}，B 在 ${pt([b.cx, b.cy])}，半径约 ${round1(a.r)}`
              : '找不到节点',
        },
      ];
    },
  };
}

const inset = (r: Rect, n: number): Rect => [
  r[0] + n,
  r[1] + n,
  Math.max(0, r[2] - 2 * n),
  Math.max(0, r[3] - 2 * n),
];

// ---------- 公开站点 UI Testing Playground（--live，未实测）

function liveScenes(site: string): Scene[] {
  const simple = (path: string, ready: Raw['until']) =>
    [
      { op: 'navigate_page', url: `${site}${path}`, section: 'preamble' },
      { op: 'wait_for', until: ready, section: 'preamble' },
    ] as Raw[];
  return [
    {
      id: 'live-textinput',
      title: 'UI Testing Playground：Text Input',
      live: true,
      preamble: simple('/textinput', [{ element_present: { css: '#newButtonName' } }]),
      snap: (e, p) =>
        evalIn(e, p, () => ({
          button: document.getElementById('updatingButton')?.textContent ?? '',
        })),
      plan: [
        {
          title: '点输入框、键入“Obact”，再点下面的按钮（按钮应改名）',
          async actions(v) {
            const input = v.one({ role: 'textbox' }).center;
            const button = v.one({ role: 'button', name: /Button That Should Change/ }).center;
            return [
              { op: 'click_at', x: input[0], y: input[1] },
              { op: 'type_text', text: 'Obact' },
              { op: 'click_at', x: button[0], y: button[1] },
            ];
          },
          kinds: ['locator', 'plain', 'locator'],
          expect: (_b, a) =>
            (a as { button: string }).button === 'Obact'
              ? null
              : fail(`按钮应改名为 Obact，实际“${(a as { button: string }).button}”`),
        },
      ],
    },
    {
      id: 'live-click',
      title: 'UI Testing Playground：Click（忽略 DOM click 事件的按钮）',
      live: true,
      preamble: simple('/click', [{ element_present: { css: '#badButton' } }]),
      snap: (e, p) =>
        evalIn(e, p, () => ({ cls: document.getElementById('badButton')?.className ?? '' })),
      plan: [
        {
          title: '用坐标点那个只认真实鼠标的按钮（应变绿）',
          async actions(v) {
            const [x, y] = v.one({ role: 'button', name: /Ignores DOM Click Event/ }).center;
            return [{ op: 'click_at', x, y }];
          },
          kinds: ['locator'],
          expect: (_b, a) =>
            (a as { cls: string }).cls.includes('btn-success')
              ? null
              : fail('按钮应变成 btn-success'),
        },
      ],
    },
    {
      id: 'live-sampleapp',
      title: 'UI Testing Playground：Sample App（登录）',
      live: true,
      preamble: simple('/sampleapp', [{ element_present: { css: '#login' } }]),
      snap: (e, p) =>
        evalIn(e, p, () => ({ status: document.getElementById('loginstatus')?.textContent ?? '' })),
      plan: [
        {
          title: '点用户名框键入“obact”，点密码框键入“pwd”，点“Log In”',
          async actions(v) {
            const [user, pass] = v.all({ role: 'textbox' }).map((e) => e.center);
            if (!user || !pass) throw new Error('截图上找不到用户名和密码输入框');
            const [x, y] = v.one({ role: 'button', name: 'Log In' }).center;
            return [
              { op: 'click_at', x: user[0], y: user[1] },
              { op: 'type_text', text: 'obact' },
              { op: 'click_at', x: pass[0], y: pass[1] },
              { op: 'type_text', text: 'pwd' },
              { op: 'click_at', x, y },
            ];
          },
          kinds: ['locator', 'plain', 'locator', 'plain', 'locator'],
          expect: (_b, a) =>
            (a as { status: string }).status === 'Welcome, obact!'
              ? null
              : fail(`登录状态应为“Welcome, obact!”，实际“${(a as { status: string }).status}”`),
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// 录制（阶段一）与回放（阶段二、三）
// ---------------------------------------------------------------------------------------------

/** 步骤里只属于工作流、不属于动作调用的字段。 */
const STEP_ONLY = new Set([
  'step_id',
  'section',
  'volatile',
  'note',
  'pre',
  'retry',
  'on_fail',
  'once_only',
  'idempotency_key',
]);

const toAction = (row: Raw, pageId: string): Action => {
  const a: Raw = { op: row.op };
  for (const [k, v] of Object.entries(row)) if (!STEP_ONLY.has(k) && k !== 'pageId') a[k] = v;
  a.pageId = pageId;
  return a as unknown as Action;
};

type Rec = {
  plan: number;
  raw: Raw;
  row: Record<string, unknown>;
  kind: Kind;
  under: string;
  why: string;
  expectedKind: Kind;
  via: string | null;
};

type Recorded = {
  scene: Scene;
  recs: Rec[];
  preamble: Record<string, unknown>[];
  coords: Verdict[];
  facts: Fact[];
};

const describeRaw = (r: Raw): string => {
  if (r.op === 'click_at' || r.op === 'mouse_move')
    return `${r.op} ${pt([r.x as number, r.y as number])}`;
  if (r.op === 'drag') return `drag ${pt(r.from as Pt)} → ${pt(r.to as Pt)}`;
  if (r.op === 'scroll') return `scroll ${r.at ? `at ${pt(r.at as Pt)} ` : ''}dy=${r.dy ?? 0}`;
  if (r.op === 'type_text') return `type_text "${r.text}"`;
  if (r.op === 'press_key') return `press_key ${r.key}`;
  return r.op;
};

const locStr = (l: unknown): string => {
  if (Array.isArray(l)) return pt(l as Pt);
  const o = l as Locator;
  return [
    o.css,
    o.role ? `${o.role}${o.name ? ` "${o.name}"` : ''}` : '',
    o.within ? `在 ${o.within} 内` : '',
  ]
    .filter(Boolean)
    .join(' · ');
};

const describeRow = (r: Record<string, unknown>): string => {
  const op = r.op as string;
  const v = r.volatile ? '（易失效）' : '';
  if (op === 'click' || op === 'hover') return `${op} ${locStr(r.target)}`;
  if (op === 'drag') return `drag ${locStr(r.from)} → ${locStr(r.to)}${v}`;
  if (op === 'scroll')
    return `scroll ${r.target ? locStr(r.target) : r.at ? `at ${pt(r.at as Pt)}` : '整页'} dy=${r.dy ?? 0}${v}`;
  if (op === 'click_at' || op === 'mouse_move')
    return `${op} ${pt([r.x as number, r.y as number])}${v}`;
  return describeRaw(r as Raw);
};

/** 阶段一：用坐标动作完成，同时在每个坐标动作派发前固化。 */
async function recordScene(env: Env, scene: Scene): Promise<Recorded> {
  const pageId = await env.newPage();
  const out: Recorded = { scene, recs: [], preamble: [], coords: [], facts: [] };
  let seq = 0;
  const rowOf = (raw: Raw): Record<string, unknown> => {
    const { op, ...rest } = raw;
    return { step_id: `s${String(++seq).padStart(2, '0')}`, op, pageId: 'main', ...rest };
  };
  try {
    for (const raw of scene.preamble) {
      const r = await env.run(toAction(raw, pageId));
      if (r.status !== 'ok')
        throw new Error(`前置步骤 ${raw.op} 失败：${r.error?.code} ${r.error?.message}`);
      out.preamble.push(rowOf(raw));
    }
    let stop = false;
    for (const [i, step] of scene.plan.entries()) {
      if (stop) {
        out.coords.push({ ok: false, detail: '前面的步骤失败，没有执行' });
        continue;
      }
      // 读图：等到截图上出现需要的东西
      let got = await see(env, pageId);
      const until = step.until;
      if (until && !until(got.v)) {
        const w = await poll(
          async () => {
            got = await see(env, pageId);
            return got.v;
          },
          until,
          6000,
        );
        if (!w.ok) {
          out.coords.push({ ok: false, detail: '等不到截图上出现需要的东西' });
          stop = true;
          continue;
        }
      }
      if (i === 0) {
        out.facts.push(
          {
            label: '编号框截图尺寸 = 视口 × 缩放比例',
            ok: got.sizeOk,
            detail: `${got.v.png.w}×${got.v.png.h}，视口 ${got.v.ob.viewport.width}×${got.v.ob.viewport.height}，缩放 ${got.v.scale}`,
          },
          {
            label: '每个可见元素的框都画在 bbox 的位置',
            ok: got.boxes.total > 0 && got.boxes.drawn === got.boxes.total,
            detail: `${got.boxes.drawn}/${got.boxes.total}`,
          },
          ...((await scene.verify?.(env, pageId, got.v)) ?? []),
        );
      }
      const before = await scene.snap(env, pageId);
      let raws: Raw[];
      try {
        raws = await step.actions(got.v);
      } catch (e) {
        out.coords.push({ ok: false, detail: `读图失败：${(e as Error).message}` });
        stop = true;
        continue;
      }
      const results: ActResult[] = [];
      let broke = '';
      for (const [k, raw] of raws.entries()) {
        const sol = await solidify(env, pageId, raw);
        const r = await env.run(toAction(raw, pageId));
        results.push(r);
        out.recs.push({
          plan: i,
          raw,
          row: rowOf(sol.row),
          kind: sol.kind,
          under: sol.under,
          why: sol.why,
          expectedKind: step.kinds[k] ?? 'plain',
          via: r.locator_used ?? null,
        });
        if (r.status !== 'ok') {
          broke = `${describeRaw(raw)} 失败：${r.error?.code} ${r.error?.message}`;
          break;
        }
      }
      if (broke) {
        out.coords.push({ ok: false, detail: broke });
        stop = true;
        continue;
      }
      const verdict = await settle(env, scene, pageId, step, before, results);
      out.coords.push(verdict);
      if (!verdict.ok) stop = true;
    }
  } finally {
    await env.run({ op: 'close_page', pageId }).catch(() => {});
  }
  return out;
}

/** 等到这一步的效果出现（条件等待），超时返回最后一次的失败原因。 */
async function settle(
  env: Env,
  scene: Scene,
  pageId: string,
  step: PlanStep,
  before: unknown,
  results: ActResult[],
): Promise<Verdict> {
  const w = await poll(
    async () => {
      const after = await scene.snap(env, pageId);
      return step.expect(before, after, results);
    },
    (why) => why === null,
  );
  return w.ok ? { ok: true, detail: '效果符合预期' } : { ok: false, detail: w.value ?? '' };
}

/** 用固化后的步骤在新页面上回放；resize 为 true 时先把窗口缩小。 */
async function replayScene(env: Env, rec: Recorded, resize: boolean): Promise<Verdict[]> {
  const { scene } = rec;
  const pageId = await env.newPage();
  const verdicts: Verdict[] = [];
  try {
    if (resize) await pageOf(env, pageId).setViewport(SMALL_VIEWPORT);
    for (const row of rec.preamble) {
      const r = await env.run(toAction(row as Raw, pageId));
      if (r.status !== 'ok')
        throw new Error(`回放前置步骤 ${row.op} 失败：${r.error?.code} ${r.error?.message}`);
    }
    for (const [i, step] of scene.plan.entries()) {
      const group = rec.recs.filter((r) => r.plan === i);
      if (!group.length) {
        verdicts.push({ ok: false, detail: '录制阶段没有走到这一步' });
        continue;
      }
      const before = await scene.snap(env, pageId);
      const results: ActResult[] = [];
      const problems: string[] = [];
      for (const g of group) {
        const r = await env.run(toAction(g.row as Raw, pageId));
        results.push(r);
        if (r.status !== 'ok') {
          problems.push(`${describeRow(g.row)} 失败：${r.error?.code} ${r.error?.message}`);
          break;
        }
        // 换算过的步骤必须走定位器，保留坐标的步骤走坐标
        if (
          (g.kind === 'locator' || g.kind === 'container') &&
          (r.locator_used === 'coord' || r.locator_used === 'ref')
        ) {
          problems.push(`${describeRow(g.row)} 应走定位器，实际 ${r.locator_used}`);
        }
        if (
          g.kind === 'volatile' &&
          r.locator_used !== 'coord' &&
          (g.row.op === 'click_at' || g.row.op === 'mouse_move')
        ) {
          problems.push(`${describeRow(g.row)} 应走坐标，实际 ${r.locator_used}`);
        }
      }
      if (problems.length) {
        verdicts.push({ ok: false, detail: problems.join('；') });
        continue;
      }
      verdicts.push(await settle(env, scene, pageId, step, before, results));
    }
  } finally {
    await env.run({ op: 'close_page', pageId }).catch(() => {});
  }
  return verdicts;
}

// ---------------------------------------------------------------------------------------------
// 汇总与输出
// ---------------------------------------------------------------------------------------------

function buildResult(
  rec: Recorded,
  replay: Verdict[],
  resized: Verdict[],
  outDir: string | null,
): SceneResult {
  const { scene } = rec;
  const rows = [...rec.preamble, ...rec.recs.map((r) => r.row)];
  const stepErrors: string[] = [];
  for (const row of rows) {
    const errs = contracts.check('step', row);
    if (errs) stepErrors.push(`${row.step_id}：${contracts.ajv.errorsText(errs)}`);
  }
  // 固化后只允许“易失效”的步骤带坐标，其余不能剩下坐标；定位器目标里不能有编号
  for (const r of rec.recs) {
    const row = r.row;
    const hasCoord =
      row.x !== undefined ||
      row.at !== undefined ||
      Array.isArray(row.from) ||
      Array.isArray(row.to);
    if (hasCoord && row.volatile !== true)
      stepErrors.push(`${row.step_id}：带坐标的步骤没有标记 volatile`);
    if (!hasCoord && row.volatile === true)
      stepErrors.push(`${row.step_id}：没有坐标的步骤不应标记 volatile`);
    if (JSON.stringify(row).includes('"ref"')) stepErrors.push(`${row.step_id}：步骤里出现了编号`);
  }
  const plans: PlanItem[] = scene.plan.map((step, i) => {
    const group = rec.recs.filter((r) => r.plan === i);
    const rowItems: RowItem[] = group.map((g) => ({
      coord: describeRaw(g.raw),
      under: g.under,
      solid: describeRow(g.row),
      kind: g.kind,
      expectedKind: g.expectedKind,
      why: g.why,
    }));
    return {
      no: i + 1,
      title: step.title,
      rows: rowItems,
      coords: rec.coords[i] ?? { ok: false, detail: '没有执行' },
      replay: replay[i] ?? { ok: false, detail: '没有回放' },
      resized: resized[i] ?? { ok: false, detail: '没有回放' },
      volatile: group.some((g) => g.kind === 'volatile'),
    };
  });
  let jsonlPath: string | null = null;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    jsonlPath = join(outDir, `${scene.id}.jsonl`);
    writeFileSync(jsonlPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return {
    id: scene.id,
    title: scene.title,
    live: scene.live === true,
    plans,
    steps: rows,
    stepErrors,
    facts: rec.facts,
    jsonlPath,
  };
}

function summarize(scenes: SceneResult[]): Summary {
  const s: Summary = {
    scenes: scenes.length,
    plans: 0,
    coordinateSteps: 0,
    locator: 0,
    volatile: 0,
    page: 0,
    container: 0,
    kindMismatch: 0,
    coordsFailed: 0,
    replayFailed: 0,
    resizedFailed: 0,
    resizedVolatileDiverged: 0,
    volatilePlans: 0,
    stepErrors: 0,
    factsFailed: 0,
  };
  for (const sc of scenes) {
    s.stepErrors += sc.stepErrors.length;
    s.factsFailed += sc.facts.filter((f) => !f.ok).length;
    for (const p of sc.plans) {
      s.plans++;
      if (!p.coords.ok) s.coordsFailed++;
      if (!p.replay.ok) s.replayFailed++;
      if (p.volatile) {
        s.volatilePlans++;
        if (!p.resized.ok) s.resizedVolatileDiverged++;
      } else if (!p.resized.ok) s.resizedFailed++;
      for (const r of p.rows) {
        if (r.kind !== 'plain') s.coordinateSteps++;
        if (r.kind === 'locator') s.locator++;
        else if (r.kind === 'volatile') s.volatile++;
        else if (r.kind === 'page') s.page++;
        else if (r.kind === 'container') s.container++;
        if (r.kind !== r.expectedKind) s.kindMismatch++;
      }
    }
  }
  return s;
}

function judge(scenes: SceneResult[], s: Summary): string[] {
  const failures: string[] = [];
  if (!scenes.length) failures.push('没有场景结果');
  for (const sc of scenes) {
    for (const f of sc.facts.filter((x) => !x.ok))
      failures.push(`${sc.title}：${f.label}不成立（${f.detail}）`);
    for (const e of sc.stepErrors) failures.push(`${sc.title}：步骤不符合契约或固化规则 ${e}`);
    for (const p of sc.plans) {
      const tag = `${sc.title} 第 ${p.no} 步“${p.title}”`;
      if (!p.coords.ok) failures.push(`${tag}：坐标动作没有完成（${p.coords.detail}）`);
      for (const r of p.rows) {
        if (r.kind !== r.expectedKind)
          failures.push(
            `${tag}：${r.coord} 固化成“${KIND_LABEL[r.kind]}”，应为“${KIND_LABEL[r.expectedKind]}”（${r.why}）`,
          );
      }
      if (!p.replay.ok) failures.push(`${tag}：固化后回放失败（${p.replay.detail}）`);
      if (!p.volatile && !p.resized.ok)
        failures.push(`${tag}：窗口缩小后定位器步骤回放失败（${p.resized.detail}）`);
    }
  }
  if (!s.volatile && scenes.some((x) => !x.live))
    failures.push('没有任何步骤保留为易失效坐标（Canvas 上的点击应保留坐标）');
  return failures;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mark = (v: Verdict) => (v.ok ? '通过' : `**失败**：${esc(v.detail)}`);

function sceneMarkdown(sc: SceneResult): string[] {
  const lines = [`### ${sc.title}`, ''];
  if (sc.facts.length) {
    lines.push('读图核对：', '');
    for (const f of sc.facts)
      lines.push(`- ${f.ok ? '通过' : '**不成立**'}：${f.label}（${esc(f.detail)}）`);
    lines.push('');
  }
  lines.push(
    '| # | 步骤 | 坐标动作（读图所得） | 位置上是什么 | 固化后 | 坐标阶段 | 固化后回放 | 窗口缩小后回放 |',
    '|--:|---|---|---|---|---|---|---|',
  );
  for (const p of sc.plans) {
    const col = (f: (r: RowItem) => string) => p.rows.map((r) => esc(f(r))).join('<br>');
    lines.push(
      `| ${p.no} | ${esc(p.title)} | ${col((r) => r.coord)} | ${col((r) => r.under || '—')} | ${col((r) => `${r.kind === 'plain' ? '' : `【${KIND_LABEL[r.kind]}】`}${r.solid}`)} | ${mark(p.coords)} | ${mark(p.replay)} | ${p.volatile ? `${p.resized.ok ? '仍通过' : `结果变了（易失效，符合预期）：${esc(p.resized.detail)}`}` : mark(p.resized)} |`,
    );
  }
  lines.push(
    '',
    '固化后的步骤（JSONL）：',
    '',
    '```jsonl',
    ...sc.steps.map((r) => JSON.stringify(r)),
    '```',
    '',
  );
  return lines;
}

function summaryTable(s: Summary): string[] {
  return [
    '| 指标 | 数量 |',
    '|---|--:|',
    `| 场景 | ${s.scenes} |`,
    `| 操作步骤（每步含若干动作） | ${s.plans} |`,
    `| 坐标动作 | ${s.coordinateSteps} |`,
    `| 换算成元素定位器 | ${s.locator} |`,
    `| 滚轮换算成整页滚动 | ${s.page} |`,
    `| 滚轮换算成滚动容器定位器 | ${s.container} |`,
    `| 保留坐标、标记易失效 | ${s.volatile} |`,
    `| 固化类型与预期不符 | ${s.kindMismatch} |`,
    `| 坐标阶段未完成的步骤 | ${s.coordsFailed} |`,
    `| 固化后回放失败的步骤 | ${s.replayFailed} |`,
    `| 窗口缩小后定位器步骤失败 | ${s.resizedFailed} |`,
    `| 窗口缩小后易失效步骤的结果与录制时不同 | ${s.resizedVolatileDiverged} / ${s.volatilePlans} |`,
    `| 步骤契约或固化规则违反 | ${s.stepErrors} |`,
    `| 读图核对不成立 | ${s.factsFailed} |`,
  ];
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function run(opts: RunOptions = {}): Promise<Bw12Report> {
  const local = opts.local ?? true;
  const wantLive = opts.live ?? false;
  const liveBase = opts.liveBase ?? LIVE_BASE;
  const outDir = opts.outDir ?? DEFAULT_OUT;
  const stepsDir = join(outDir, local ? 'bw12-steps' : 'bw12-live-steps');
  const say = (s = '') => {
    if (!opts.quiet) console.log(s);
  };
  const env = await startEnv({ local, chromePath: opts.chromePath });
  const scenes: SceneResult[] = [];
  const liveScenesOut: SceneResult[] = [];
  let liveReachable = false;
  const started = Date.now();
  const exec = async (scene: Scene, into: SceneResult[]) => {
    const t0 = Date.now();
    const rec = await recordScene(env, scene);
    const replay = await replayScene(env, rec, false);
    const resized = await replayScene(env, rec, true);
    into.push(buildResult(rec, replay, resized, stepsDir));
    say(`  ${scene.title}：${scene.plan.length} 步（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  };
  try {
    if (local) {
      for (const scene of [
        canvasScene(env),
        await labScene(env, 'bw12-lab'),
        virtualTableScene(env),
        boardScene(env),
      ]) {
        await exec(scene, scenes);
      }
    }
    if (wantLive) {
      liveReachable = await reachable(liveBase);
      if (liveReachable) for (const scene of liveScenes(liveBase)) await exec(scene, liveScenesOut);
      else say(`  公开站点 ${liveBase} 访问不了，跳过（${LIVE_NOTE}）`);
    }
  } finally {
    await env.close();
  }

  const summary = summarize(scenes);
  const failures = local ? judge(scenes, summary) : [];
  const report: Bw12Report = {
    scenes,
    summary,
    live: { requested: wantLive, reachable: liveReachable, note: LIVE_NOTE, scenes: liveScenesOut },
    pass: failures.length === 0,
    failures,
    reportPath: join(outDir, local ? 'bw12-report.md' : 'bw12-live-report.md'),
    jsonPath: join(outDir, local ? 'bw12-results.json' : 'bw12-live-results.json'),
    stepsDir,
  };

  const md: string[] = [
    '# BW-12 视觉观察与坐标动作',
    '',
    `运行时间：${new Date().toISOString()}，耗时 ${((Date.now() - started) / 1000).toFixed(0)} 秒。`,
    '',
    '做法：observe 带编号框截图（views 含 som）；位置只从截图读：有框的元素取 bbox 中心，Canvas 里的柱子和节点按颜色读截图像素；',
    '用 click_at、mouse_move、drag、scroll（给坐标）、type_text、press_key 完成操作，每步检查页面上的真实效果。',
    '每个坐标动作在派发前用 locatorAtPoint 固化：DOM 元素换成定位器，Canvas 上的点保留坐标并标记 volatile，滚轮按坐标下有没有内部滚动容器换算。',
    '固化后的步骤逐行用 step.json 校验，在新页面上回放一遍，再把窗口缩小（1280×713 → 1024×640）回放一遍。',
    '通过标准：全部完成；有 DOM 元素的位置全部换算成定位器；Canvas 上的点击保留坐标并标记易失效；固化后回放结果与录制时一致；窗口缩小后定位器步骤照常成功。',
    '',
  ];
  if (local) {
    md.push(
      `## 结论：${report.pass ? '通过' : '不通过'}`,
      '',
      ...(failures.length
        ? failures.map((f) => `- ${f}`)
        : [
            '- 全部完成，DOM 位置全部换成定位器，Canvas 点击保留坐标并标记易失效，固化后回放一致。',
          ]),
      '',
      '## 汇总',
      '',
      ...summaryTable(summary),
      '',
      '## 逐场景',
      '',
      ...scenes.flatMap(sceneMarkdown),
    );
  }
  if (wantLive) {
    md.push('## 公开站点（UI Testing Playground）', '', `> ${LIVE_NOTE}`, '');
    if (liveReachable)
      md.push(
        ...summaryTable(summarize(liveScenesOut)),
        '',
        ...liveScenesOut.flatMap(sceneMarkdown),
      );
    else md.push('本次运行访问不了公开站点，没有结果。', '');
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(report.reportPath, `${md.join('\n')}\n`);
  writeFileSync(report.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  say();
  say(md.join('\n'));
  say(`报告：${report.reportPath}`);
  say(`步骤：${stepsDir}/<场景>.jsonl`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const all = process.argv.includes('--all');
  const live = all || process.argv.includes('--live');
  const local = all || !process.argv.includes('--live');
  const report = await run({ live, local });
  const ranLive = live && report.live.reachable;
  process.exitCode = (local && !report.pass) || (live && !ranLive && !local) ? 1 : 0;
}
