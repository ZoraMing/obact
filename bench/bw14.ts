// BW-14 组件识别对照：同一批页面分别用 Obact 与 BrowserGym 提取可交互元素，按位置逐条比对。
// 用法：node bench/bw14.ts [--limit N]   报告写到 bench/out/bw14-report.md
// 依赖：spikes/miniwob/fetch.sh 准备的 MiniWoB++ 页面、bench/README.md 中的 BrowserGym 虚拟环境。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, markPage, Session } from '../packages/core/src/index.ts';
import { bundle } from '../packages/core/src/page/bundle.ts';
import {
  DOM_LIB,
  obFindRef,
  obHint,
  obName,
  obRole,
  obVisibleRatio,
} from '../packages/core/src/page/dom.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINIWOB = process.env.MINIWOB_HTML ?? join(ROOT, 'spikes/.cache/miniwob-pkg/miniwob/html');
const BG_PYTHON = process.env.BG_PYTHON ?? join(ROOT, 'spikes/.cache/venv-bg/bin/python');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
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
type ObItem = Item & { ref: number; hint: string };

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
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const mount = Object.keys(MOUNTS).find((m) => path.startsWith(m));
  if (!mount) return void res.writeHead(404).end();
  const root = MOUNTS[mount] as string;
  const file = normalize(join(root, decodeURIComponent(path.slice(mount.length))));
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// ---------- 页面清单 ----------
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
const INFO = bundle(
  (refs: number[], attr: string, key: string) =>
    refs.map((ref) => {
      const el = obFindRef(ref, attr, key);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        ref,
        role: obRole(el),
        name: obName(el).slice(0, 60),
        hint: obName(el) ? '' : obHint(el),
        visibility: obVisibleRatio(el),
        bbox: [r.x, r.y, r.width, r.height] as [number, number, number, number],
      };
    }),
  DOM_LIB,
);

async function runObact(list: string[]): Promise<Map<string, ObItem[] | string>> {
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
  const out = new Map<string, ObItem[] | string>();
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
      const frames = await markPage(s, pageId);
      const top = frames[0]?.refs ?? [];
      const info = await page.evaluate(INFO, top, s.attr, s.refKey);
      out.set(
        url,
        info.flatMap((x) => (x ? [x] : [])),
      );
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

type PageResult = {
  url: string;
  bg: number;
  ob: number;
  matched: number;
  missed: BgItem[];
  extra: ObItem[];
  roleDiff: string[];
  /** 不计入分母的 BrowserGym 节点：页面根（body/html）与 label（点击效果等同于其控件）。 */
  excluded: { root: number; label: number };
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

function compare(url: string, bg: BgItem[], ob: ObItem[]): PageResult {
  const visible = <T extends Item>(x: T) =>
    x.visibility > 0 && !!x.bbox && x.bbox[2] > 0 && x.bbox[3] > 0;
  const all = bg.filter(visible);
  const excluded = {
    root: all.filter((x) => x.tag === 'body' || x.tag === 'html').length,
    label: all.filter((x) => x.tag === 'label').length,
  };
  const g = all.filter((x) => !['body', 'html', 'label'].includes(x.tag));
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
  const missed = g.filter((_, bi) => !pair.has(bi));
  const roleDiff: string[] = [];
  for (const [bi, oi] of pair) {
    const b = g[bi] as BgItem;
    const x = o[oi] as ObItem;
    const role = ROLE_ALIAS[b.role] ?? b.role;
    if (role !== x.role && role !== 'generic')
      roleDiff.push(`${b.role}→${x.role} "${x.name || `提示：${x.hint}`}"`);
  }
  const extra = o.filter((x, i) => !used.has(i) && x.visibility > 0);
  return { url, bg: g.length, ob: o.length, matched: pair.size, missed, extra, roleDiff, excluded };
}

console.log(`页面 ${urls.length} 个；运行 BrowserGym…`);
const bgAll = await runBrowserGym(urls);
console.log('运行 Obact…');
const obAll = await runObact(urls);
server.close();

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
      extra: [],
      roleDiff: [],
      excluded: { root: 0, label: 0 },
      error: `${b ?? ''} ${o ?? ''}`,
    };
  }
  return compare(url, b as BgItem[], o as ObItem[]);
});

const ok = results.filter((r) => !r.error);
const sum = (f: (r: PageResult) => number) => ok.reduce((n, r) => n + f(r), 0);
const totalBg = sum((r) => r.bg);
const totalMatched = sum((r) => r.matched);
const recall = totalBg ? totalMatched / totalBg : 1;
const short = (u: string) =>
  u.replace(base, '').replace('/miniwob-html/miniwob/', '').replace('#seed=0', '');

const lines: string[] = [
  '# BW-14 组件识别对照报告',
  '',
  `页面 ${results.length} 个（成功 ${ok.length}）；视口 ${VIEW.width}×${VIEW.height}；按位置匹配（IoU ≥ ${IOU}），只计可见元素。`,
  '',
  `- BrowserGym 可交互元素：${totalBg}`,
  `- Obact 匹配到：${totalMatched}（召回 ${(recall * 100).toFixed(1)}%）`,
  `- Obact 额外识别：${sum((r) => r.extra.length)}`,
  `- 不计入的 BrowserGym 节点：页面根 ${sum((r) => r.excluded.root)}、label ${sum((r) => r.excluded.label)}（点击 label 等同于点击其控件）`,
  `- 角色不同：${sum((r) => r.roleDiff.length)}`,
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
console.log(lines.slice(0, 10).join('\n'));
console.log(`报告：bench/out/bw14-report.md`);
