// BW-6 / BW-12 基准脚本的测试：本地模式全部场景通过；BW-6 改版后误点为 0。
//
// 单独运行：node --test bench/test/bw6-12.test.ts（BW-6 约 80 秒，BW-12 约 40 秒）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SKIP } from '../../fixtures/test/helpers.ts';
import { type Bw6Report, run as run6 } from '../bw6.ts';
import { type Bw12Report, run as run12 } from '../bw12.ts';

describe('BW-6 定位可靠性', { skip: SKIP }, () => {
  let out: string;
  let report: Bw6Report;
  before(async () => {
    out = mkdtempSync(join(tmpdir(), 'obact-bw6-test-'));
    report = await run6({ outDir: out, quiet: true });
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('本地：全部场景通过', () => {
    assert.deepEqual(
      report.items
        .filter((i) => i.outcome !== i.expected)
        .map(
          (i) =>
            `${i.group} | ${i.scenario} | ${i.element}：期望 ${i.expected}，实际 ${i.outcome}（${i.detail}）`,
        ),
      [],
    );
    assert.equal(report.pass, true);
  });

  test('改版后误点为 0（改版夹具与 Lab 改版）', () => {
    const redesigned = report.items.filter((i) => i.group === '改版夹具' || i.group === 'Lab 改版');
    assert.ok(redesigned.length > 0);
    assert.deepEqual(
      redesigned.filter((i) => i.outcome === 'wrong').map((i) => `${i.scenario} ${i.element}`),
      [],
    );
    assert.equal(report.summary.wrong, 0);
  });
});

describe('BW-12 视觉观察与坐标动作', { skip: SKIP }, () => {
  let out: string;
  let report: Bw12Report;
  before(async () => {
    out = mkdtempSync(join(tmpdir(), 'obact-bw12-test-'));
    report = await run12({ outDir: out, quiet: true });
  });
  after(() => {
    rmSync(out, { recursive: true, force: true });
  });

  test('本地：全部场景通过', () => {
    assert.deepEqual(report.failures, []);
    assert.equal(report.pass, true);
  });
});
