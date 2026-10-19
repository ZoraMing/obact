import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KeyInput, Page } from 'puppeteer-core';
import { ObactError } from '../errors.ts';

/** 等待（只用于轮询间隔与上限，不作为等待策略本身，FR-14）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** 在期限内等 promise；超时返回 fallback（promise 继续在后台，错误被吞掉）。 */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<F>((r) => {
    timer = setTimeout(() => r(fallback), Math.max(0, ms));
  });
  p.catch(() => {});
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把工作区内的相对路径解析为绝对路径；越出根目录（含经符号链接越出）报 path_outside_workspace（FR-35）。
 * mustExist 为 true 时文件必须存在。
 */
export function resolveInside(root: string, path: string, mustExist: boolean): string {
  const base = resolve(root);
  const full = resolve(base, path);
  // 名字以 .. 开头的合法文件（如 ..hidden.txt）不算越界：只有恰好是 .. 或以 ../ 开头才算
  const outside = (p: string, b: string) => {
    const rel = relative(b, p);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  if (outside(full, base)) {
    throw new ObactError('path_outside_workspace', `路径越出工作区：${path}`, { path, root: base });
  }
  if (mustExist && !existsSync(full)) {
    throw new ObactError('invalid_params', `文件不存在：${path}`, { path });
  }
  // 目标不存在（要新建）时也要防符号链接：找最深的已存在祖先做 realpath，悬空链接按指向位置展开
  if (outside(realpathLoose(full), realpathLoose(base))) {
    throw new ObactError('path_outside_workspace', `路径经符号链接越出工作区：${path}`, {
      path,
      root: base,
    });
  }
  return full;
}

/** realpath 的宽松版：路径（或其一部分）不存在时，对最深的已存在祖先取 realpath 再接上剩余部分。 */
function realpathLoose(p: string, depth = 0): string {
  if (depth > 32) throw new ObactError('invalid_params', `符号链接层数过多：${p}`, { path: p });
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      let link: string | undefined;
      try {
        link = readlinkSync(cur);
      } catch {}
      if (link !== undefined)
        return join(realpathLoose(resolve(dirname(cur), link), depth + 1), ...tail);
      const parent = dirname(cur);
      if (parent === cur) throw e;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

const MODIFIERS: Record<string, 'Alt' | 'Control' | 'Meta' | 'Shift'> = {
  alt: 'Alt',
  option: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  shift: 'Shift',
};

/** macOS 上编辑快捷键需要显式带编辑命令，否则 CDP 派发的按键不会触发全选、复制等。 */
const MAC_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
};

export type KeyCombo = {
  modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
  key: KeyInput;
  commands: string[];
};

/**
 * 解析按键组合：Enter、Control+A、Shift+Tab、Control+Shift+K、ControlOrMeta+A（macOS 上为 Meta）。
 * 单个 "+" 键写作 "+" 或 "Control++"。键名同 Puppeteer 的 KeyInput（按 US 键盘布局）。
 */
export function parseKeyCombo(spec: string, knownKey: (k: string) => boolean): KeyCombo {
  const parts =
    spec === '+'
      ? ['+']
      : spec.endsWith('++')
        ? [...spec.slice(0, -2).split('+'), '+']
        : spec.split('+');
  const keyPart = parts.pop() ?? '';
  const mac = process.platform === 'darwin';
  const modifiers: KeyCombo['modifiers'] = [];
  for (const p of parts) {
    const low = p.trim().toLowerCase();
    const m = low === 'controlormeta' ? (mac ? 'Meta' : 'Control') : MODIFIERS[low];
    if (!m)
      throw new ObactError(
        'invalid_params',
        `未知的修饰键：${p}（可用 Alt、Control、Meta、Shift）`,
      );
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  let key = keyPart;
  if (!knownKey(key)) {
    // 常见别名与大小写
    const alias: Record<string, string> = {
      esc: 'Escape',
      return: 'Enter',
      space: ' ',
      del: 'Delete',
      up: 'ArrowUp',
      down: 'ArrowDown',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      pgup: 'PageUp',
      pgdn: 'PageDown',
    };
    const low = key.toLowerCase();
    const cap = low.charAt(0).toUpperCase() + low.slice(1);
    key = alias[low] ?? (knownKey(cap) ? cap : knownKey(low) ? low : key);
  }
  if (!key || !knownKey(key)) {
    throw new ObactError(
      'invalid_params',
      `未知的按键：${keyPart}（键名如 Enter、Tab、ArrowDown、a、F5）`,
      {
        key: spec,
      },
    );
  }
  const commands: string[] = [];
  const letter = key.length === 1 ? key.toLowerCase() : '';
  if (mac && modifiers.length === 1 && modifiers[0] === 'Meta' && MAC_COMMANDS[letter]) {
    commands.push(MAC_COMMANDS[letter] as string);
  }
  return { modifiers, key: key as KeyInput, commands };
}

/** 按下组合键：依次按下修饰键、按主键、倒序抬起修饰键。 */
export async function pressCombo(page: Page, combo: KeyCombo): Promise<void> {
  const kb = page.keyboard;
  const down: string[] = [];
  try {
    for (const m of combo.modifiers) {
      await kb.down(m);
      down.push(m);
    }
    if (combo.commands.length) {
      await kb.down(combo.key, { commands: combo.commands });
      await kb.up(combo.key);
    } else {
      await kb.press(combo.key);
    }
  } finally {
    for (const m of down.reverse()) await kb.up(m as KeyInput).catch(() => {});
  }
}

/**
 * 页面文本前后差异（FR-15，按需）：按行比较，输出 "- 旧行" / "+ 新行"，总长度限制在 limit 字符内。
 * 去掉共同的首尾后，中间部分较小时用最长公共子序列，较大时退化为集合差。
 */
export function textDiff(before: string, after: string, limit = 2000): string {
  const a = before
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const b = after
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const lines: string[] = [];
  if (ma.length * mb.length <= 250_000) {
    const n = ma.length;
    const m = mb.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      const row = dp[i] as number[];
      const next = dp[i + 1] as number[];
      for (let j = m - 1; j >= 0; j--) {
        row[j] =
          ma[i] === mb[j]
            ? (next[j + 1] as number) + 1
            : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        i++;
        j++;
      } else if (
        j < m &&
        (i >= n || ((dp[i] as number[])[j + 1] as number) >= ((dp[i + 1] as number[])[j] as number))
      ) {
        lines.push(`+ ${mb[j++]}`);
      } else {
        lines.push(`- ${ma[i++]}`);
      }
    }
  } else {
    const setA = new Set(ma);
    const setB = new Set(mb);
    for (const l of ma) if (!setB.has(l)) lines.push(`- ${l}`);
    for (const l of mb) if (!setA.has(l)) lines.push(`+ ${l}`);
  }
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > limit) {
      out += '…（差异过长，已截断）';
      break;
    }
    out += (out ? '\n' : '') + l;
  }
  return out;
}
