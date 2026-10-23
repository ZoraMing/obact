// 工作流引擎静态模块：模板、CSV 与工作区文件、参数库、工作流加载与结构校验。不需要浏览器。
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ObactError } from '@obact/core';
import { createFiles, parseCsv } from '../src/files.ts';
import { loadParams } from '../src/params.ts';
import { redact, renderTemplate, renderWithTrace } from '../src/template.ts';
import type { Scope, Step, Workflow } from '../src/types.ts';
import { loadWorkflow, type ProblemCode, validateWorkflow } from '../src/workflow.ts';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'obact-wf-static-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 断言抛出 ObactError，返回它以便检查消息。 */
function thrown(fn: () => unknown, code: string): ObactError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ObactError, `应抛 ObactError，实际：${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`应抛 ${code}`);
}

// ---------- 模板 ----------

const PARAMS: Record<string, unknown> = {
  n: 5,
  user: 'bob',
  password: 'p@ss',
  account: { user: 'amy', password: 'zz' },
};

function scope(): Scope {
  return {
    param: (name) => (Object.hasOwn(PARAMS, name) ? PARAMS[name] : undefined),
    vars: {
      list: [1, 2],
      order: { id: 88231, items: [{ sku: 'A' }, { sku: 'B' }] },
      evil: '{{param:password}}',
    },
    file: (p) => (p === 'inputs/orders.csv' ? [{ id: '1' }, { id: '2' }] : undefined),
  };
}

describe('模板', () => {
  test('整体是单个模板时保留原类型，混合文本插值为字符串；点和下标取值；结果不会被二次渲染', () => {
    const s = scope();
    assert.deepEqual(renderTemplate('{{var:list}}', s), [1, 2]);
    assert.equal(renderTemplate('{{var:order.id}}', s), 88231);
    assert.equal(renderTemplate('{{ var : order.items[1].sku }}', s), 'B');
    assert.deepEqual(renderTemplate('{{file:inputs/orders.csv}}', s), [{ id: '1' }, { id: '2' }]);
    assert.equal(renderTemplate('{{param:account.user}}', s), 'amy');
    assert.equal(
      renderTemplate("tr[data-id='{{var:order.id}}'] {{param:n}}", s),
      "tr[data-id='88231'] 5",
    );
    assert.deepEqual(renderTemplate({ a: ['{{param:n}}', 'x{{param:n}}', 3, true, null] }, s), {
      a: [5, 'x5', 3, true, null],
    });
    // 变量的值恰好长得像模板，原样保留
    assert.equal(renderTemplate('{{var:evil}}', s), '{{param:password}}');
    assert.equal(renderTemplate('a {{var:evil}}', s), 'a {{param:password}}');
  });

  test('找不到变量、参数、文件或写法不对：invalid_params，消息带模板原文', () => {
    const s = scope();
    for (const tpl of [
      '{{var:order.nope}}',
      '{{var:list[9]}}',
      '{{var:order.constructor}}', // 原型上的属性不算
      '{{var:a..b}}',
      '{{param:missing}}',
      '{{file:nope.csv}}',
      '{{params:n}}', // 类型写错
    ]) {
      const e = thrown(() => renderTemplate(`前缀 ${tpl}`, s), 'invalid_params');
      assert.ok(e.message.includes(tpl), `消息应含 ${tpl}：${e.message}`);
    }
  });

  test('敏感：renderWithTrace 标出渲染自敏感参数的内容，redacted 可直接写日志；redact 按键名打码', () => {
    const s = scope();
    const t = renderWithTrace(
      { cmd: 'login {{param:password}}', who: '{{param:user}}', raw: '{{param:account.password}}' },
      s,
    );
    assert.equal(t.sensitive, true);
    assert.deepEqual(t.value, { cmd: 'login p@ss', who: 'bob', raw: 'zz' });
    assert.deepEqual(t.redacted, { cmd: '***', who: 'bob', raw: '***' });

    const plain = renderWithTrace('{{param:user}}-{{var:order.id}}', s);
    assert.equal(plain.sensitive, false);
    assert.equal(plain.redacted, 'bob-88231');

    // 引入的值里带敏感键（如 CSV 有 password 列），也要标出来并在 redacted 里打码
    const withKey = renderWithTrace('{{file:accounts.csv}}', {
      ...s,
      file: () => [{ user: 'a', password: 'p' }],
    });
    assert.equal(withKey.sensitive, true);
    assert.deepEqual(withKey.redacted, [{ user: 'a', password: '***' }]);

    // runner 记录“由敏感参数赋值而来的变量”后，传入这个钩子即可
    const viaHook = renderWithTrace('{{var:order.id}}', s, {
      isSensitive: (kind, name) => kind === 'var' && name === 'order.id',
    });
    assert.equal(viaHook.redacted, '***');

    assert.deepEqual(
      redact({ password: 'x', nested: { apiToken: 'y', list: [{ client_secret: 'z', n: 1 }] } }),
      { password: '***', nested: { apiToken: '***', list: [{ client_secret: '***', n: 1 }] } },
    );
  });
});

// ---------- CSV 与工作区文件 ----------

describe('工作区文件', () => {
  test('CSV：引号内的逗号、换行、转义引号，CRLF，BOM，空行', () => {
    const text = '﻿name,note\r\n"李, 四","第一行\n第二行 ""引用"""\r\n王五,\r\n\r\n  \r\n"",x\r\n';
    assert.deepEqual(parseCsv(text), [
      { name: '李, 四', note: '第一行\n第二行 "引用"' },
      { name: '王五', note: '' },
      { name: '', note: 'x' },
    ]);
    assert.deepEqual(parseCsv(''), []);
  });

  test('CSV：列数不符、表头重复、引号未闭合直接报错，不静默丢数据', () => {
    const e = thrown(() => parseCsv('a,b\n1,2\n3\n'), 'invalid_params');
    assert.ok(e.message.includes('第 3 行'), e.message);
    thrown(() => parseCsv('a,b\n1,2,3\n'), 'invalid_params');
    thrown(() => parseCsv('a,a\n1,2\n'), 'invalid_params');
    thrown(() => parseCsv('a,b\n"1,2\n'), 'invalid_params');
  });

  test('read 按扩展名返回；write 自动建目录、支持 Buffer；list 相对 files 根', () => {
    const ws = tmp();
    const files = createFiles(ws);
    assert.deepEqual(files.list(), []); // files 目录还不存在
    files.write('inputs/orders.csv', '﻿id,name\n1,甲\n2,乙\n');
    files.write('inputs/rows.jsonl', '{"a":1}\n\n{"a":2}\n');
    files.write('inputs/cfg.json', '﻿{"x":[1,2]}');
    files.write('inputs/note.txt', '你好\n');
    assert.deepEqual(files.read('inputs/orders.csv'), [
      { id: '1', name: '甲' },
      { id: '2', name: '乙' },
    ]);
    assert.deepEqual(files.read('inputs/rows.jsonl'), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(files.read('inputs/cfg.json'), { x: [1, 2] });
    assert.equal(files.read('inputs/note.txt'), '你好\n');

    const r = files.write('out/deep/a.bin', Buffer.from([1, 2, 3]));
    assert.deepEqual(r, { path: 'out/deep/a.bin', size: 3 });
    assert.deepEqual([...readFileSync(join(ws, 'files/out/deep/a.bin'))], [1, 2, 3]);

    const top = files.list();
    assert.deepEqual(
      top.map((e) => [e.path, e.dir]),
      [
        ['inputs', true],
        ['out', true],
      ],
    );
    assert.deepEqual(
      files.list('inputs').map((e) => e.path),
      ['inputs/cfg.json', 'inputs/note.txt', 'inputs/orders.csv', 'inputs/rows.jsonl'],
    );
    thrown(() => files.read('inputs/none.csv'), 'invalid_params');
  });

  test('不能越出工作区：.. 、绝对路径、经符号链接（含悬空链接和尚不存在的目标）', (t) => {
    if (process.platform === 'win32') return t.skip('Windows 创建符号链接需要权限');
    const ws = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.txt'), '机密');
    const files = createFiles(ws);
    files.write('keep/real.txt', '内部');
    symlinkSync(outside, join(ws, 'files', 'link')); // 指向工作区外的目录
    symlinkSync(join(outside, 'not-yet.txt'), join(ws, 'files', 'dangling')); // 悬空，目标在工作区外
    symlinkSync(join(ws, 'files', 'keep'), join(ws, 'files', 'alias')); // 指向工作区内，应当放行

    for (const p of ['../x.txt', 'a/../../x.txt', '/etc/passwd', 'link/secret.txt']) {
      thrown(() => files.read(p), 'path_outside_workspace');
    }
    for (const p of ['../x.txt', 'link/new.txt', 'link/sub/new.txt', 'dangling']) {
      thrown(() => files.write(p, 'x'), 'path_outside_workspace');
    }
    thrown(() => files.list('link'), 'path_outside_workspace');
    thrown(() => files.resolve('link/secret.txt', true), 'path_outside_workspace');
    assert.equal(existsSync(join(outside, 'new.txt')), false);
    assert.equal(existsSync(join(outside, 'sub')), false);
    assert.equal(existsSync(join(outside, 'not-yet.txt')), false);

    assert.equal(files.read('alias/real.txt'), '内部');
    // 名字以 .. 开头的文件在工作区内，不是越界
    files.write('..hidden.txt', 'ok');
    assert.equal(files.read('..hidden.txt'), 'ok');
  });
});

// ---------- 参数库 ----------

describe('参数库', () => {
  const YAML = [
    '# 参数库',
    'global:',
    '  phone: "G"  # 全局手机号',
    '  shared: g',
    'sites:',
    '  a.com:',
    '    shared: s',
    'workflows:',
    '  w1:',
    '    shared: w',
    '',
  ].join('\n');

  test('工作流 → 网站 → 全局 三级查找；set 写回时保留注释与其他内容，原子写', () => {
    const ws = tmp();
    const file = join(ws, 'params.yaml');
    writeFileSync(file, YAML);

    const w1 = loadParams(ws, 'w1', 'a.com');
    assert.equal(w1.get('shared'), 'w');
    assert.equal(loadParams(ws, 'w2', 'a.com').get('shared'), 's');
    assert.equal(loadParams(ws, 'w2', undefined).get('shared'), 'g');
    assert.equal(w1.get('phone'), 'G');
    assert.equal(w1.get('missing'), undefined);
    assert.equal(w1.get('constructor'), undefined);

    w1.set('login_token', 'abc', 'site');
    w1.set('page_size', 50, 'workflow');
    w1.set('profile', { city: '上海', tags: ['a', 'b'] }); // 默认写全局
    assert.equal(w1.get('login_token'), 'abc');
    // 重新加载能读到，说明确实写进了文件
    const again = loadParams(ws, 'w1', 'a.com');
    assert.equal(again.get('login_token'), 'abc');
    assert.equal(again.get('page_size'), 50);
    assert.deepEqual(again.get('profile'), { city: '上海', tags: ['a', 'b'] });
    assert.equal(loadParams(ws, 'w9', 'b.com').get('login_token'), undefined); // 只写在 a.com 下

    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('# 参数库') && text.includes('# 全局手机号'), text);
    assert.equal(again.get('shared'), 'w');
    assert.deepEqual(
      readdirSync(ws).filter((n) => n !== 'params.yaml'),
      [],
      '不留临时文件',
    );

    assert.equal(w1.isSensitive('Login_Token'), true);
    assert.equal(w1.isSensitive('db.PASSWORD'), true);
    assert.equal(w1.isSensitive('client_secret'), true);
    assert.equal(w1.isSensitive('phone'), false);

    thrown(() => w1.set('bad name!', 1), 'invalid_params');
    thrown(() => loadParams(ws, 'w1').set('x', 1, 'site'), 'invalid_params'); // 没有指定网站
  });

  test('文件不存在时 set 新建（只有本人可读写），内容不合契约时加载报错', (t) => {
    const ws = tmp();
    const store = loadParams(ws, 'w1');
    assert.equal(store.get('a'), undefined);
    store.set('password', 'x');
    assert.equal(loadParams(ws, 'w1').get('password'), 'x');
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(ws, 'params.yaml')).mode & 0o777, 0o600);
    } else t.diagnostic('Windows 不检查文件权限');

    const bad = tmp();
    writeFileSync(join(bad, 'params.yaml'), 'global:\n  a: 1\nglobl:\n  b: 2\n');
    thrown(() => loadParams(bad, 'w1'), 'invalid_params');
    // 只写了 `global:`、`a.com:` 没有内容是允许的
    const empty = tmp();
    writeFileSync(join(empty, 'params.yaml'), 'global:\nsites:\n  a.com:\n');
    const s = loadParams(empty, 'w1', 'a.com');
    assert.equal(s.get('x'), undefined);
    s.set('x', 1, 'site');
    assert.equal(loadParams(empty, 'w1', 'a.com').get('x'), 1);
  });
});

// ---------- 工作流加载与结构校验 ----------

function writeWorkflow(dir: string, steps: string[], extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ name: 'demo', site: 'a.com' }));
  writeFileSync(join(dir, 'steps.jsonl'), `${steps.join('\n')}\n`);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  return dir;
}

const J = (o: Record<string, unknown>) => JSON.stringify(o);

describe('loadWorkflow', () => {
  test('加载 workflow.json 与 steps.jsonl；缺省的 signatures.json、rules.json 为空数组；空行跳过', () => {
    const dir = writeWorkflow(join(tmp(), 'demo'), [
      J({
        step_id: 's01',
        op: 'navigate_page',
        pageId: 'main',
        url: 'https://a.com',
        section: 'preamble',
      }),
      '',
      J({ step_id: 's02', op: 'loop_begin', over: '{{file:inputs/orders.csv}}', as: 'order' }),
      J({
        step_id: 's03',
        op: 'click',
        pageId: 'main',
        target: { css: 'button', within: "tr[data-id='{{var:order.id}}']" },
        once_only: true,
        idempotency_key: 'audit:{{var:order.id}}',
      }),
      J({ step_id: 's04', op: 'loop_end' }),
    ]);
    const w = loadWorkflow(dir);
    assert.equal(w.name, 'demo');
    assert.deepEqual(
      w.steps.map((s) => s.step_id),
      ['s01', 's02', 's03', 's04'],
    );
    assert.deepEqual(w.signatures, []);
    assert.deepEqual(w.rules, []);
  });

  test('错误带行号与 step_id，一次列出全部问题，且是针对这一行的短句', () => {
    const dir = writeWorkflow(join(tmp(), 'demo'), [
      J({ step_id: 's01', op: 'click', pageId: 'main', target: { css: 'a' } }),
      '{"step_id":"s02", oops',
      J({ step_id: 's03', op: 'click', pageId: 'main' }),
      J({ step_id: 's04', op: 'click', pageId: 'main', target: { ref: 3 } }),
      J({ step_id: 's05', op: 'click', pageId: 'main', target: { css: 'a' }, once_only: true }),
      J({ step_id: 's06', op: 'clik', pageId: 'main', target: { css: 'a' } }),
    ]);
    const e = thrown(() => loadWorkflow(dir), 'invalid_params');
    const lines = e.message.split('\n');
    const line = (n: number) => lines.find((l) => l.startsWith(`第 ${n} 行`)) ?? '';
    assert.ok(line(2).includes('不是合法 JSON'), e.message);
    assert.ok(line(3).includes('s03') && line(3).includes('缺少字段 target'), e.message);
    assert.ok(line(4).includes('s04') && line(4).includes('ref'), e.message);
    assert.ok(line(5).includes('s05') && line(5).includes('idempotency_key'), e.message);
    assert.ok(line(6).includes('s06') && line(6).includes('未知的 op'), e.message);
    assert.ok(lines.length <= 8, `不应列出所有 oneOf 分支的错误：${e.message}`);
  });

  test('结构问题经 loadWorkflow 抛出，消息列出全部问题并带行号', () => {
    const dir = writeWorkflow(join(tmp(), 'demo'), [
      J({ step_id: 'a', op: 'loop_begin', over: [1], as: 'x' }),
      J({ step_id: 'b', op: 'checkpoint' }),
      J({ step_id: 'a', op: 'break' }),
    ]);
    const e = thrown(() => loadWorkflow(dir), 'invalid_params');
    assert.ok(e.message.includes('第 3 行（a）'), e.message);
    assert.ok(e.message.includes('step_id 重复'), e.message);
    assert.ok(e.message.includes('没有对应的 loop_end'), e.message);
  });
});

/** 构造步骤：结构校验只看 op、section、模板和目标，不需要契约要求的其他字段。 */
const S = (step_id: string, op: string, extra: Record<string, unknown> = {}): Step =>
  ({ step_id, op, ...extra }) as unknown as Step;
const wf = (steps: Step[]): Workflow => ({
  name: 'demo',
  dir: '/nowhere',
  meta: { name: 'demo' },
  steps,
  signatures: [],
  rules: [],
});
const codes = (steps: Step[], resolve?: (n: string) => unknown): ProblemCode[] =>
  validateWorkflow(wf(steps), resolve).map((p) => p.code);

const KEY = { once_only: true, idempotency_key: 'audit:{{var:order.id}}' };

describe('validateWorkflow', () => {
  const cases: {
    name: string;
    steps: Step[];
    resolve?: (n: string) => unknown;
    expect: ProblemCode[];
  }[] = [
    {
      name: '完整的嵌套结构（循环套循环、if/else、break、set_var、前置路径、call）没有问题',
      steps: [
        S('p1', 'navigate_page', { section: 'preamble' }),
        S('p2', 'call', { section: 'preamble', workflow: 'login' }),
        S('l1', 'loop_begin', { over: '{{file:a.csv}}', as: 'order' }),
        S('i1', 'if', { value: '{{var:order.ok}}', equals: 'y' }),
        S('b1', 'break'),
        S('e1', 'else'),
        S('v1', 'set_var', { name: 'tag', value: '{{var:order.id}}' }),
        S('c1', 'click', { ...KEY, idempotency_key: 'x:{{var:order.id}}' }),
        S('x1', 'extract', { as: 'got' }),
        S('c3', 'click', { once_only: true, idempotency_key: 'y:{{var:order.id}}' }),
        S('n1', 'end_if'),
        S('l2', 'loop_begin', { over: '{{var:order.items}}', as: 'item' }),
        S('c2', 'click', { once_only: true, idempotency_key: '{{var:order.id}}:{{var:item.sku}}' }),
        S('l3', 'loop_end'),
        S('l4', 'loop_end'),
      ],
      resolve: (n) => n === 'login',
      expect: [],
    },
    {
      name: 'step_id 重复',
      steps: [S('a', 'checkpoint'), S('a', 'checkpoint')],
      expect: ['duplicate_step_id'],
    },
    {
      name: 'loop_begin 没有 loop_end',
      steps: [S('a', 'loop_begin', { as: 'x' }), S('b', 'checkpoint')],
      expect: ['unclosed'],
    },
    {
      name: 'loop_end 没有 loop_begin',
      steps: [S('a', 'checkpoint'), S('b', 'loop_end')],
      expect: ['unmatched'],
    },
    {
      name: '嵌套交叉：if 还没结束就 loop_end',
      steps: [
        S('a', 'loop_begin', { as: 'x' }),
        S('b', 'if', { value: '1', equals: 1 }),
        S('c', 'loop_end'),
        S('d', 'end_if'),
      ],
      expect: ['unclosed', 'unmatched'],
    },
    {
      name: 'else 没有 if；同一个 if 两个 else；end_if 没有 if',
      steps: [
        S('a', 'else'),
        S('b', 'if', { value: '1', equals: 1 }),
        S('c', 'else'),
        S('d', 'else'),
        S('e', 'end_if'),
        S('f', 'end_if'),
      ],
      expect: ['unmatched', 'unmatched', 'unmatched'],
    },
    {
      name: 'break 不在循环内',
      steps: [S('a', 'if', { value: '1', equals: 1 }), S('b', 'break'), S('c', 'end_if')],
      expect: ['break_outside_loop'],
    },
    {
      name: '前置路径步骤出现在主流程之后',
      steps: [S('a', 'click'), S('b', 'navigate_page', { section: 'preamble' })],
      expect: ['preamble_after_main'],
    },
    {
      name: '前置路径步骤在循环里；控制流不能属于前置路径',
      steps: [
        S('a', 'loop_begin', { as: 'x', section: 'preamble' }),
        S('b', 'click', { section: 'preamble' }),
        S('c', 'loop_end'),
      ],
      expect: ['preamble_in_block', 'preamble_in_block'],
    },
    {
      name: 'target、from、to、elements 里不能用 ref',
      steps: [
        S('a', 'click', { target: { ref: 3 } }),
        S('b', 'drag', { from: { ref: 1 }, to: [1, 2] }),
        S('c', 'fill_form', { elements: [{ target: { css: 'a' } }, { target: { ref: 2 } }] }),
      ],
      expect: ['ref_target', 'ref_target', 'ref_target'],
    },
    {
      name: 'call 的工作流不存在（没有传 resolveWorkflow 时不检查）',
      steps: [S('a', 'call', { workflow: 'nope' })],
      resolve: () => false,
      expect: ['call_not_found'],
    },
    {
      name: 'call 的工作流名必须是安全名：带路径分隔符、.. 的不行（不依赖 resolveWorkflow）',
      steps: [
        S('a', 'call', { workflow: '../evil' }),
        S('b', 'call', { workflow: 'a/b' }),
        S('c', 'call', { workflow: '..' }),
        S('d', 'call', { workflow: 'sub.v2' }),
      ],
      expect: ['bad_call_name', 'bad_call_name', 'bad_call_name'],
    },
    {
      name: '模板写错：类型不存在、变量路径不合法',
      steps: [S('a', 'fill', { value: '{{params:x}}' }), S('b', 'fill', { value: '{{var:a..b}}' })],
      expect: ['bad_template', 'bad_template'],
    },
    {
      name: 'once_only 没有 idempotency_key',
      steps: [S('a', 'click', { once_only: true })],
      expect: ['missing_idempotency_key'],
    },
    {
      name: 'once_only 只能用在动作步骤上：call、set_var、extract、loop_begin、if、checkpoint 都不行',
      steps: [
        S('a', 'call', { workflow: 'sub', once_only: true, idempotency_key: 'k1' }),
        S('b', 'set_var', { name: 'v', value: 1, once_only: true, idempotency_key: 'k2' }),
        S('c', 'extract', { as: 'o', once_only: true, idempotency_key: 'k3' }),
        S('d', 'loop_begin', { as: 'x', once_only: true, idempotency_key: 'k4-{{var:x}}' }),
        S('e', 'if', { value: '1', equals: 1, once_only: true, idempotency_key: 'k5' }),
        S('f', 'end_if'),
        S('g', 'loop_end'),
        S('h', 'checkpoint', { once_only: true, idempotency_key: 'k6' }),
      ],
      expect: Array(6).fill('once_only_not_action'),
    },
    {
      name: '循环内的幂等键不含循环变量：每条都会得到同一个键',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'click', { once_only: true, idempotency_key: 'audit:{{param:month}}' }),
        S('c', 'loop_end'),
      ],
      expect: ['key_not_per_item'],
    },
    {
      name: '幂等键只含外层循环变量，内层循环每条仍是同一个键',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'loop_begin', { as: 'item' }),
        S('c', 'click', KEY),
        S('d', 'loop_end'),
        S('e', 'loop_end'),
      ],
      expect: ['key_not_per_item'],
    },
    {
      name: '嵌套循环的幂等键必须引用每一层外层循环的变量，只含最内层的变量时外层不同条目会撞键',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'loop_begin', { as: 'line' }),
        S('c', 'click', { once_only: true, idempotency_key: 'line-{{var:line}}' }),
        S('d', 'loop_end'),
        S('e', 'loop_end'),
      ],
      expect: ['key_not_per_item'],
    },
    {
      name: '循环内 set_var、extract 设的变量不算随条目变化：键只引用它们时仍是同一个键',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'set_var', { name: 'tag', value: 'const' }),
        S('c', 'extract', { as: 'got' }),
        S('d', 'click', { once_only: true, idempotency_key: 'x:{{var:tag}}' }),
        S('e', 'click', { once_only: true, idempotency_key: 'y:{{var:got.id}}' }),
        S('f', 'loop_end'),
      ],
      expect: ['key_not_per_item', 'key_not_per_item'],
    },
    {
      name: '两个 once_only 步骤的幂等键模板完全相同：同一条目的第二个会被当作已提交而跳过',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'click', KEY),
        S('c', 'click', KEY),
        S('d', 'loop_end'),
      ],
      expect: ['duplicate_idempotency_key'],
    },
    {
      name: '前置路径里不允许 once_only：它无条件重放',
      steps: [
        S('a', 'click', { section: 'preamble', once_only: true, idempotency_key: 'login-once' }),
      ],
      expect: ['once_only_in_preamble'],
    },
    {
      name: '幂等键引用了别处循环的变量',
      steps: [
        S('a', 'loop_begin', { as: 'order' }),
        S('b', 'click', KEY),
        S('c', 'loop_end'),
        S('d', 'click', { ...KEY, idempotency_key: 'again:{{var:order.id}}' }),
      ],
      expect: ['key_var_out_of_scope'],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const got = codes(c.steps, c.resolve);
      assert.deepEqual(
        [...got].sort(),
        [...c.expect].sort(),
        JSON.stringify(validateWorkflow(wf(c.steps), c.resolve)),
      );
    });
  }

  test('extract 带 into 却解析不出主键：步骤的 key 与 meta.outputs 都没有时报错（续跑重做会重复写入）', () => {
    const check = (extra: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
      validateWorkflow({
        ...wf([S('e', 'extract', extra)]),
        meta: { name: 'demo', ...meta } as Workflow['meta'],
      }).map((p) => p.code);
    assert.deepEqual(check({ into: 'items' }), ['extract_no_key']);
    assert.deepEqual(check({ into: 'items' }, { outputs: { other: { key: 'id' } } }), [
      'extract_no_key',
    ]);
    assert.deepEqual(check({ into: 'items' }, { outputs: { items: { export: ['csv'] } } }), [
      'extract_no_key',
    ]);
    assert.deepEqual(check({ into: 'items', key: 'id' }), []);
    assert.deepEqual(check({ into: 'items' }, { outputs: { items: { key: 'id' } } }), []);
    assert.deepEqual(check({ as: 'rows' }), [], '只存变量、不写采集输出，不需要主键');
  });
});
