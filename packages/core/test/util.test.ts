import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
