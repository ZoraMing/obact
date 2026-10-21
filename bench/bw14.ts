// BW-14 组件识别对照：同一批页面分别用 Obact 与 BrowserGym 提取可交互元素，按位置逐条比对。
// Obact 一侧取 observe 返回的 elements（智能体实际看到的元素表，含 iframe 内元素），不是识别层的原始编号。
// 页面：组件陈列页、测试应用（Lab）各模块不需要登录的页面、130 个 MiniWoB++ 任务页。
// 用法：node bench/bw14.ts [--limit N]   报告写到 bench/out/bw14-report.md
// 依赖：spikes/miniwob/fetch.sh 准备的 MiniWoB++ 页面、bench/README.md 中的 BrowserGym 虚拟环境。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab } from '../lab/src/app.ts';
import { launchBrowser, observe, Session } from '../packages/core/src/index.ts';
import { testChrome } from '../tools/browser.ts';
import { resolveStatic } from '../tools/static.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINIWOB = process.env.MINIWOB_HTML ?? join(ROOT, 'spikes/.cache/miniwob-pkg/miniwob/html');
const BG_PYTHON = process.env.BG_PYTHON ?? join(ROOT, 'spikes/.cache/venv-bg/bin/python');
const CHROME = (await testChrome()) as string;
const VIEW = { width: 800, height: 600 };
const SETTLE_MS = 300;
const IOU = 0.6;

type Item = {
  role: string;
  name: string;
  visibility: number;
  bbox: [number, number, number, number] | null;
};
type BgItem = Item & { bid: string; tag: string; clickable: boolean };
type ObItem = Item & { ref: number; hint: string; options: string[] };
/** 一个页面上 Obact 一侧的结果：observe 的元素表，加上 label 核对用的数据（只取主文档）。 */
type ObPage = {
  items: ObItem[];
  /** observe 因字符预算截掉了元素。 */
  truncated: boolean;
  /** 主文档里 label 的个数，以及有标注控件的 label 所标注的控件位置。 */
  labels: { total: number; controls: NonNullable<Item['bbox']>[] };
};

// ---------- 静态服务 ----------
const MOUNTS: Record<string, string> = {
  '/miniwob-html/': MINIWOB,
  '/pages/': join(ROOT, 'packages/core/test/pages'),
};
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://x').pathname;
  } catch {
    // 请求目标不合法：回 400，异常冒出去会让整个基准进程退出
    return void res.writeHead(400).end();
  }
  const mount = Object.keys(MOUNTS).find((m) => path.startsWith(m));
  if (!mount) return void res.writeHead(404).end();
  const target = resolveStatic(MOUNTS[mount] as string, path.slice(mount.length));
  if ('status' in target) return void res.writeHead(target.status).end();
  try {
    const body = await readFile(target.file);
    res.writeHead(200, {
      'content-type': TYPES[extname(target.file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// ---------- 页面清单 ----------
// 测试应用（Lab）各模块不需要登录的页面；订单、账号页需要登录态，BrowserGym 一侧的脚本不带 cookie，不在对照范围
const lab = await createLab();
const labBase = lab.url('bw14');
const LAB_PATHS = [
  '/login',
  '/verify',
  '/structure',
  '/structure/outer',
  '/structure/frame?who=same',
  '/structure/frame?who=cross',
  '/structure/frame?who=shadow',
  '/structure/report',
  '/structure/library',
  '/noise',
  '/noise/entry-ad',
];
if (!existsSync(MINIWOB)) {
  console.error(`找不到 MiniWoB++ 页面：${MINIWOB}（先运行 spikes/miniwob/fetch.sh）`);
  process.exit(1);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const tasks = readdirSync(join(MINIWOB, 'miniwob'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.slice(0, -5))
  .sort()
  .slice(0, limit);
const urls = [
  `${base}/pages/components.html`,
  ...LAB_PATHS.map((p) => labBase + p),
  ...tasks.map((t) => `${base}/miniwob-html/miniwob/${t}.html#seed=0`),
];

// ---------- BrowserGym 侧 ----------
function runBrowserGym(list: string[]): Promise<Map<string, BgItem[] | string>> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      BG_PYTHON,
      [
        join(ROOT, 'bench/browsergym_extract.py'),
        '--width',
        String(VIEW.width),
        '--height',
        String(VIEW.height),
        '--settle-ms',
        String(SETTLE_MS),
        ...list,
      ],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers',
        },
      },
    );
    let buf = '';
    const out = new Map<string, BgItem[] | string>();
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c: string) => {
      buf += c;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const o = JSON.parse(buf.slice(0, i)) as { url: string; items?: BgItem[]; error?: string };
        out.set(o.url, o.items ?? `错误：${o.error}`);
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    });
    p.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`BrowserGym 进程退出码 ${code}`)),
    );
  });
}

// ---------- Obact 侧 ----------
async function runObact(list: string[]): Promise<Map<string, ObPage | string>> {
  const browser = await launchBrowser({
    profileDir: mkdtempSync(join(tmpdir(), 'obact-bw14-')),
    chromePath: CHROME,
    mode: 'headless',
    windowSize: VIEW,
  });
  const s = await Session.attach(browser);
  const pageId = await s.pages.newPage({ pageId: 'bench' });
  const page = s.pages.get(pageId);
  await page.setViewport(VIEW);
  const out = new Map<string, ObPage | string>();
  for (const url of list) {
    const [u, seed] = url.split('#seed=') as [string, string | undefined];
    try {
      await page.goto(u, { waitUntil: 'load' });
      if (seed !== undefined) {
        await page.evaluate(
          (n) => (Math as unknown as { seedrandom(n: number): void }).seedrandom(n),
          Number(seed),
        );
        await page.click('#sync-task-cover');
      }
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const r = await observe(s, { pageId });
      const labels = await page.evaluate(() => {
        const all = [...document.querySelectorAll('label')];
        const controls = all.flatMap((l) => {
          const b = l.control?.getBoundingClientRect();
          return b && b.width > 0 && b.height > 0 ? [[b.x, b.y, b.width, b.height]] : [];
        });
        return { total: all.length, controls };
      });
      out.set(url, {
        items: r.elements.map((e) => ({
          ref: e.ref,
          role: e.role,
          name: e.name.slice(0, 60),
          hint: e.hint ?? '',
          options: e.options?.map((x) => x.label) ?? [],
          visibility: e.visible_ratio,
          bbox: e.bbox as NonNullable<Item['bbox']>,
        })),
        truncated: r.truncated,
        labels: labels as ObPage['labels'],
      });
    } catch (e) {
      out.set(url, `错误：${(e as Error).message.slice(0, 120)}`);
    }
  }
  await s.close({ closeBrowser: true });
  return out;
}

// ---------- 比对 ----------
function iou(a: Item['bbox'], b: Item['bbox']): number {
  if (!a || !b) return 0;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** b 的中心点是否落在 a 内。 */
function covers(a: Item['bbox'], b: Item['bbox']): boolean {
  if (!a || !b) return false;
  const cx = b[0] + b[2] / 2;
  const cy = b[1] + b[3] / 2;
  return cx >= a[0] && cx <= a[0] + a[2] && cy >= a[1] && cy <= a[1] + a[3];
}

/**
 * 从分母扣除的 BrowserGym 节点（Obact 有意不单列为元素），逐条记进报告：
 * - option：下拉框、列表框的选项，名称在某个元素的 options 字段里（含被列表框裁掉一部分的选项）；
 * - folded：与已列出的元素同位置的重复外壳（如树节点里的 span.folder、控件外面的 ui-wrapper），observe 折叠进内层元素。
 */
type Dropped = { item: BgItem; why: 'option' | 'folded' };

type PageResult = {
  url: string;
  /** BrowserGym 可见可交互元素（不含页面根与 label），即未扣除时的分母。 */
  bg: number;
  ob: number;
  matched: number;
  missed: BgItem[];
  dropped: Dropped[];
  extra: ObItem[];
  roleDiff: string[];
  /** 不计入分母的 BrowserGym 节点：页面根（body/html）与 label（点击效果等同于其控件）。 */
  excluded: { root: number; label: number };
  /** 主文档 label 核对：label 总数、有标注控件的个数、其控件没出现在 observe 元素表里的个数。 */
  labels: { total: number; withControl: number; unlisted: number };
  truncated: boolean;
  error?: string;
};

/** BrowserGym 与 Obact 角色名的对应（Chrome 内部角色名 → ARIA 角色）。 */
const ROLE_ALIAS: Record<string, string> = {
  Date: 'textbox',
  DateTime: 'textbox',
  ColorWell: 'button',
  DisclosureTriangle: 'button',
  MenuListPopup: 'listbox',
  MenuListOption: 'option',
};

function compare(url: string, bg: BgItem[], page: ObPage): PageResult {
  const ob = page.items;
  const visible = <T extends Item>(x: T) =>
    x.visibility > 0 && !!x.bbox && x.bbox[2] > 0 && x.bbox[3] > 0;
  const all = bg.filter(visible);
  // Shadow DOM 里的 label 取不到标签名（标签名只查顶层文档），按 Chrome 的角色名 LabelText 认
  const isLabel = (x: BgItem) => x.tag === 'label' || x.role === 'LabelText';
  const isRoot = (x: BgItem) => x.tag === 'body' || x.tag === 'html';
  const excluded = {
    root: all.filter(isRoot).length,
    label: all.filter(isLabel).length,
  };
  const g = all.filter((x) => !isRoot(x) && !isLabel(x));
  // 识别到就算命中：Obact 侧不按可见性过滤（如 opacity 为 0 的真实输入框，Obact 识别但判为不可见）
  const o = ob.filter((x) => !!x.bbox && x.bbox[2] > 0 && x.bbox[3] > 0);
  const used = new Set<number>();
  const pair = new Map<number, number>();
  // 两轮匹配：先要求角色一致，再只按位置
  for (const sameRole of [true, false]) {
    g.forEach((b, bi) => {
      if (pair.has(bi)) return;
      let best = -1;
      let bestIou = IOU;
      o.forEach((x, i) => {
        if (used.has(i)) return;
        if (sameRole && (ROLE_ALIAS[b.role] ?? b.role) !== x.role) return;
        const v = iou(b.bbox, x.bbox);
        if (v >= bestIou) {
          bestIou = v;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        pair.set(bi, best);
      }
    });
  }
  const dropped: Dropped[] = [];
  const missed: BgItem[] = [];
  for (const m of g.filter((_, bi) => !pair.has(bi))) {
    if ((ROLE_ALIAS[m.role] ?? m.role) === 'option' && o.some((x) => x.options.includes(m.name)))
      dropped.push({ item: m, why: 'option' });
    else if (o.some((x) => iou(m.bbox, x.bbox) >= IOU)) dropped.push({ item: m, why: 'folded' });
    else missed.push(m);
  }
  const roleDiff: string[] = [];
  for (const [bi, oi] of pair) {
    const b = g[bi] as BgItem;
    const x = o[oi] as ObItem;
    const role = ROLE_ALIAS[b.role] ?? b.role;
    if (role !== x.role && role !== 'generic')
      roleDiff.push(`${b.role}→${x.role} "${x.name || `提示：${x.hint}`}"`);
  }
  const extra = o.filter((x, i) => !used.has(i) && x.visibility > 0);
  // label 不计入分母，所以另外核对：有标注控件的 label，其控件在 observe 的元素表里找得到
  const unlisted = page.labels.controls.filter(
    (c) => !o.some((x) => iou(x.bbox, c) >= IOU || covers(x.bbox, c)),
  ).length;
  const labels = { total: page.labels.total, withControl: page.labels.controls.length, unlisted };
  return {
    url,
    bg: g.length,
    ob: o.length,
    matched: pair.size,
    missed,
    dropped,
    extra,
    roleDiff,
    excluded,
    labels,
    truncated: page.truncated,
  };
}

console.log(`页面 ${urls.length} 个；运行 BrowserGym…`);
const bgAll = await runBrowserGym(urls);
console.log('运行 Obact…');
const obAll = await runObact(urls);
server.close();
await lab.close();

const results: PageResult[] = urls.map((url) => {
  const b = bgAll.get(url);
  const o = obAll.get(url);
  if (typeof b !== 'object' || typeof o !== 'object') {
    return {
      url,
      bg: 0,
      ob: 0,
      matched: 0,
      missed: [],
      dropped: [],
      extra: [],
      roleDiff: [],
      excluded: { root: 0, label: 0 },
      labels: { total: 0, withControl: 0, unlisted: 0 },
      truncated: false,
      error: `${b ?? ''} ${o ?? ''}`,
    };
  }
  return compare(url, b as BgItem[], o as ObPage);
});

const ok = results.filter((r) => !r.error);
const sum = (f: (r: PageResult) => number, rs = ok) => rs.reduce((n, r) => n + f(r), 0);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const totalBg = sum((r) => r.bg);
const totalDropped = sum((r) => r.dropped.length);
const denominator = totalBg - totalDropped;
const totalMatched = sum((r) => r.matched);
const droppedBy = (why: Dropped['why']) =>
  sum((r) => r.dropped.filter((d) => d.why === why).length);
const short = (u: string) =>
  u
    .replace(base, '')
    .replace(labBase, 'lab')
    .replace('/miniwob-html/miniwob/', '')
    .replace('#seed=0', '');
const groups: [string, (u: string) => boolean][] = [
  ['组件陈列页', (u) => u.startsWith(`${base}/pages/`)],
  ['Lab 各模块页面', (u) => u.startsWith(labBase)],
  ['MiniWoB++ 任务页', (u) => u.startsWith(`${base}/miniwob-html/`)],
];

const lines: string[] = [
  '# BW-14 组件识别对照报告',
  '',
  `页面 ${results.length} 个（成功 ${ok.length}）；视口 ${VIEW.width}×${VIEW.height}；按位置匹配（IoU ≥ ${IOU}），只计可见元素；Obact 一侧取 observe 的 elements（含 iframe 内元素）。`,
  '',
  `- BrowserGym 可交互元素：${totalBg}`,
  `- 从分母扣除：${totalDropped}（option 在 options 字段里 ${droppedBy('option')}、同位置折叠的重复元素 ${droppedBy('folded')}，逐条见下）`,
  `- 分母：${denominator}；Obact 匹配到：${totalMatched}（召回 ${pct(totalMatched, denominator)}）`,
  `- 不做扣除的召回：${totalMatched}/${totalBg}（${pct(totalMatched, totalBg)}）`,
  `- 不计入的 BrowserGym 节点：页面根 ${sum((r) => r.excluded.root)}、label ${sum((r) => r.excluded.label)}（点击 label 等同于点击其控件）`,
  `- 主文档 label 核对：${sum((r) => r.labels.total)} 个，其中有标注控件 ${sum((r) => r.labels.withControl)} 个，控件没出现在 observe 元素表里 ${sum((r) => r.labels.unlisted)} 个`,
  `- Obact 额外识别：${sum((r) => r.extra.length)}`,
  `- 角色不同：${sum((r) => r.roleDiff.length)}`,
  `- observe 结果被字符预算截断的页面：${ok.filter((r) => r.truncated).length}`,
  '',
  '| 页面组 | 页面 | 分母 | 匹配 | 召回 |',
  '|---|---|---|---|---|',
  ...groups.map(([name, f]) => {
    const rs = ok.filter((r) => f(r.url));
    const den = sum((r) => r.bg - r.dropped.length, rs);
    const hit = sum((r) => r.matched, rs);
    return `| ${name} | ${rs.length} | ${den} | ${hit} | ${pct(hit, den)} |`;
  }),
  '',
  '## 漏识别（BrowserGym 有、Obact 没有）',
  '',
  '| 页面 | 角色 | 名称 | BG clickable |',
  '|---|---|---|---|',
  ...ok.flatMap((r) =>
    r.missed.map(
      (m) => `| ${short(r.url)} | ${m.role} | ${m.name.slice(0, 30)} | ${m.clickable} |`,
    ),
  ),
  '',
  '## 从分母扣除的 BrowserGym 节点',
  '',
  '| 页面 | 角色 | 名称 | 类别 |',
  '|---|---|---|---|',
  ...ok.flatMap((r) =>
    r.dropped.map(
      (d) =>
        `| ${short(r.url)} | ${d.item.role} | ${d.item.name.slice(0, 30) || `<${d.item.tag}>`} | ${d.why === 'option' ? 'option 在 options 字段里' : '同位置折叠的重复元素'} |`,
    ),
  ),
  '',
  '## Obact 额外识别（BrowserGym 没有）',
  '',
  '| 页面 | 角色 | 名称 |',
  '|---|---|---|',
  ...ok.flatMap((r) =>
    r.extra.map((m) => `| ${short(r.url)} | ${m.role} | ${m.name.slice(0, 30)} |`),
  ),
  '',
  '## 角色不同（BrowserGym→Obact）',
  '',
  ...ok.flatMap((r) => r.roleDiff.map((d) => `- ${short(r.url)}：${d}`)),
  '',
  '## 失败页面',
  '',
  ...results.filter((r) => r.error).map((r) => `- ${short(r.url)}：${r.error}`),
  '',
];
const outDir = join(ROOT, 'bench/out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'bw14-report.md'), lines.join('\n'));
writeFileSync(join(outDir, 'bw14-results.json'), JSON.stringify(results, null, 2));
console.log(lines.slice(0, 22).join('\n'));
console.log(`报告：bench/out/bw14-report.md`);
