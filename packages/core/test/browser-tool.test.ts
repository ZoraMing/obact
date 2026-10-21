// 测试用浏览器的定位与“必须有浏览器”闸门（tools/browser.ts）：只看路径和环境变量，不需要真的浏览器。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISSING, skipIfNoBrowser } from '../../../tools/browser.ts';

/** 临时设置环境变量（undefined 表示删除），结束后还原。 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

test('skipIfNoBrowser：有浏览器不跳过；没有则跳过并提示；OBACT_REQUIRE_BROWSER=1 时直接失败', () => {
  withEnv({ OBACT_REQUIRE_BROWSER: undefined }, () => {
    assert.equal(skipIfNoBrowser('/x/chrome'), false);
    assert.equal(skipIfNoBrowser(undefined), MISSING);
  });
  withEnv({ OBACT_REQUIRE_BROWSER: '1' }, () => {
    assert.equal(skipIfNoBrowser('/x/chrome'), false);
    assert.throws(() => skipIfNoBrowser(undefined), /OBACT_REQUIRE_BROWSER=1.*未找到浏览器/);
  });
});
