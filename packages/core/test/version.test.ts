// 运行时浏览器版本检测（PRD 8.3）：141 及以上 ok，低于 141 只警告。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkBrowserVersion, judgeBrowserVersion, MIN_BROWSER_MAJOR } from '../src/index.ts';
import { SKIP, setup, type TestEnv } from './helpers.ts';

describe('浏览器版本检测（PRD 8.3）', () => {
  test('按产品串判断：低于 141 或认不出版本号给警告，141 及以上无警告', () => {
    assert.deepEqual(judgeBrowserVersion('HeadlessChrome/141.0.7390.122'), {
      product: 'HeadlessChrome/141.0.7390.122',
      major: 141,
      ok: true,
    });
    assert.equal(judgeBrowserVersion('Chrome/150.0.1.2').ok, true);
    for (const product of ['Chrome/140.0.7339.80', 'Chromium/98.0.4758.102', 'Firefox', '']) {
      const v = judgeBrowserVersion(product);
      assert.equal(v.ok, false, product);
      assert.match(v.warning ?? '', /未经验证/, product);
    }
  });

  describe('真实浏览器', { skip: SKIP }, () => {
    let env: TestEnv;
    before(async () => {
      env = await setup();
    });
    after(async () => {
      await env?.close();
    });

    test('测试用的基准浏览器在已验证区间内', async () => {
      const v = await checkBrowserVersion(env.browser);
      assert.equal(v.ok, true, v.warning);
      assert.ok(v.major >= MIN_BROWSER_MAJOR);
      assert.equal(v.warning, undefined);
    });
  });
});
