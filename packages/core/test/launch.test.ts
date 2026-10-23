// launchBrowser 的信号选项：默认由 puppeteer 接管 SIGINT / SIGTERM / SIGHUP（只关浏览器、不退出进程），
// handleSignals: false 时一个都不装，由调用方自己处理。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchBrowser } from '../src/index.ts';
import { CHROME, SKIP } from './helpers.ts';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const counts = () => SIGNALS.map((s) => process.listenerCount(s));

test('handleSignals：缺省保持 puppeteer 的信号处理，false 则不装', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obact-launch-'));
  const before = counts();
  try {
    const open = async (handleSignals?: boolean) => {
      const browser = await launchBrowser({ profileDir: dir, chromePath: CHROME, handleSignals });
      const during = counts();
      await browser.close();
      return during;
    };
    assert.deepEqual(
      await open(),
      before.map((n) => n + 1),
      '缺省：三个信号都被接管',
    );
    assert.deepEqual(await open(false), before, 'false：不装信号处理');
    assert.deepEqual(counts(), before, '关闭浏览器后不留监听');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
