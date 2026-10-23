// BW-1 + C-3：Lab 大表分页采集 50 页 1000 条，主键为详情链接，结束导出 CSV；再跑一次“第 23 页被杀后续采”。
// 判据都以 Lab 服务端（/api/rows 全量数据）为准：条数、零重复、逐行一致、CSV 带 BOM；
// 崩溃那次的 data.jsonl 与不崩溃那次逐行完全相同。
// 工作流按页循环（每页 navigate_page 到 ?page=N 再 extract）：循环条目是续跑的重做单位，导航是幂等的。
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import bigtable from '../../../../lab/src/modules/bigtable.ts';
import { CHROME, control, loginCookie, SKIP } from '../../../../lab/test/helpers.ts';
import { sweepBrowser } from '../../src/executor.ts';
import { RunStore } from '../../src/store.ts';
import { type SupervisorEvent, superviseRun } from '../../src/supervisor.ts';
import { LOGIN, labRows, lines, makeWorkspace, outputFile, runFlow } from './collect-helpers.ts';

const CHILD = fileURLToPath(new URL('./collect-child.ts', import.meta.url));
const NAME = 'collect-books';
const ROWS = 1000;
const PAGES = ROWS / 20;
const KILL_PAGE = 23;
const SPACE = 'e2e-collect';
const BOM = String.fromCharCode(0xfeff);
/** 页面上的列（表头文字）与详情链接；主键是 link。 */
const FIELDS = {
  link: 'a[href*="/table/item/"]@href',
  id: '编号',
  name: '名称',
  category: '分类',
  price: '价格',
  updated: '更新日期',
};
const STEPS = [
  ...LOGIN,
  {
    step_id: 'pages',
    op: 'loop_begin',
    over: Array.from({ length: PAGES }, (_, i) => i + 1),
    as: 'p',
  },
  {
    step_id: 'go',
    op: 'navigate_page',
    pageId: 'main',
    url: '{{var:base}}/table/paged?page={{var:p}}',
    post: [{ text_present: `第 {{var:p}} / ${PAGES} 页` }],
  },
  {
    step_id: 'rows',
    op: 'extract',
    pageId: 'main',
    into: 'items',
    source: { type: 'dom', kind: 'table', root: { css: '#rows' }, fields: FIELDS },
  },
  { step_id: 'next', op: 'loop_end' },
];

describe('BW-1、C-3 分页全量采集与中途被杀续采', { skip: SKIP }, () => {
  let lab: Lab;
  const dirs: string[] = [];
  before(async () => {
    lab = await createLab({ modules: [auth, bigtable] });
  });
  after(async () => {
    await lab?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const workspace = () => {
    const ws = makeWorkspace(NAME, { outputs: { items: { key: 'link', export: ['csv'] } } }, STEPS);
    dirs.push(ws);
    return ws;
  };

  const title =
    '50 页 1000 条、零重复、与服务端逐行一致、CSV 带 BOM；第 23 页被杀后续采结果完全相同';
  test(title, { timeout: 300_000 }, async (t) => {
    const c = control(lab, SPACE);
    await c.reset({ rows: ROWS });
    const base = lab.url(SPACE);
    const truth = (await labRows(base, await loginCookie(lab, SPACE))).map((r) => ({
      link: `${base}/table/item/${r.id}`,
      id: r.id,
      name: r.name,
      category: r.category,
      price: String(r.price),
      updated: r.updated,
    }));
    assert.equal(truth.length, ROWS);

    // 一、不崩溃的完整运行
    const wsA = workspace();
    const a = await runFlow({
      workspace: wsA,
      runId: 'a',
      name: NAME,
      vars: { base },
      chromePath: CHROME,
    });
    assert.equal(a.state, 'DONE', JSON.stringify(a.error));
    const dataA = lines(outputFile(wsA, 'a', NAME, 'items'));
    assert.equal(dataA.length, ROWS, '1000 条');
    const rowsA = dataA.map((l) => JSON.parse(l) as Record<string, string>);
    assert.equal(new Set(rowsA.map((r) => r.link)).size, ROWS, '主键（详情链接）零重复');
    assert.deepEqual(rowsA, truth, '与服务端 /api/rows 逐行一致');

    // CSV：UTF-8 BOM、表头 + 1000 行，内容与服务端一致
    const csv = readFileSync(outputFile(wsA, 'a', NAME, 'items', 'csv'), 'utf8');
    assert.equal(csv.charAt(0), BOM, 'CSV 以 UTF-8 BOM 开头');
    const csvLines = csv.split('\r\n').filter(Boolean);
    assert.equal(csvLines.length, ROWS + 1, '表头 + 1000 行');
    assert.equal(csvLines[0], BOM + Object.keys(FIELDS).join(','));
    assert.deepEqual(
      csvLines.slice(1),
      truth.map((r) => Object.values(r).join(',')),
    );

    // 二、同一工作流，第 23 页采完（数据已写入、检查点还没前进）时进程被 SIGKILL，监督进程拉起并续跑
    const wsB = workspace();
    const events: SupervisorEvent[] = [];
    let writtenAtKill: number | undefined;
    const sup = await superviseRun({
      command: [process.execPath, CHILD, wsB, 'b', NAME],
      env: {
        CHROME_PATH: CHROME,
        OBACT_E2E_VARS: JSON.stringify({ base }),
        OBACT_E2E_KILL: `rows:${KILL_PAGE}`,
      },
      heartbeatFile: join(wsB, 'runs', 'b', 'heartbeat'),
      heartbeatTimeoutMs: 20_000,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'exit') {
          sweepBrowser(wsB, 'b'); // 与命令行一致：子进程被杀后清扫它的浏览器
          writtenAtKill ??= lines(outputFile(wsB, 'b', NAME, 'items')).length; // 只记第一次退出（被杀）时
        }
      },
    });
    assert.deepEqual(sup, { state: 'DONE', restarts: 1 });
    const killed = events.find((e) => e.type === 'exit');
    assert.ok(killed?.type === 'exit' && killed.signal === 'SIGKILL', '第一次启动被 SIGKILL 杀死');
    assert.equal(
      writtenAtKill,
      KILL_PAGE * 20,
      '被杀时前 23 页已写入，续跑要重做第 23 页并靠主键去重',
    );
    const store = new RunStore(wsB, 'b');
    assert.equal(store.readCheckpoint()?.state, 'DONE');
    // 第 23 页被重做一次，前 22 页没有重做：第一次启动 23 页 + 续跑后第 23~50 页
    const redone = readFileSync(store.stepsLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.split('\t')[1] === 'rows' && l.split('\t')[3] === 'ok').length;
    assert.equal(redone, KILL_PAGE + (PAGES - KILL_PAGE + 1));

    const dataB = lines(outputFile(wsB, 'b', NAME, 'items'));
    assert.deepEqual(dataB, dataA, '续采后 data.jsonl 与不崩溃那次逐行完全相同（零重复、零遗漏）');
    assert.equal(
      readFileSync(outputFile(wsB, 'b', NAME, 'items', 'csv'), 'utf8'),
      csv,
      '续采后导出的 CSV 也相同',
    );
    t.diagnostic(`重启 ${sup.restarts} 次`);
  });
});
