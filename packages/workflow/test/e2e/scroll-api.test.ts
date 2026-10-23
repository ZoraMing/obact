// BW-2 + BW-10：同一份数据分别用“页面滚动抽取”和“接口截获”采集，条数与内容一致；各不超过 3 分钟。
// BW-2：Lab 无限滚动列表 100 行；BW-10：Lab 虚拟滚动大表（默认 2000 行，OBACT_E2E_ROWS 可调到 1 万手动跑）。
// 判据以 Lab 服务端（/api/rows 全量数据）为准。
// 接口截获一次只能读到“上一个动作之后到达的最近一条”响应，所以工作流逐块滚动：滚到下一块 → 等该块的第一行渲染出来
// （确认页面已拿到数据）→ extract 按 offset 精确匹配那一块的响应。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import bigtable from '../../../../lab/src/modules/bigtable.ts';
import { CHROME, control, loginCookie, SKIP } from '../../../../lab/test/helpers.ts';
import { LOGIN, labRows, lines, makeWorkspace, outputFile, runFlow } from './collect-helpers.ts';

const ROWS = Number(process.env.OBACT_E2E_ROWS) || 2000;
/** 每种方式的时间上限：工作流每步之前检查，超时即失败。 */
const LIMIT_MS = 180_000;
const COLS = ['id', 'name', 'category', 'price', 'updated'];

type Case = {
  title: string;
  /** Lab 数据空间名。 */
  space: string;
  rows: number;
  path: string;
  /** 滚动容器。 */
  root: string;
  /** 接口每块的行数（页面每次请求的 limit）。 */
  chunk: number;
  /** 每次滚动的距离：无限滚动取大于一块高度的值（滚到底触发加载）；虚拟滚动恰好一块（行高 32 × 100 行）。 */
  dy: number;
};
const CASES: Case[] = [
  {
    title: 'BW-2 无限滚动 100 行',
    space: 'e2e-bw2',
    rows: 100,
    path: '/table/scroll',
    root: '#list',
    chunk: 10,
    dy: 1000,
  },
  {
    title: `BW-10 虚拟滚动 ${ROWS} 行`,
    space: 'e2e-bw10',
    rows: ROWS,
    path: '/table/virtual',
    root: '#viewport',
    chunk: 100,
    dy: 3200,
  },
];

const open = (c: Case) => ({
  step_id: 'table',
  op: 'navigate_page',
  pageId: 'main',
  url: `{{var:base}}${c.path}`,
  post: [{ element_present: { css: `${c.root} .row` } }],
});

/** 页面滚动抽取：一个 extract 步骤，滚动到底，按 id 去重。 */
const byScroll = (c: Case) => [
  ...LOGIN,
  open(c),
  {
    step_id: 'collect',
    op: 'extract',
    pageId: 'main',
    into: 'rows',
    source: {
      type: 'dom',
      kind: 'list',
      root: { css: c.root },
      item: '.row',
      fields: Object.fromEntries(COLS.map((k) => [k, `.${k}`])),
      scroll: { container: { css: c.root }, max_rounds: 2 * c.rows },
    },
  },
];

/** 接口截获：页面加载时的第一块，再逐块滚动、逐块读取响应。 */
const byApi = (c: Case) => {
  const grab = (step_id: string, offset: string) => ({
    step_id,
    op: 'extract',
    pageId: 'main',
    into: 'rows',
    source: {
      type: 'response',
      url: `/api/rows\\?offset=${offset}&limit=${c.chunk}`,
      path: 'rows',
    },
  });
  const chunks = Array.from({ length: Math.ceil(c.rows / c.chunk) - 1 }, (_, i) => ({
    off: (i + 1) * c.chunk,
    first: `R${String((i + 1) * c.chunk + 1).padStart(5, '0')}`,
  }));
  return [
    ...LOGIN,
    open(c),
    grab('first', '0'),
    { step_id: 'chunks', op: 'loop_begin', over: chunks, as: 'k' },
    {
      step_id: 'scroll',
      op: 'scroll',
      pageId: 'main',
      target: { css: c.root },
      dy: c.dy,
      post: [{ element_present: { css: '.row[data-id="{{var:k.first}}"]' } }],
    },
    grab('more', '{{var:k.off}}'),
    { step_id: 'end', op: 'loop_end' },
  ];
};

describe('BW-2、BW-10 页面滚动与接口截获', { skip: SKIP }, () => {
  let lab: Lab;
  const dirs: string[] = [];
  before(async () => {
    lab = await createLab({ modules: [auth, bigtable] });
  });
  after(async () => {
    await lab?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** 跑一种采集方式，返回采到的行（读采集输出）和耗时。 */
  async function collect(space: string, kind: string, steps: object[], intercept?: string[]) {
    const name = `${space}-${kind}`;
    const ws = makeWorkspace(name, { outputs: { rows: { key: 'id' } }, intercept }, steps);
    dirs.push(ws);
    const t0 = Date.now();
    const r = await runFlow({
      workspace: ws,
      runId: name,
      name,
      vars: { base: lab.url(space) },
      chromePath: CHROME,
      hooks: {
        beforeStep: () => {
          if (Date.now() - t0 > LIMIT_MS) throw new Error(`${name} 超过 ${LIMIT_MS / 1000} 秒`);
        },
      },
    });
    const ms = Date.now() - t0;
    assert.equal(r.state, 'DONE', JSON.stringify(r.error));
    assert.ok(ms <= LIMIT_MS, `${name} 用时 ${ms} ms，超过 ${LIMIT_MS / 1000} 秒`);
    const rows = lines(outputFile(ws, name, name, 'rows')).map((l) => JSON.parse(l) as object);
    return { rows, ms };
  }

  /** 逐行比较（价格在页面上是文本、在接口里是数字，按字符串比）。 */
  const same = (got: object[], want: object[], label: string) => {
    const cells = (r: object) =>
      COLS.map((k) => String((r as Record<string, unknown>)[k])).join('|');
    assert.equal(got.length, want.length, `${label}：条数`);
    const i = got.findIndex((g, k) => cells(g) !== cells(want[k] as object));
    assert.equal(i, -1, `${label}：第 ${i + 1} 行不一致：${JSON.stringify(got[i])}`);
  };

  for (const c of CASES) {
    test(c.title, { timeout: 3 * LIMIT_MS }, async (t) => {
      const { space } = c;
      await control(lab, space).reset({ rows: c.rows });
      const truth = await labRows(lab.url(space), await loginCookie(lab, space));
      assert.equal(truth.length, c.rows);

      const scrolled = await collect(space, 'scroll', byScroll(c));
      same(scrolled.rows, truth, '页面滚动抽取与服务端');
      const api = await collect(space, 'api', byApi(c), ['/api/rows\\?offset=']);
      same(api.rows, truth, '接口截获与服务端');
      same(scrolled.rows, api.rows, '页面滚动抽取与接口截获');
      t.diagnostic(`页面滚动 ${scrolled.ms} ms，接口截获 ${api.ms} ms，共 ${truth.length} 条`);
    });
  }
});
