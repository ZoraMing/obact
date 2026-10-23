// 采集输出（FR-25）：主键去重与续采、CSV / xlsx 导出。
// CSV 和 xlsx 用 python3 标准库（csv、zipfile、xml）独立读回对账；不需要浏览器。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ObactError } from '@obact/core';
import { Output } from '../src/output.ts';
import { batch, ROWS_PER_BATCH } from './fixtures-output/append-writer.ts';

const WRITER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-output', 'append-writer.ts');
const TASK = '订单采集';
const DATE = '2026-10-19';

const tmpDirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'obact-output-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}
function rowsOf(out: Output, name: string): Record<string, unknown>[] {
  return lines(out.file(name, 'jsonl')).map((l) => JSON.parse(l));
}

const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;
const SKIP_PY = HAS_PYTHON ? false : '没有 python3，无法独立读回导出文件';
function python(script: string, file: string): unknown {
  const r = spawnSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `python3 失败：${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('主键去重：已写入的、批内重复的行跳过并计数；数字与字符串主键等价；没有 key 时全部写入', () => {
  const out = new Output(workspace(), TASK, DATE);
  assert.deepEqual(
    out.append(
      'orders',
      [
        { id: 'A1', v: 1 },
        { id: 'A2', v: 2 },
        { id: 'A1', v: 9 },
      ],
      { key: 'id' },
    ),
    { written: 2, skipped: 1 },
  );
  assert.deepEqual(
    out.append(
      'orders',
      [
        { id: 'A2', v: 8 },
        { id: 'A3', v: 3 },
      ],
      { key: 'id' },
    ),
    {
      written: 1,
      skipped: 1,
    },
  );
  assert.deepEqual(out.append('orders', [{ id: 7 }, { id: '7' }], { key: 'id' }), {
    written: 1,
    skipped: 1,
  });
  // 重复行保留第一次写入的内容；每行一条完整 JSON
  assert.deepEqual(rowsOf(out, 'orders'), [
    { id: 'A1', v: 1 },
    { id: 'A2', v: 2 },
    { id: 'A3', v: 3 },
    { id: 7 },
  ]);
  assert.equal(out.count('orders'), 4);
  assert.equal(lines(out.file('orders', 'index')).length, 4);

  // 复合主键：字段值里带分隔符也不会撞
  const key = ['a', 'b'];
  assert.deepEqual(
    out.append(
      'pairs',
      [
        { a: 'x|y', b: 'z' },
        { a: 'x', b: 'y|z' },
        { a: 'x|y', b: 'z' },
      ],
      { key },
    ),
    { written: 2, skipped: 1 },
  );

  // 没有 key：全部写入，不建索引
  assert.deepEqual(out.append('plain', [{ n: 1 }, { n: 1 }]), { written: 2, skipped: 0 });
  assert.equal(out.count('plain'), 2);
  assert.equal(existsSync(out.file('plain', 'index')), false);
});

test('主键字段缺失：整批不写入并报 invalid_params；任务名 / 输出名不能越出目录', () => {
  const ws = workspace();
  const out = new Output(ws, TASK, DATE);
  out.append('orders', [{ id: 'A1' }], { key: 'id' });
  assert.throws(
    () => out.append('orders', [{ id: 'A2' }, { name: '没有主键' }], { key: 'id' }),
    (e) => e instanceof ObactError && e.code === 'invalid_params',
  );
  assert.deepEqual(rowsOf(out, 'orders'), [{ id: 'A1' }], 'A2 也不应被写入');
  assert.equal(lines(out.file('orders', 'index')).length, 1);

  for (const bad of ['../evil', 'a/b', '..', '']) {
    assert.throws(
      () => new Output(ws, bad, DATE),
      (e) => e instanceof ObactError && e.code === 'invalid_params',
    );
    assert.throws(
      () => out.file(bad, 'jsonl'),
      (e) => e instanceof ObactError && e.code === 'invalid_params',
    );
  }
});

test('续采：重新打开后按持久化的索引去重，只写新行', () => {
  const ws = workspace();
  const first = new Output(ws, TASK, DATE);
  first.append('orders', [{ id: 'A1' }, { id: 'A2' }], { key: 'id' });

  const reopened = new Output(ws, TASK, DATE);
  assert.deepEqual(
    reopened.append('orders', [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }], { key: 'id' }),
    {
      written: 1,
      skipped: 2,
    },
  );
  assert.deepEqual(
    rowsOf(reopened, 'orders').map((r) => r.id),
    ['A1', 'A2', 'A3'],
  );
});

test('崩溃留下的状态：数据已写、索引未写，末尾还有写了一半的行；续采补全且不重复', () => {
  const ws = workspace();
  const first = new Output(ws, TASK, DATE);
  first.append('orders', [{ id: 'A1' }, { id: 'A2' }], { key: 'id' });
  // 模拟在“写数据”与“写索引”之间被杀：A3 完整地进了数据文件但没进索引；A4 只写了一半
  appendFileSync(first.file('orders', 'jsonl'), '{"id":"A3"}\n{"id":"A4","na');
  // 索引末尾同样可能留下半行
  appendFileSync(first.file('orders', 'index'), '"A');

  const resumed = new Output(ws, TASK, DATE);
  assert.deepEqual(
    resumed.append('orders', [{ id: 'A3' }, { id: 'A4' }, { id: 'A5' }], { key: 'id' }),
    {
      written: 2,
      skipped: 1,
    },
  );
  assert.deepEqual(
    rowsOf(resumed, 'orders').map((r) => r.id),
    ['A1', 'A2', 'A3', 'A4', 'A5'],
  );
  assert.deepEqual(
    lines(resumed.file('orders', 'index')).map((l) => JSON.parse(l)),
    ['A1', 'A2', 'A3', 'A4', 'A5'],
  );
});

test('没有 key 的输出：上次写了一半的行会被清掉，新行不会接在残片后面', () => {
  const ws = workspace();
  const first = new Output(ws, TASK, DATE);
  first.append('raw', [{ n: 1 }]);
  appendFileSync(first.file('raw', 'jsonl'), '{"n":2,"x');

  const resumed = new Output(ws, TASK, DATE);
  resumed.append('raw', [{ n: 3 }]);
  assert.deepEqual(rowsOf(resumed, 'raw'), [{ n: 1 }, { n: 3 }]);
});

test('C-3：采集进程被 SIGKILL 多次，续采后不重复、不遗漏', async () => {
  const ws = workspace();
  const children: ReturnType<typeof spawn>[] = [];
  after(() => {
    for (const c of children) c.kill('SIGKILL');
  });

  // 每一轮：启动采集子进程（从头重采，已写的批次被去重跳过），等它写进至少 3 批新数据后 SIGKILL
  let lastBatch = 0;
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, [WRITER, ws, TASK, DATE], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    let out = '';
    let fresh = 0;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('采集子进程提前退出')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
        const complete = out.split('\n').slice(0, -1);
        fresh = complete.filter((l) => l.split(' ')[1] !== '0').length;
        const last = complete.at(-1);
        if (last) lastBatch = Math.max(lastBatch, Number(last.split(' ')[0]));
        if (fresh >= 3) resolve();
      });
    });
    child.removeAllListeners('exit');
    // 每一轮错开杀进程的时机，覆盖写数据、写索引、写到一半等不同阶段（断言与时机无关）
    await new Promise((r) => setTimeout(r, round * 8));
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  // 补采：把所有批次（含被打断的那一批）再写一遍
  const out = new Output(ws, TASK, DATE);
  const total = lastBatch + 3;
  for (let b = 0; b < total; b++) out.append('orders', batch(b), { key: 'id' });

  const ids = rowsOf(out, 'orders').map((r) => r.id as number); // 每行都能解析：没有残留的半行
  assert.equal(ids.length, total * ROWS_PER_BATCH);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    Array.from({ length: ids.length }, (_, i) => i),
  );
  assert.equal(lines(out.file('orders', 'index')).length, ids.length);
});

const CSV_ROWS = [
  { id: 'A1', name: '张三', note: '含,逗号' },
  { id: 'A2', name: 'He said "hi"', note: '第一行\n第二行', tags: ['a', 'b'], meta: { x: 1 } },
  { id: 'A3', name: null, n: 3.5, ok: true },
];

test('CSV 导出：UTF-8 BOM、RFC 4180 转义、表头为字段并集、对象与数组写 JSON', {
  skip: SKIP_PY,
}, () => {
  const out = new Output(workspace(), TASK, DATE);
  out.append('orders', CSV_ROWS, { key: 'id' });
  const res = out.export('orders', ['csv']);
  assert.equal(res.rows, 3);
  const file = res.files.csv as string;
  assert.equal(file, out.file('orders', 'csv'));
  assert.deepEqual([...readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const parsed = python(
    'import csv, json, sys\n' +
      "with open(sys.argv[1], encoding='utf-8-sig', newline='') as f:\n" +
      '    print(json.dumps(list(csv.reader(f)), ensure_ascii=False))\n',
    file,
  );
  assert.deepEqual(parsed, [
    ['id', 'name', 'note', 'tags', 'meta', 'n', 'ok'],
    ['A1', '张三', '含,逗号', '', '', '', ''],
    ['A2', 'He said "hi"', '第一行\n第二行', '["a","b"]', '{"x":1}', '', ''],
    ['A3', '', '', '', '', '3.5', 'true'],
  ]);
});

/** 读回 xlsx：校验 ZIP（CRC、store）、包结构和关系引用，再把 sheet1.xml 解析成 单元格 → [类型, 值]。 */
const READ_XLSX = `
import json, sys, zipfile
import xml.etree.ElementTree as ET
M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/package/2006/relationships}'
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names = z.namelist()
for n in names:
    ET.fromstring(z.read(n))  # 每个部件都是合法 XML
rel = ET.fromstring(z.read('_rels/.rels')).find(R + 'Relationship')
assert rel.get('Target') in names
wb_rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels')).find(R + 'Relationship')
assert 'xl/' + wb_rels.get('Target') in names
ct = z.read('[Content_Types].xml').decode()
assert '/xl/workbook.xml' in ct and '/xl/worksheets/sheet1.xml' in ct
sheets = ET.fromstring(z.read('xl/workbook.xml')).find(M + 'sheets')
root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
cells = {}
for row in root.iter(M + 'row'):
    for c in row:
        t = c.get('t', 'n')
        if t == 'inlineStr':
            v = ''.join(x.text or '' for x in c.iter(M + 't'))
        elif t == 'n':
            v = float(c.find(M + 'v').text)
        else:
            v = c.find(M + 'v').text
        cells[c.get('r')] = [t, v]
print(json.dumps({
    'names': sorted(names),
    'methods': sorted({i.compress_type for i in z.infolist()}),
    'sheet': sheets[0].get('name'),
    'cells': cells,
}, ensure_ascii=False))
`;

test('xlsx 导出：标准库 zipfile 读回，单元格类型与值逐个对上；非法字符不会破坏文件', {
  skip: SKIP_PY,
}, () => {
  const out = new Output(workspace(), TASK, DATE);
  out.append(
    'orders',
    [
      { id: 'A1', name: '张三', qty: 7, price: 3.5, paid: true, ref: '00123' },
      { id: 'A2', name: '<b>&"x"</b>', tags: ['a', 'b'], meta: { x: 1 }, note: '  首尾空格  ' },
      // 回车换行、XML 不允许的控制字符、看起来像转义序列的文本、超过 Excel 15 位精度的数字
      { id: 'A3', name: 'a\r\nb', note: 'x\u000by_x0041_z', big: 1e15, empty: null },
    ],
    { key: 'id' },
  );
  const res = out.export('orders', ['xlsx']);
  assert.equal(res.rows, 3);
  assert.deepEqual(res.warnings, []);

  const got = python(READ_XLSX, res.files.xlsx as string) as {
    names: string[];
    methods: number[];
    sheet: string;
    cells: Record<string, [string, string | number]>;
  };
  assert.deepEqual(got.names, [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ]);
  assert.deepEqual(got.methods, [0], '全部是 store 方式');
  assert.equal(got.sheet, 'orders');

  const s = (v: string): [string, string] => ['inlineStr', v];
  assert.deepEqual(got.cells, {
    // 表头：字段并集，按首次出现顺序
    A1: s('id'),
    B1: s('name'),
    C1: s('qty'),
    D1: s('price'),
    E1: s('paid'),
    F1: s('ref'),
    G1: s('tags'),
    H1: s('meta'),
    I1: s('note'),
    J1: s('big'),
    K1: s('empty'),
    // 第 1 行数据：数字用 n、布尔用 b，文本编号保持文本
    A2: s('A1'),
    B2: s('张三'),
    C2: ['n', 7],
    D2: ['n', 3.5],
    E2: ['b', '1'],
    F2: s('00123'),
    // 第 2 行：XML 特殊字符、对象 / 数组写 JSON、首尾空格保留
    A3: s('A2'),
    B3: s('<b>&"x"</b>'),
    G3: s('["a","b"]'),
    H3: s('{"x":1}'),
    I3: s('  首尾空格  '),
    // 第 3 行：回车换行原样、控制字符与文本中的 _xHHHH_ 按 OOXML 转义、大数存文本、null 不写
    A4: s('A3'),
    B4: s('a\r\nb'),
    I4: s('x_x000B_y_x005F_x0041_z'),
    J4: s('1000000000000000'),
  });
});

test('xlsx 超过单表行数上限（含表头）时报错并且不留下文件', () => {
  const out = new Output(workspace(), TASK, DATE);
  // 恰好 1,048,576 条数据 + 1 行表头 = 1,048,577 行，超出 Excel 的 1,048,576 行
  mkdirSync(out.dir, { recursive: true });
  writeFileSync(out.file('big', 'jsonl'), '{"a":1}\n'.repeat(1_048_576));
  assert.throws(
    () => out.export('big', ['xlsx']),
    (e) => e instanceof ObactError && e.code === 'invalid_params' && /1048576/.test(e.message),
  );
  assert.deepEqual(readdirSync(out.dir), ['big.jsonl']);
});
