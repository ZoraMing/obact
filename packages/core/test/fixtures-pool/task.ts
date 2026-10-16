// 浏览器池测试用的任务子进程：用 connectBrowser 连上池里的浏览器，按命令干活，结果以 JSON 行写到 stdout。
// 用法：node task.ts <wsEndpoint> <命令> <页面根地址> <令牌>
//   login    新开标签页，observe 后用 act 填令牌并点“保存登录态”，输出 ready 后停住，等父进程 SIGKILL
//   inspect  Session.attach 接管已有标签页，读出页面状态，再用 act 改一次令牌，输出后断开退出
import { act, connectBrowser, observe, Session } from '../../src/index.ts';

const [ws, cmd, base, token] = process.argv.slice(2) as [string, string, string, string];
const out = (data: unknown) => console.log(JSON.stringify(data));

const browser = await connectBrowser(ws);
const session = await Session.attach(browser);

/** observe 出输入框和保存按钮，用 act 按编号填写并点击。 */
async function saveLogin(pageId: string, value: string) {
  const ob = await observe(session, { pageId });
  const input = ob.elements.find((e) => e.name === '令牌');
  const button = ob.elements.find((e) => e.name === '保存登录态');
  if (!input || !button) throw new Error(`没有找到输入框或按钮：${ob.snapshot_text}`);
  const fill = await act(session, { op: 'fill', pageId, target: { ref: input.ref }, value });
  const click = await act(session, { op: 'click', pageId, target: { ref: button.ref } });
  const wait = await act(session, {
    op: 'wait_for',
    pageId,
    until: [{ text_present: `已保存：${value}` }],
    timeout_ms: 5000,
  });
  return {
    elements: ob.elements.length,
    fill: fill.status,
    click: click.status,
    wait: wait.status,
  };
}

if (cmd === 'login') {
  const pageId = await session.pages.newPage({ url: `${base}/login.html` });
  out({ ready: true, pageId, ...(await saveLogin(pageId, token)) });
  await new Promise(() => {}); // 停住，等父进程杀掉本进程
} else if (cmd === 'inspect') {
  const found = session.pages.list().find((p) => p.url.includes('/login.html'));
  if (!found) {
    out({ found: false, urls: session.pages.list().map((p) => p.url) });
  } else {
    const page = session.pages.get(found.pageId);
    const read = () =>
      page.evaluate(() => ({
        cookie: document.cookie,
        token: localStorage.getItem('token'),
        marker: (window as unknown as { marker?: string }).marker ?? null,
        state: document.getElementById('state')?.textContent ?? null,
      }));
    const before = await read();
    // 接管之后 observe / act 照常可用
    const again = await saveLogin(found.pageId, `${token}-2`);
    out({
      found: true,
      pages: session.pages.list().length,
      before,
      again,
      after: await read(),
    });
  }
  await session.close();
} else {
  throw new Error(`未知命令：${cmd}`);
}
