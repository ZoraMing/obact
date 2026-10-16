// 预研：任务子进程。连接服务进程启动的浏览器，按命令执行一个场景，结果以 JSON 行输出到 stdout。
import puppeteer, { type Page } from 'puppeteer-core';
import {
  ATTR,
  axConsistency,
  findByAttr,
  isCrossOrigin,
  markClosedShadow,
  markFrames,
  resolveBound,
  snapshotRefs,
} from '../lib/refs.ts';

const [ws, cmd, base, xoPort] = process.argv.slice(2) as [string, string, string, string];
const out = (data: unknown) => console.log(JSON.stringify(data));

const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });

async function findPage(urlPart: string): Promise<Page | undefined> {
  for (const p of await browser.pages()) if (p.url().includes(urlPart)) return p;
  return undefined;
}

async function refs() {
  const page = await browser.newPage();
  await page.goto(`${base}/refs.html?xo=${xoPort}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>('#cross');
    return f?.src;
  });
  await new Promise((r) => setTimeout(r, 300)); // 预研：等跨域 iframe 加载
  const cdp = await page.createCDPSession();

  const t0 = performance.now();
  const js = await markFrames(page, 1);
  const closed = await markClosedShadow(cdp, js.next);
  const snap = await snapshotRefs(cdp);
  const ax = await axConsistency(cdp, snap.nodeToRef);
  const t1 = performance.now();

  // 跨域 iframe（OOPIF）的可访问性树要在它自己的会话里取
  const oopif = page.frames().find((f) => isCrossOrigin(page, f));
  let oopifAx: unknown = null;
  if (oopif) {
    const target = browser.targets().find((t) => t.url() === oopif.url() && t.type() !== 'page');
    if (target) {
      const s = await target.createCDPSession();
      const snapO = await snapshotRefs(s);
      oopifAx = { targetType: target.type(), ...(await axConsistency(s, snapO.nodeToRef)) };
    } else {
      oopifAx = { error: '找不到 OOPIF 的 target', types: browser.targets().map((t) => t.type()) };
    }
  }

  // 编号绑定具体节点：两种重绘方式下，按属性查找与按 backendNodeId 查找的结果
  const listRef = 6; // 第一个“审核 88231”按钮的编号（按文档顺序）
  const main = page.mainFrame();
  const before = { byAttr: await findByAttr(main, listRef) };
  const backend = snap.refToNode.get(listRef) as number;
  await page.click('#rerender-clone');
  const afterClone = {
    byAttr: await findByAttr(main, listRef),
    byNode: await resolveBound(cdp, backend),
  };
  const snap2 = await snapshotRefs(cdp);
  const backend2 = snap2.refToNode.get(listRef) as number;
  await page.click('#rerender-fresh');
  const afterFresh = {
    byAttr: await findByAttr(main, listRef),
    byNode: await resolveBound(cdp, backend2),
  };

  out({
    scene: 'refs',
    frames: js.frames,
    closedShadowMarked: closed.marked.length,
    totalRefs: closed.next - 1,
    snapshotDocs: snap.documents,
    snapshotRefs: snap.refToNode.size,
    ax,
    oopifAx,
    ms: Math.round(t1 - t0),
    stale: { listRef, before, afterClone, afterFresh },
  });
  await page.close();
}

async function big(rows: number) {
  const page = await browser.newPage();
  await page.goto(`${base}/big.html?rows=${rows}`, { waitUntil: 'load' });
  const cdp = await page.createCDPSession();
  const t = performance.now();
  const js = await markFrames(page, 1);
  const tMark = performance.now();
  const snap = await snapshotRefs(cdp);
  const tSnap = performance.now();
  const ax = await axConsistency(cdp, snap.nodeToRef);
  const tAx = performance.now();
  // 只取视口内元素的可访问性信息：逐个 getPartialAXTree
  const visible = await page.evaluate((attr) => {
    const refs: number[] = [];
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        refs.push(Number(el.getAttribute(attr)));
      }
    }
    return refs;
  }, ATTR);
  const tVis = performance.now();
  for (const ref of visible) {
    await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId: snap.refToNode.get(ref) as number,
      fetchRelatives: false,
    });
  }
  const tPartial = performance.now();
  out({
    scene: 'big',
    visible: visible.length,
    visibleScanMs: Math.round(tVis - tAx),
    partialAxMs: Math.round(tPartial - tVis),
    rows,
    refs: js.next - 1,
    markMs: Math.round(tMark - t),
    snapshotMs: Math.round(tSnap - tMark),
    axMs: Math.round(tAx - tSnap),
    axMissing: ax.missing.length,
  });
  await page.close();
}

/** 写入登录态后停住，等服务进程把本进程杀掉。 */
async function hold() {
  const page = await browser.newPage();
  await page.goto(`${base}/session.html`);
  await page.evaluate(() => {
    localStorage.setItem('token', 'abc');
    // biome-ignore lint/suspicious/noDocumentCookie: 预研要验证持久 Cookie 在浏览器重启后保留
    document.cookie = 'sid=xyz; max-age=86400; path=/';
    const state = document.getElementById('state');
    if (state) state.textContent = 'step-37';
  });
  out({ scene: 'hold', ready: true });
  await new Promise(() => {});
}

/** 新的任务进程接管已有标签页，读取上一个进程留下的页面状态。 */
async function reattach() {
  const page = await findPage('/session.html');
  if (!page) return out({ scene: 'reattach', found: false });
  const state = await page.evaluate(() => ({
    text: document.getElementById('state')?.textContent,
    token: localStorage.getItem('token'),
    cookie: document.cookie,
  }));
  out({ scene: 'reattach', found: true, pages: (await browser.pages()).length, state });
}

/** 浏览器重启后，用同一配置目录检查登录态是否保留。 */
async function cookie() {
  const page = await browser.newPage();
  await page.goto(`${base}/session.html`);
  const state = await page.evaluate(() => ({
    token: localStorage.getItem('token'),
    cookie: document.cookie,
  }));
  out({ scene: 'cookie', state });
  await page.close();
}

if (cmd === 'refs') await refs();
else if (cmd === 'big') await big(Number(process.env.ROWS ?? 5000));
else if (cmd === 'hold') await hold();
else if (cmd === 'reattach') await reattach();
else if (cmd === 'cookie') await cookie();
await browser.disconnect();
