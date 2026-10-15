// MiniWoB++ 跑通（M1 出口）：只用 Obact 的 observe 与 act 完成一组原子任务，读取页面自带的奖励。
// 用法：node bench/miniwob.ts [--episodes N]
// 解题逻辑只读 observe 返回的可操作功能（角色、名称、可用操作、input_type），执行全部走 act。
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, ActResult, ObservedElement } from '@obact/schemas';
import { act, launchBrowser, observe, Session } from '../packages/core/src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINIWOB = process.env.MINIWOB_HTML ?? join(ROOT, 'spikes/.cache/miniwob-pkg/miniwob/html');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const epArg = process.argv.indexOf('--episodes');
const EPISODES = epArg > 0 ? Number(process.argv[epArg + 1]) : 5;

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = normalize(join(MINIWOB, decodeURIComponent(path)));
  if (!file.startsWith(MINIWOB)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
    }[extname(file)];
    res.writeHead(200, { 'content-type': type ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await launchBrowser({
  profileDir: mkdtempSync(join(tmpdir(), 'obact-miniwob-')),
  chromePath: CHROME,
  mode: 'headless',
  windowSize: { width: 800, height: 600 },
});
const s = await Session.attach(browser);
const pageId = await s.pages.newPage({ pageId: 'wob' });

async function run(a: Action): Promise<ActResult> {
  const r = await act(s, a);
  if (r.status !== 'ok') throw new Error(`${a.op} 失败：${r.error?.code} ${r.error?.message}`);
  return r;
}
const click = (ref: number) => run({ op: 'click', pageId, target: { ref } });
const fill = (ref: number, value: string) => run({ op: 'fill', pageId, target: { ref }, value });
const quoted = (u: string) => /"([^"]+)"/.exec(u)?.[1] ?? '';

/** 按名称找带指定可用操作的元素。 */
function find(
  els: ObservedElement[],
  pred: (e: ObservedElement) => boolean,
  action: ObservedElement['actions'][number] = 'click',
) {
  const e = els.find((x) => pred(x) && x.actions.includes(action) && x.visible_ratio > 0);
  if (!e) throw new Error('找不到目标元素');
  return e;
}
const submit = (els: ObservedElement[]) => click(find(els, (e) => /^submit$/i.test(e.name)).ref);

const SOLVERS: Record<string, (u: string, els: ObservedElement[]) => Promise<unknown>> = {
  'click-button': (u, els) =>
    click(find(els, (e) => e.role === 'button' && e.name === quoted(u)).ref),
  'click-link': (u, els) => click(find(els, (e) => e.name === quoted(u)).ref),
  'click-dialog': (_u, els) =>
    click(find(els, (e) => e.role === 'button' && /^(close|×|x)$/i.test(e.name)).ref),
  'click-tab': (u, els) => click(find(els, (e) => e.name === /Tab #\d+/.exec(u)?.[0]).ref),
  'focus-text': (_u, els) => click(find(els, (e) => e.role === 'textbox').ref),
  'enter-text': async (u, els) => {
    await fill(find(els, (e) => e.role === 'textbox', 'fill').ref, quoted(u));
    await submit(els);
  },
  'enter-password': async (u, els) => {
    for (const e of els.filter((x) => x.input_type === 'password')) await fill(e.ref, quoted(u));
    await submit(els);
  },
  'login-user': async (u, els) => {
    const [user, pass] = [...u.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    await fill(
      find(els, (e) => e.role === 'textbox' && e.input_type !== 'password', 'fill').ref,
      user ?? '',
    );
    await fill(find(els, (e) => e.input_type === 'password', 'fill').ref, pass ?? '');
    await click(find(els, (e) => /login/i.test(e.name)).ref);
  },
  'click-checkboxes': async (u, els) => {
    const want = (/^Select (.*) and click Submit\.$/.exec(u)?.[1] ?? '').split(', ');
    for (const e of els) if (e.role === 'checkbox' && want.includes(e.name)) await click(e.ref);
    await submit(els);
  },
  'click-option': async (u, els) => {
    const want = /^Select (.*) and click Submit\.$/.exec(u)?.[1] ?? '';
    await click(find(els, (e) => e.role === 'radio' && e.name === want).ref);
    await submit(els);
  },
};

type Row = { task: string; ok: number; episodes: number; errors: string[] };
const rows: Row[] = [];
for (const [task, solve] of Object.entries(SOLVERS)) {
  const row: Row = { task, ok: 0, episodes: EPISODES, errors: [] };
  for (let seed = 0; seed < EPISODES; seed++) {
    try {
      await run({ op: 'navigate_page', pageId, url: `${base}/miniwob/${task}.html` });
      await run({
        op: 'evaluate_script',
        pageId,
        function: '(n) => Math.seedrandom(n)',
        args: [seed],
      });
      await run({ op: 'click', pageId, target: { css: '#sync-task-cover' } });
      const ob = await observe(s, { pageId });
      const u = (
        await run({ op: 'evaluate_script', pageId, function: '() => core.getUtterance()' })
      ).data as string;
      await solve(u, ob.elements);
      const reward = (
        await run({ op: 'evaluate_script', pageId, function: '() => WOB_RAW_REWARD_GLOBAL' })
      ).data as number;
      if (reward === 1) row.ok++;
      else row.errors.push(`seed ${seed}: reward ${reward}`);
    } catch (e) {
      row.errors.push(`seed ${seed}: ${(e as Error).message}`);
    }
  }
  rows.push(row);
  console.log(
    `${task.padEnd(18)} ${row.ok}/${row.episodes}${row.errors.length ? `  ${row.errors[0]}` : ''}`,
  );
}
const total = rows.reduce((n, r) => n + r.ok, 0);
console.log(`合计 ${total}/${rows.length * EPISODES}`);
await s.close({ closeBrowser: true });
server.close();
process.exit(total === rows.length * EPISODES ? 0 : 1);
