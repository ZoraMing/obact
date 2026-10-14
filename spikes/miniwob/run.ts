// 预研：本地托管 MiniWoB++ 页面，由 Node（Puppeteer）驱动并读取它自带的奖励，不需要它的 Python 环境。
// 准备：pip download --no-deps -d spikes/.cache/dl miniwob==1.1.0，解压到 spikes/.cache/miniwob-pkg
// 用法：node spikes/miniwob/run.ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { CHROME_PATH, EXTRA_ARGS, HEADLESS, log } from '../lib/chrome.ts';
import { ATTR, markFrames } from '../lib/refs.ts';
import { serveDir } from '../lib/static-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const HTML =
  process.env.MINIWOB_HTML ?? join(here, '..', '.cache', 'miniwob-pkg', 'miniwob', 'html');
const EPISODES = Number(process.env.EPISODES ?? 5);

type Reward = { done: boolean; reward: number; raw: number; reason: string | null };
type El = { ref: number; tag: string; text: string };

/** 观察：给可交互元素编号，返回 编号、标签、文本（相当于简化的 observe）。 */
async function observe(page: Page): Promise<El[]> {
  await markFrames(page, 1);
  return page.evaluate((attr) => {
    return [...document.querySelectorAll(`#wrap [${attr}]`)].map((el) => ({
      ref: Number(el.getAttribute(attr)),
      tag: el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText || el.closest('label')?.textContent || '').trim(),
    }));
  }, ATTR);
}

async function clickRef(page: Page, ref: number) {
  await page.click(`[${ATTR}="${ref}"]`); // 可信输入：CDP 派发的鼠标事件
}

const solvers: Record<string, (page: Page, utterance: string, els: El[]) => Promise<void>> = {
  'click-button': async (page, u, els) => {
    const want = /"(.+)"/.exec(u)?.[1];
    const el = els.find((e) => e.tag === 'button' && e.text === want);
    if (el) await clickRef(page, el.ref);
  },
  'enter-text': async (page, u, els) => {
    const want = /"(.+)"/.exec(u)?.[1] ?? '';
    const input = els.find((e) => e.tag === 'input');
    if (input) {
      await clickRef(page, input.ref);
      await page.keyboard.type(want);
    }
    const submit = els.find((e) => e.text === 'Submit');
    if (submit) await clickRef(page, submit.ref);
  },
  'click-checkboxes': async (page, u, els) => {
    const names = (/^Select (.*) and click Submit\.$/.exec(u)?.[1] ?? '')
      .split(', ')
      .filter((n) => n && n !== 'nothing');
    for (const e of els)
      if (e.tag === 'input' && names.includes(e.text)) await clickRef(page, e.ref);
    const submit = els.find((e) => e.text === 'Submit');
    if (submit) await clickRef(page, submit.ref);
  },
};

const { server, port } = await serveDir(HTML);
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: HEADLESS,
  args: EXTRA_ARGS,
  defaultViewport: { width: 500, height: 300 },
});
const page = await browser.newPage();

for (const [task, solve] of Object.entries(solvers)) {
  const rewards: number[] = [];
  for (let seed = 0; seed < EPISODES; seed++) {
    await page.goto(`http://127.0.0.1:${port}/miniwob/${task}.html`);
    await page.evaluate(
      (s) => (Math as unknown as { seedrandom: (s: number) => void }).seedrandom(s),
      seed,
    );
    await page.click('#sync-task-cover'); // 与人一样点 START 开始
    const utterance = await page.evaluate(() =>
      (window as unknown as { core: { getUtterance(): string } }).core.getUtterance(),
    );
    await solve(page, utterance, await observe(page));
    const r = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        done: w.WOB_DONE_GLOBAL,
        reward: w.WOB_REWARD_GLOBAL,
        raw: w.WOB_RAW_REWARD_GLOBAL,
        reason: w.WOB_REWARD_REASON,
      } as Reward;
    });
    rewards.push(r.raw);
    if (seed === 0) log(task, { utterance, ...r });
  }
  log(task, {
    episodes: EPISODES,
    rawRewards: rewards,
    success: rewards.filter((x) => x === 1).length,
  });
}

await browser.close();
server.close();
