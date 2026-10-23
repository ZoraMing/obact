// 表单与文件夹具（PRD 9.3，FR-35）：表单填写与密码打码、上传（文件输入框与自绘按钮、中文文件名）、下载。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { observe } from '@obact/core';
import type { Action } from '@obact/schemas';
import { REPORT_FILENAME_CN, reportCsv } from '../api/forms-files.ts';
import { type FixtureEnv, ok, run, SKIP, setup } from './helpers.ts';

const PASSWORD = 'S3cret!pw';
const TOKEN = 'tok-9f8e7d6c';

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

describe('表单与文件夹具（FR-35）', { skip: SKIP }, () => {
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

  const act = (a: Action) => ok(env, a, { filesRoot: files });
  const page = (pageId: string) => env.session.pages.get(pageId);
  const text = (pageId: string, sel: string) => page(pageId).$eval(sel, (e) => e.textContent ?? '');
  const events = (pageId: string) =>
    page(pageId).evaluate(() => [...(window as unknown as { formEvents: string[] }).formEvents]);

  test('填写与保存：文本框、密码框、下拉框、复选框都生效且输入可信；observe 与可访问性树里密码和令牌打码', async () => {
    const pageId = await env.open('/forms-files/');
    await act({
      op: 'fill_form',
      pageId,
      elements: [
        { target: { role: 'textbox', name: '用户名' }, value: 'alice' },
        { target: { css: '#password' }, value: PASSWORD },
        { target: { role: 'textbox', name: 'API 令牌' }, value: TOKEN },
      ],
    });
    const ob = await observe(env.session, { pageId, views: ['text', 'axtree'] });
    const byName = (n: string) => ob.elements.find((e) => e.name === n);
    assert.equal(byName('用户名')?.value, 'alice');
    assert.equal(byName('密码')?.value, '***');
    assert.equal(byName('API 令牌')?.value, '***', '名称含 token 的字段也打码');
    for (const secret of [PASSWORD, TOKEN]) {
      assert.ok(!JSON.stringify(ob).includes(secret), `observe 返回中泄露了 ${secret}`);
    }

    // 没勾选“同意服务条款”：页面拒绝保存
    const save = { role: 'button', name: '保存设置' };
    await act({ op: 'click', pageId, target: save, post: [{ text_present: '请先同意服务条款' }] });
    await act({
      op: 'fill_form',
      pageId,
      elements: [
        { target: { role: 'combobox', name: '角色' }, value: '审计员' },
        { target: { role: 'checkbox', name: '记住登录' }, value: true },
        { target: { role: 'checkbox', name: '同意服务条款' }, value: true },
      ],
    });
    await act({ op: 'click', pageId, target: save, post: [{ text_present: '已保存：' }] });
    assert.equal(
      await text(pageId, '#account-result'),
      `已保存：用户名 alice，角色 审计员，记住登录 是，密码 ${PASSWORD.length} 位`,
    );
    const ev = await events(pageId);
    assert.ok(ev.includes('input:password:true'), '密码框收到可信输入');
    assert.ok(!ev.some((e) => e.endsWith(':false')), '没有不可信事件');
  });

  test('upload_file：多选文件输入框、自绘上传按钮、中文文件名；一个输入框传多个文件被拒', async () => {
    const pageId = await env.open('/forms-files/');
    const size = (p: string) => statSync(join(files, p)).size;
    await act({
      op: 'upload_file',
      pageId,
      target: { role: 'button', name: '选择附件' },
      files: ['report.txt', 'sub/data.csv', '季度报告.txt'],
      post: [{ text_present: '季度报告.txt（' }],
    });
    assert.deepEqual(
      await page(pageId).$$eval('#file-list li', (els) => els.map((e) => e.textContent)),
      [
        `report.txt（${size('report.txt')} 字节）`,
        `data.csv（${size('sub/data.csv')} 字节）`,
        `季度报告.txt（${size('季度报告.txt')} 字节）`,
      ],
    );
    assert.ok((await events(pageId)).includes('attach:true'), '上传触发可信的 change 事件');

    // 自绘按钮：点击后弹出文件选择框，选入文件
    await act({
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
    const r = await run(
      env,
      {
        op: 'upload_file',
        pageId,
        target: { css: '#avatar-btn' },
        files: ['avatar.png', 'report.txt'],
      },
      { filesRoot: files },
    );
    assert.equal(r.error?.code, 'invalid_params', r.error?.message);
  });

  test('下载链接：浏览器里点击，不算导航，下载得到与接口相同的文件（含 BOM），文件名取 filename*', async () => {
    const pageId = await env.open('/forms-files/');
    const dir = mkdtempSync(join(tmpdir(), 'obact-download-'));
    const cdp = await env.browser.target().createCDPSession();
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dir,
        eventsEnabled: true,
      });
      const begin = new Promise<{ suggestedFilename: string }>((resolve) =>
        cdp.on('Browser.downloadWillBegin', (e) => resolve(e)),
      );
      // 下载被取消要立即报错（事件里没有原因，浏览器进程的 TMPDIR 含 .. 就会这样），不能空等到超时
      const done = new Promise<{ guid: string }>((resolve, reject) =>
        cdp.on('Browser.downloadProgress', (e) => {
          if (e.state === 'completed') resolve(e);
          else if (e.state === 'canceled') {
            reject(
              new Error(
                `下载被取消（guid ${e.guid}）：常见原因是 TMPDIR 含 ..、下载目录不可写、磁盘已满`,
              ),
            );
          }
        }),
      );
      done.catch(() => {}); // 取消可能发生在 await 之前，先挂上处理，避免未处理的 rejection
      const ob = await observe(env.session, { pageId });
      const link = ob.elements.find((e) => e.role === 'link' && e.name === '下载订单报表（CSV）');
      assert.ok(link, '下载链接在元素表中');

      const r = await act({ op: 'click', pageId, target: { ref: link.ref } });
      assert.equal(r.effects.navigated, false, '下载不是导航');
      assert.ok(r.duration_ms < 3000, `点击下载链接耗时 ${r.duration_ms}`);
      const b = await withTimeout(begin, 10_000, '下载开始');
      const d = await withTimeout(done, 10_000, '下载完成');
      assert.ok(readFileSync(join(dir, d.guid)).equals(Buffer.from(reportCsv(1, 10), 'utf8')));
      assert.match(page(pageId).url(), /\/forms-files\/$/, '页面没有跳走');
      assert.equal(b.suggestedFilename, REPORT_FILENAME_CN);
    } finally {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await cdp.detach().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
