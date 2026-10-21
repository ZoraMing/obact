import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveInside } from '../src/act/util.ts';

test('resolveInside：名字以 .. 开头的文件合法；经符号链接写到工作区外（含目标不存在）被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'obact-ri-'));
  const outside = mkdtempSync(join(tmpdir(), 'obact-ri-out-'));
  writeFileSync(join(root, '..hidden.txt'), 'x');
  assert.equal(resolveInside(root, '..hidden.txt', true), join(root, '..hidden.txt'));
  assert.throws(() => resolveInside(root, '../x', false), { code: 'path_outside_workspace' });
  symlinkSync(outside, join(root, 'link'));
  mkdirSync(join(root, 'ok'));
  assert.throws(() => resolveInside(root, 'link/new.png', false), {
    code: 'path_outside_workspace',
  });
  assert.equal(resolveInside(root, 'ok/new.png', false), join(root, 'ok', 'new.png'));
});

test('resolveInside：绝对路径、a/../..、指向外部文件的符号链接、悬空链接都被拒绝，工作区内的绝对路径放行', () => {
  const root = mkdtempSync(join(tmpdir(), 'obact-ri-'));
  const outside = mkdtempSync(join(tmpdir(), 'obact-ri-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'x');
    writeFileSync(join(root, 'in.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link'));
    symlinkSync(join(outside, 'nowhere.png'), join(root, 'dangling.png'));
    const bad: [string, boolean][] = [
      [join(outside, 'secret.txt'), true],
      [join(outside, 'new.png'), false],
      ['a/../../out/x', false],
      ['file-link', true],
      ['file-link', false],
      ['dangling.png', false],
    ];
    for (const [path, mustExist] of bad) {
      assert.throws(
        () => resolveInside(root, path, mustExist),
        { code: 'path_outside_workspace' },
        path,
      );
    }
    // 悬空链接要求文件存在时按“文件不存在”报，不会放行
    assert.throws(() => resolveInside(root, 'dangling.png', true), { code: 'invalid_params' });
    assert.equal(resolveInside(root, join(root, 'in.txt'), true), join(root, 'in.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
