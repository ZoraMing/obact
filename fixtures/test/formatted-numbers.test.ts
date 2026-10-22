// 格式化数字夹具（PRD 9.3，FR-09、FR-10）：接口返回原始数值（同一 seed 结果相同），显示值与原始值可按换算函数一一对应。
// 页面显示值与接口原值的对账由 packages/workflow/test/extract.test.ts 经浏览器验证，这里不需要浏览器。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dataFor, formatValue, parseDisplay } from '../api/formatted-numbers.ts';
import { type FixtureServer, startFixtures } from '../server.ts';

describe('格式化数字夹具（FR-09、FR-10）', () => {
  let server: FixtureServer;
  before(async () => {
    server = await startFixtures();
  });
  after(async () => {
    await server?.close();
  });

  test('接口返回原始数值且由 seed 决定；典型写法的显示值与原始值在显示精度内一一对应', async () => {
    const get = async (seed: number) =>
      (await fetch(`${server.base}/api/formatted-numbers/data?seed=${seed}`)).json();
    assert.deepEqual(await get(5), dataFor(5));
    assert.notDeepEqual(await get(5), await get(6));
    assert.equal((await fetch(`${server.base}/api/formatted-numbers/data?seed=x`)).status, 400);

    const shown = [
      [formatValue(1234567.891, 'thousands'), '1,234,567.89'],
      [formatValue(12345, 'cn'), '1.2万'],
      [formatValue(340_123_456, 'cn'), '3.4亿'],
      [formatValue(0.1234, 'percent'), '12.3%'],
    ];
    for (const [got, want] of shown) assert.equal(got, want);
    assert.equal(parseDisplay('abc'), null);
    for (let seed = 1; seed <= 10; seed++) {
      const d = dataFor(seed);
      for (const k of d.kpis) {
        const p = parseDisplay(formatValue(k.value, k.format));
        assert.ok(p, `${seed}/${k.key} 认不出显示值`);
        assert.ok(Math.abs(p.value - k.value) <= p.step / 2 + 1e-9, `${seed}/${k.key}`);
      }
    }
  });
});
