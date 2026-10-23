// 命令行父进程的预检：确定性的错误（浏览器路径、工作流名、账号名、无显示器的 --headed）直接报错退出，
// 不拉起子进程，更不进重启循环。不需要浏览器：预检失败时根本不会启动它。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 新工作区，里面有一个能通过加载的最小工作流 demo；meta 可覆盖 workflow.json，dir 可改目录名。 */
function workspace(meta: object = {}, dir = 'demo'): string {
  const ws = mkdtempSync(join(tmpdir(), 'obact-precheck-'));
  dirs.push(ws);
  mkdirSync(join(ws, 'workflows', dir), { recursive: true });
  writeFileSync(
    join(ws, 'workflows', dir, 'workflow.json'),
    JSON.stringify({ name: 'demo', ...meta }),
  );
  writeFileSync(join(ws, 'workflows', dir, 'steps.jsonl'), '{"step_id":"s","op":"checkpoint"}\n');
  return ws;
}

/** 跑命令行；环境里的 CHROME_PATH 换成 chrome（缺省是一个存在且可执行的文件），DISPLAY 去掉。 */
function cli(ws: string, args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, CHROME_PATH: process.execPath, ...env };
  delete base.DISPLAY;
  delete base.WAYLAND_DISPLAY;
  return new Promise<{ code: number; err: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    execFile(
      process.execPath,
      [CLI, ...args, '--workspace', ws, '--run-id', 'r'],
      { env: base, timeout: 20_000 },
      (e, _out, err) => resolve({ code: e ? Number(e.code ?? 1) : 0, err, ms: Date.now() - t0 }),
    );
  });
}

describe('run 的预检', () => {
  /** 预检失败：退出码 1，stderr 有原因，没有拉起子进程（没有运行目录），也没有重启。 */
  async function rejected(ws: string, args: string[], why: RegExp, env?: Record<string, string>) {
    const r = await cli(ws, args, env);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, why);
    assert.doesNotMatch(r.err, /子进程崩溃/);
    assert.equal(existsSync(join(ws, 'runs')), false, '没有拉起子进程');
  }

  test('浏览器路径不存在、不是文件、不可执行', async () => {
    const ws = workspace();
    await rejected(ws, ['run', 'demo', '--chrome', join(ws, 'nope')], /浏览器不存在或不可执行/);
    await rejected(ws, ['run', 'demo', '--chrome', ws], /浏览器不存在或不可执行/);
    const plain = join(ws, 'plain');
    writeFileSync(plain, 'x', { mode: 0o644 });
    await rejected(ws, ['run', 'demo'], /浏览器不存在或不可执行/, { CHROME_PATH: plain });
  });

  test('workflow.json 的 name 与目录名不一致', async () => {
    await rejected(workspace({}, 'other'), ['run', 'other'], /目录名与 name 不一致：other \/ demo/);
  });

  test('account 名不合法', async () => {
    await rejected(workspace({ account: '../x' }), ['run', 'demo'], /账号名不合法/);
  });

  test('Linux 上没有显示器时 --headed 报错', { skip: process.platform !== 'linux' }, async () => {
    await rejected(workspace(), ['run', 'demo', '--headed'], /--headed.*DISPLAY/);
  });

  test('工作流名带路径分隔符或 ..', async () => {
    const ws = workspace();
    await rejected(ws, ['run', '../demo'], /工作流名不合法/);
    await rejected(ws, ['run', '..'], /工作流名不合法/);
  });
});
