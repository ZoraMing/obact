// 测试用浏览器的定位与“必须有浏览器”闸门（tools/browser.ts）：只看路径和环境变量，不需要真的浏览器。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Browser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers';
import { BASELINE_VERSION, MISSING, skipIfNoBrowser, testChrome } from '../../../tools/browser.ts';

/** 临时设置环境变量（undefined 表示删除），结束后还原。 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => unknown): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  apply(vars);
  try {
    await fn();
  } finally {
    apply(saved);
  }
}

test('skipIfNoBrowser：有浏览器不跳过；没有则跳过并提示；OBACT_REQUIRE_BROWSER=1 时直接失败', async () => {
  await withEnv({ OBACT_REQUIRE_BROWSER: undefined }, () => {
    assert.equal(skipIfNoBrowser('/x/chrome'), false);
    assert.equal(skipIfNoBrowser(undefined), MISSING);
  });
  await withEnv({ OBACT_REQUIRE_BROWSER: '1' }, () => {
    assert.equal(skipIfNoBrowser('/x/chrome'), false);
    assert.throws(() => skipIfNoBrowser(undefined), /OBACT_REQUIRE_BROWSER=1.*未找到浏览器/);
  });
});

test('testChrome：无头缺 chrome-headless-shell 时不回退到完整 Chrome；有头用完整 Chrome；CHROME_PATH 优先', async () => {
  const platform = detectBrowserPlatform();
  if (!platform) return;
  const cache = mkdtempSync(join(tmpdir(), 'obact-cache-'));
  /** 在临时安装目录里放一个占位文件，路径与 browser:install 装出来的一致。 */
  const place = (browser: Browser) => {
    const p = computeExecutablePath({
      browser,
      buildId: BASELINE_VERSION,
      cacheDir: cache,
      platform,
    });
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '');
    return p;
  };
  try {
    const full = place(Browser.CHROME);
    await withEnv({ CHROME_PATH: undefined, HEADED: undefined }, async () => {
      assert.equal(
        await testChrome(cache),
        undefined,
        '旧缓存只有完整 Chrome：返回 undefined，不回退',
      );
    });
    await withEnv({ CHROME_PATH: undefined, HEADED: '1' }, async () => {
      assert.equal(await testChrome(cache), full, '有头用完整 Chrome');
    });
    const shell = place(Browser.CHROMEHEADLESSSHELL);
    await withEnv({ CHROME_PATH: undefined, HEADED: undefined }, async () => {
      assert.equal(await testChrome(cache), shell, '无头用 chrome-headless-shell');
    });
    await withEnv({ CHROME_PATH: '/x/chrome', HEADED: undefined }, async () => {
      assert.equal(await testChrome(cache), '/x/chrome', 'CHROME_PATH 优先');
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
