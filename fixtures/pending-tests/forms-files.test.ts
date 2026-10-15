// 表单与文件夹具（PRD 9.3，FR-12、FR-22、FR-26）：密码打码；填写、上传、对话框处理生效；下载的响应头与内容正确。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { act, observe } from '@obact/core';
import type { Action, ActResult } from '@obact/schemas';
import { Contracts } from '@obact/schemas';
import {
  REPORT_FILENAME,
  REPORT_FILENAME_CN,
  REPORT_HEADER,
  reportCsv,
  reportRows,
} from '../api/forms-files.ts';
import { type FixtureEnv, SKIP, setup } from '../test/helpers.ts';

const contracts = new Contracts();
const PASSWORD = 'S3cret!pw';
const TOKEN = 'tok-9f8e7d6c';

/** 最小的 RFC 4180 解析：逗号分隔、双引号包裹、引号写两次、CRLF 换行。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

/** 给事件等待加上限，超时报错而不是挂住。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待超时：${what}`)), ms);
    }),
  ]);
}

describe('表单与文件夹具（FR-12、FR-22、FR-26）', { skip: SKIP }, () => {
  let env: FixtureEnv;
  let files: string;
  before(async () => {
    env = await setup();
    files = mkdtempSync(join(tmpdir(), 'obact-forms-files-'));
    writeFileSync(join(files, 'report.txt'), '季度报告：一切正常。\n');
    writeFileSync(join(files, '季度报告.txt'), '中文文件名的附件\n');
    mkdirSync(join(files, 'sub'));
    writeFileSync(join(files, 'sub', 'data.csv'), 'a,b\n'.repeat(300));
    writeFileSync(join(files, 'avatar.png'), Buffer.alloc(2048, 7));
  });
  after(async () => {
    await env?.close();
    if (files) rmSync(files, { recursive: true, force: true });
  });

  async function run(a: Action): Promise<ActResult> {
    const r = await act(env.session, a, { filesRoot: files });
    contracts.assert('act-result', r);
    return r;
  }
  async function ok(a: Action): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'ok', `${a.op} 失败：${r.error?.code} ${r.error?.message}`);
    return r;
  }
  async function err(a: Action, code: string): Promise<ActResult> {
    const r = await run(a);
    assert.equal(r.status, 'error', `${a.op} 应失败`);
    assert.equal(r.error?.code, code, r.error?.message);
    return r;
  }
  const text = (pageId: string, sel: string) =>
    env.session.pages.get(pageId).$eval(sel, (e) => e.textContent ?? '');
  const open = () => env.open('/forms-files/');

  /** 打开页面并填好用户名、密码、令牌。 */
  async function openFilled(): Promise<string> {
    const pageId = await open();
    await ok({
      op: 'fill_form',
      pageId,
      elements: [
        { target: { role: 'textbox', name: '用户名' }, value: 'alice' },
        { target: { css: '#password' }, value: PASSWORD },
        { target: { role: 'textbox', name: 'API 令牌' }, value: TOKEN },
      ],
    });
    return pageId;
  }

  test('observe 中密码与令牌打码，普通字段显示原值', async () => {
    const pageId = await openFilled();
    const ob = await observe(env.session, { pageId });
    contracts.assert('observe.Result', ob);
    const byName = (n: string) => ob.elements.find((e) => e.name === n);
    assert.equal(byName('用户名')?.value, 'alice');
    assert.equal(byName('密码')?.value, '***');
    assert.equal(byName('密码')?.input_type, 'password');
    assert.equal(byName('API 令牌')?.value, '***', '名称含 token 的字段也打码');
    const all = JSON.stringify(ob);
    for (const secret of [PASSWORD, TOKEN]) {
      assert.ok(!all.includes(secret), `observe 返回中泄露了 ${secret}`);
    }
    assert.ok(ob.snapshot_text?.includes('alice'));
  });

  test('可访问性树（axtree 视图）同样不泄露密码与令牌', async () => {
    const pageId = await openFilled();
    const ob = await observe(env.session, { pageId, views: ['text', 'axtree'] });
    assert.ok(ob.axtree?.includes('alice'), '普通字段的值照常给出');
    assert.ok(!ob.axtree?.includes(PASSWORD), '密码泄露到可访问性树');
    assert.ok(!ob.axtree?.includes(TOKEN), `令牌泄露到可访问性树：${ob.axtree}`);
  });

  test('fill / fill_form：文本框、密码框、下拉框、复选框都生效，输入可信', async () => {
    const pageId = await open();
    const page = env.session.pages.get(pageId);
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '用户名' }, value: 'alice' });
    await ok({ op: 'fill', pageId, target: { role: 'textbox', name: '密码' }, value: PASSWORD });
    // 没勾选“同意服务条款”：页面拒绝保存
    await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '保存设置' },
      post: [{ text_present: '请先同意服务条款' }],
    });
    await ok({
      op: 'fill_form',
      pageId,
      elements: [
        { target: { role: 'combobox', name: '角色' }, value: '审计员' },
        { target: { role: 'checkbox', name: '记住登录' }, value: true },
        { target: { role: 'checkbox', name: '同意服务条款' }, value: true },
      ],
    });
    const r = await ok({
      op: 'click',
      pageId,
      target: { role: 'button', name: '保存设置' },
      post: [{ text_present: '已保存：' }],
    });
    assert.equal(r.assertions?.[0]?.pass, true);
    assert.equal(
      await text(pageId, '#account-result'),
      `已保存：用户名 alice，角色 审计员，记住登录 是，密码 ${PASSWORD.length} 位，令牌 未填写`,
    );
    const values = await page.evaluate(() => ({
      user: (document.getElementById('username') as HTMLInputElement).value,
      pwd: (document.getElementById('password') as HTMLInputElement).value,
      role: (document.getElementById('role') as HTMLSelectElement).value,
      remember: (document.getElementById('remember') as HTMLInputElement).checked,
      events: [...(window as unknown as { formEvents: string[] }).formEvents],
    }));
    assert.deepEqual(
      { ...values, events: undefined },
      { user: 'alice', pwd: PASSWORD, role: 'auditor', remember: true, events: undefined },
    );
    assert.ok(values.events.includes('input:password:true'), '密码框收到可信输入');
    assert.ok(!values.events.some((e) => e.endsWith(':false')), '没有不可信事件');
  });

  test('handle_dialog：alert、confirm（确定/取消）、prompt（输入/取消）', async () => {
    const pageId = await open();
    const r = await ok({ op: 'click', pageId, target: { role: 'button', name: '显示提示' } });
    assert.deepEqual(r.effects.dialogs, [
      { type: 'alert', message: '操作已完成', handled: 'pending' },
    ]);
    // 对话框未处理时其他动作被挡住
    await err(
      { op: 'click', pageId, target: { role: 'button', name: '删除记录' } },
      'dialog_blocking',
    );
    await ok({
      op: 'handle_dialog',
      pageId,
      action: 'accept',
      post: [{ text_present: '提示已关闭' }],
    });

    const cases: [string, Action, string][] = [
      ['删除记录', { op: 'handle_dialog', pageId, action: 'accept' }, '确认结果：已删除'],
      ['删除记录', { op: 'handle_dialog', pageId, action: 'dismiss' }, '确认结果：已取消'],
      [
        '重命名',
        { op: 'handle_dialog', pageId, action: 'accept', prompt_text: '季度报表' },
        '新名称：季度报表',
      ],
      ['重命名', { op: 'handle_dialog', pageId, action: 'dismiss' }, '重命名已取消'],
    ];
    for (const [button, handle, want] of cases) {
      const c = await ok({ op: 'click', pageId, target: { role: 'button', name: button } });
      assert.equal(c.effects.dialogs[0]?.handled, 'pending', `${button} 弹出对话框`);
      await ok({ ...handle, post: [{ text_present: want }] } as Action);
      assert.equal(await text(pageId, '#dialog-result'), want);
    }
  });

  test('prompt 不给 prompt_text 时按默认值确认（与用户直接点“确定”一致）', async () => {
    const pageId = await open();
    await ok({ op: 'click', pageId, target: { role: 'button', name: '重命名' } });
    await ok({ op: 'handle_dialog', pageId, action: 'accept' });
    assert.equal(await text(pageId, '#dialog-result'), '新名称：未命名');
  });

  test('handle_dialog 关闭对话框后很快返回（不被挂起的页面拖住）', async () => {
    const pageId = await open();
    const durations: Record<string, number> = {};
    for (const [button, want] of [
      ['显示提示', '提示已关闭'],
      ['删除记录', '确认结果：已删除'],
      ['重命名', '新名称：月报'],
    ] as const) {
      await ok({ op: 'click', pageId, target: { role: 'button', name: button } });
      const r = await ok({
        op: 'handle_dialog',
        pageId,
        action: 'accept',
        ...(button === '重命名' ? { prompt_text: '月报' } : {}),
        post: [{ text_present: want }],
      });
      durations[button] = r.duration_ms;
    }
    console.log(`handle_dialog 耗时（毫秒）：${JSON.stringify(durations)}`);
    for (const [k, ms] of Object.entries(durations)) {
      assert.ok(ms < 1000, `${k}：handle_dialog 耗时 ${ms} 毫秒，对话框关闭后应很快返回`);
    }
  });

  test('upload_file：文件输入框（多选）与自绘上传按钮，页面显示文件名和大小；越出工作区被拒', async () => {
    const pageId = await open();
    const size = (p: string) => statSync(join(files, p)).size;
    await ok({
      op: 'upload_file',
      pageId,
      target: { role: 'button', name: '选择附件' },
      files: ['report.txt', 'sub/data.csv'],
      post: [{ text_present: 'data.csv（' }],
    });
    const items = await env.session.pages
      .get(pageId)
      .$$eval('#file-list li', (els) => els.map((e) => e.textContent));
    assert.deepEqual(items, [
      `report.txt（${size('report.txt')} 字节）`,
      `data.csv（${size('sub/data.csv')} 字节）`,
    ]);
    const events = await env.session.pages
      .get(pageId)
      .evaluate(() => [...(window as unknown as { formEvents: string[] }).formEvents]);
    assert.ok(events.includes('attach:true'), '上传触发可信的 change 事件');

    // 自绘按钮：点击后弹出文件选择框，选入文件
    await ok({
      op: 'upload_file',
      pageId,
      target: { role: 'button', name: '上传头像' },
      files: ['avatar.png'],
      post: [{ text_present: '头像：avatar.png' }],
    });
    assert.equal(
      await text(pageId, '#avatar-result'),
      `头像：avatar.png（${size('avatar.png')} 字节）`,
    );

    await err(
      { op: 'upload_file', pageId, target: { css: '#attach' }, files: ['../outside.txt'] },
      'path_outside_workspace',
    );
    await err(
      {
        op: 'upload_file',
        pageId,
        target: { css: '#avatar-btn' },
        files: ['avatar.png', 'report.txt'],
      },
      'invalid_params',
    );
  });

  test('upload_file：中文文件名的附件上传后页面显示原文件名', async () => {
    const pageId = await open();
    const r = await ok({
      op: 'upload_file',
      pageId,
      target: { css: '#attach' },
      files: ['季度报告.txt'],
    });
    const got = await env.session.pages
      .get(pageId)
      .$eval('#attach', (e) => [...((e as HTMLInputElement).files ?? [])].map((f) => f.name));
    assert.deepEqual(
      got,
      ['季度报告.txt'],
      `upload_file 返回 ${r.status}，但文件输入框里是 ${JSON.stringify(got)}`,
    );
    const size = statSync(join(files, '季度报告.txt')).size;
    assert.equal(await text(pageId, '#file-list'), `季度报告.txt（${size} 字节）`);
  });

  test('下载接口：附件响应头、中文文件名、UTF-8 BOM、CSV 转义与确定性', async () => {
    const get = async (q: string) => {
      const r = await fetch(`${env.server.base}/api/forms-files/report.csv?${q}`);
      return { r, buf: Buffer.from(await r.arrayBuffer()) };
    };
    const { r, buf } = await get('seed=1&rows=10');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    const cd = r.headers.get('content-disposition') ?? '';
    assert.match(cd, /^attachment;/);
    assert.ok(cd.includes(`filename="${REPORT_FILENAME}"`), cd);
    const star = cd.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    assert.equal(decodeURIComponent(star ?? ''), REPORT_FILENAME_CN);
    assert.equal(Number(r.headers.get('content-length')), buf.length);

    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '以 UTF-8 BOM 开头');
    const body = buf.toString('utf8');
    assert.equal(body, reportCsv(1, 10));
    assert.ok(body.endsWith('\r\n'));
    const rows = parseCsv(body.slice(1));
    assert.deepEqual(rows[0], REPORT_HEADER);
    assert.deepEqual(rows.slice(1), reportRows(1, 10));
    assert.ok(body.includes('"含发票, 需盖章"'), '含逗号的字段加引号');
    assert.ok(body.includes('"客户说""尽快"""'), '引号写两次');

    assert.ok((await get('seed=1&rows=10')).buf.equals(buf), '同一 seed 内容相同');
    assert.ok(!(await get('seed=2&rows=10')).buf.equals(buf), '不同 seed 内容不同');
    assert.equal(parseCsv((await get('seed=1&rows=0')).buf.toString('utf8').slice(1)).length, 1);
    assert.equal((await get('rows=-1')).r.status, 400);
  });

  test('下载链接：浏览器里点击，下载得到与接口相同的文件', async () => {
    const pageId = await open();
    const dir = mkdtempSync(join(tmpdir(), 'obact-download-'));
    const cdp = await env.browser.target().createCDPSession();
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dir,
        eventsEnabled: true,
      });
      const begin = new Promise<{ guid: string; suggestedFilename: string; url: string }>(
        (resolve) => cdp.on('Browser.downloadWillBegin', (e) => resolve(e)),
      );
      const done = new Promise<{ guid: string }>((resolve) =>
        cdp.on('Browser.downloadProgress', (e) => {
          if (e.state === 'completed') resolve(e);
        }),
      );
      const ob = await observe(env.session, { pageId });
      const link = ob.elements.find((e) => e.role === 'link' && e.name === '下载订单报表（CSV）');
      assert.ok(link, '下载链接在元素表中');
      assert.ok(link.href?.endsWith('/api/forms-files/report.csv?seed=1&rows=10'), link.href);

      const r = await ok({ op: 'click', pageId, target: { ref: link.ref } });
      console.log(`点击下载链接：耗时 ${r.duration_ms} 毫秒，效果 ${JSON.stringify(r.effects)}`);
      assert.equal(r.effects.navigated, false, '下载不是导航');
      assert.ok(r.duration_ms < 3000, `点击下载链接耗时 ${r.duration_ms}`);
      const b = await withTimeout(begin, 10_000, '下载开始');
      const d = await withTimeout(done, 10_000, '下载完成');
      const got = readFileSync(join(dir, d.guid));
      assert.ok(
        got.equals(Buffer.from(reportCsv(1, 10), 'utf8')),
        '下载的文件与接口一致（含 BOM）',
      );
      assert.match(env.session.pages.get(pageId).url(), /\/forms-files\/$/, '页面没有跳走');
      // 浏览器按 content-disposition 的 filename* 取中文文件名
      assert.equal(b.suggestedFilename, REPORT_FILENAME_CN);
    } finally {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await cdp.detach().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
