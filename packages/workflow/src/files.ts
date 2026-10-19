// 工作区文件（FR-35）：列出、读、写 workspace/files 下的文件，不能越出该目录（含经符号链接越出）。
// 路径一律相对 workspace/files；{{file:inputs/orders.csv}} 读的就是 workspace/files/inputs/orders.csv。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ObactError } from '@obact/core';
import type { FileEntry } from '@obact/schemas';

export type WorkspaceFiles = {
  /** 列出目录下的直接子项（相对 files 根的路径，'/' 分隔），按名称排序；根目录不存在时为空。 */
  list(dir?: string): FileEntry[];
  /** .csv → 对象数组（值都是字符串），.jsonl → 数组，.json → 值，其他 → 文本。 */
  read(path: string): unknown;
  /** 写文本或二进制，目录自动创建；返回相对路径与字节数。 */
  write(path: string, data: string | Uint8Array): { path: string; size: number };
  /** 校验并返回绝对路径（给上传、下载等需要真实路径的动作用）；mustExist 时文件必须存在。 */
  resolve(path: string, mustExist?: boolean): string;
};

function outside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * 真实路径，允许尾部不存在：取最深的已存在祖先的真实路径再接上不存在的部分；
 * 悬空的符号链接按它指向的位置展开（否则写文件会顺着链接写到工作区外）。
 */
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

/** 文件系统错误转成 ObactError：调用方能处理的（不存在、是目录等）为 invalid_params。 */
function fsFail(path: string, e: unknown): never {
  if (e instanceof ObactError) throw e;
  const code = (e as NodeJS.ErrnoException).code;
  const why: Record<string, string> = {
    ENOENT: '不存在',
    ENOTDIR: '路径中有一段不是目录',
    EISDIR: '是目录',
    ELOOP: '符号链接成环',
  };
  if (code && why[code]) throw new ObactError('invalid_params', `${path}：${why[code]}`, { path });
  throw e;
}

// ---------- 解析 ----------

/**
 * 解析 CSV：首行为表头，返回对象数组，值都是字符串。
 * 支持带引号的字段（内含逗号、换行、"" 转义的引号）、CRLF、UTF-8 BOM、空行；
 * 某行列数与表头不一致、表头重复、引号未闭合都报 invalid_params，不静默丢数据。
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false; // 当前字段带过引号
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const endRow = () => {
    if (cells.length === 0 && field.trim() === '' && !quoted) return; // 空行（含只有空白的行）
    cells.push(field);
    rows.push({ cells, line: rowLine });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '' && !quoted) {
      inQuotes = quoted = true;
    } else if (c === ',') {
      cells.push(field);
      field = '';
      quoted = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
      field = '';
      quoted = false;
      line++;
      rowLine = line;
    } else field += c;
  }
  if (inQuotes) {
    throw new ObactError('invalid_params', `CSV 第 ${rowLine} 行起的引号没有闭合`, {
      line: rowLine,
    });
  }
  endRow();

  const header = rows.shift()?.cells;
  if (!header) return [];
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) {
    throw new ObactError('invalid_params', `CSV 表头重复：${dup === '' ? '（空列名）' : dup}`, {
      column: dup,
    });
  }
  return rows.map((r) => {
    if (r.cells.length !== header.length) {
      throw new ObactError(
        'invalid_params',
        `CSV 第 ${r.line} 行有 ${r.cells.length} 列，表头有 ${header.length} 列`,
        { line: r.line },
      );
    }
    return Object.fromEntries(header.map((h, i) => [h, r.cells[i] as string]));
  });
}

function parseJsonl(text: string, path: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() === '') continue;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      throw new ObactError(
        'invalid_params',
        `${path} 第 ${i + 1} 行不是合法 JSON：${(e as Error).message}`,
        {
          path,
          line: i + 1,
        },
      );
    }
  }
  return out;
}

// ---------- 对外 ----------

export function createFiles(workspace: string): WorkspaceFiles {
  const root = resolve(workspace, 'files');

  const resolvePath = (path: string, mustExist = false): string => {
    if (typeof path !== 'string' || path.includes('\0')) {
      throw new ObactError('invalid_params', '路径不合法', { path });
    }
    const full = resolve(root, path);
    if (outside(root, full)) {
      throw new ObactError('path_outside_workspace', `路径越出工作区：${path}`, { path });
    }
    try {
      if (outside(realpathLoose(root), realpathLoose(full))) {
        throw new ObactError('path_outside_workspace', `路径经符号链接越出工作区：${path}`, {
          path,
        });
      }
    } catch (e) {
      fsFail(path, e);
    }
    if (mustExist && !existsSync(full)) {
      throw new ObactError('invalid_params', `文件不存在：${path}`, { path });
    }
    return full;
  };

  const rel = (full: string): string => relative(root, full).split(sep).join('/');

  return {
    resolve: resolvePath,

    list(dir = '') {
      const full = resolvePath(dir);
      if (!existsSync(full)) {
        if (full === root) return [];
        throw new ObactError('invalid_params', `目录不存在：${dir}`, { path: dir });
      }
      try {
        if (!statSync(full).isDirectory()) {
          throw new ObactError('invalid_params', `不是目录：${dir}`, { path: dir });
        }
        return readdirSync(full)
          .sort()
          .map((name) => {
            const p = join(full, name);
            const st = lstatSync(p);
            const isDir = st.isDirectory();
            return {
              path: rel(p),
              dir: isDir,
              size: isDir ? 0 : st.size,
              mtime: st.mtime.toISOString(),
            };
          });
      } catch (e) {
        return fsFail(dir, e);
      }
    },

    read(path) {
      const full = resolvePath(path, true);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch (e) {
        return fsFail(path, e);
      }
      const ext = extname(full).toLowerCase();
      if (ext !== '.csv' && ext !== '.jsonl' && ext !== '.json') return text;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (ext === '.csv') return parseCsv(text);
      if (ext === '.jsonl') return parseJsonl(text, path);
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ObactError('invalid_params', `${path} 不是合法 JSON：${(e as Error).message}`, {
          path,
        });
      }
    },

    write(path, data) {
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
        throw new ObactError('invalid_params', '写入的内容必须是文本或二进制', { path });
      }
      const full = resolvePath(path);
      try {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, data);
      } catch (e) {
        fsFail(path, e);
      }
      return {
        path: rel(full),
        size: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
      };
    },
  };
}
