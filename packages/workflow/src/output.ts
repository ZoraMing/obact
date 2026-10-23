// 采集输出（FR-25，DESIGN 约定 13）：workspace/outputs/<任务>/<日期>/ 下的
//   <名称>.jsonl   实时追加，一行一条，每次追加把完整的行一次写出；
//   <名称>.index   主键索引，一行一个已写入的主键（JSON 字符串，所以主键里有换行也不会串行）；
//   <名称>.csv / .xlsx   导出（UTF-8 BOM 的 CSV；自带最小 ZIP 写入器生成的 xlsx，不引入依赖）。
//
// 续采“不重复、不遗漏”的依据：
//  - 先写数据并 fsync，再写索引。进程在两次写之间被杀时，最坏是“数据有、索引没有”（重复可去，丢失不可恢复，所以顺序不能反）。
//  - 首次带主键追加时先“对账”：从数据文件尾部往前找出没进索引的行，把它们的主键补进索引，再去重。
//  - 每个输出第一次追加时，若数据 / 索引文件末尾是半行（写到一半被杀）：能解析就补换行，否则截掉（它没写完，也就没进索引，续采时会重写）。
// 单写者假设：同一个输出目录同一时刻只有一个进程在追加（运行子进程）；count、导出只读，随时可调用。
// 日期目录由调用方决定（跨午夜续跑要沿用启动时的日期，否则会写到另一个目录、去重失效）。
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ObactError } from '@obact/core';

export type OutputFormat = 'csv' | 'xlsx';

/** 主键：一个字段名，或多个字段名（复合主键）。 */
export type OutputKey = string | string[];

export type AppendResult = { written: number; skipped: number };

export type ExportResult = {
  /** 导出的行数（不含表头）。 */
  rows: number;
  /** 格式 → 文件路径。 */
  files: Partial<Record<OutputFormat, string>>;
  /** 数据被改动的提示（如 xlsx 单元格超长被截断）。 */
  warnings: string[];
};

/** Excel 一张表最多 1,048,576 行（含表头）、16,384 列，单元格文本最多 32,767 个字符。 */
const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLS = 16_384;
const XLSX_MAX_CELL = 32_767;
const CHUNK = 1 << 20;
/** UTF-8 BOM（U+FEFF）。 */
const BOM = String.fromCharCode(0xfeff);

/** 本地时区的 YYYY-MM-DD，作为日期目录名。 */
export function formatDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 文件原语 ----------

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

function readFully(fd: number, buf: Buffer, position: number): number {
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

function openIfExists(file: string, flags: string | number): number | null {
  try {
    return openSync(file, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** 目录项落盘（新建文件、rename 之后）；不支持对目录 fsync 的平台忽略。 */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/** 追加一段（以换行结尾的若干完整行），fsync 后返回。 */
function appendBlock(file: string, dir: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o644);
  try {
    const created = fstatSync(fd).size === 0;
    writeAll(fd, Buffer.from(text));
    fsyncSync(fd);
    if (created) fsyncDir(dir);
  } finally {
    closeSync(fd);
  }
}

/**
 * 逐行读取（按字节找换行，多字节字符不会被切开）。
 * 最后一段没有换行结尾时 terminated 为 false。文件不存在视为空。
 */
function* readLines(file: string): Generator<{ text: string; terminated: boolean }> {
  const fd = openIfExists(file, 'r');
  if (fd === null) return;
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      const view = buf.subarray(0, n);
      let start = 0;
      for (let nl = view.indexOf(0x0a, start); nl !== -1; nl = view.indexOf(0x0a, start)) {
        carry.push(Buffer.from(view.subarray(start, nl)));
        yield { text: Buffer.concat(carry).toString('utf8'), terminated: true };
        carry = [];
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(view.subarray(start)));
    }
    if (carry.length > 0) yield { text: Buffer.concat(carry).toString('utf8'), terminated: false };
  } finally {
    closeSync(fd);
  }
}

/** 从文件尾部往前逐行读取（用于对账，不必读完整个文件）；先产出的是最后一行。 */
function* readLinesReverse(file: string): Generator<string> {
  const fd = openIfExists(file, 'r');
  if (fd === null) return;
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0); // 还没遇到行首的那一段
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      readFully(fd, chunk, pos);
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = data.length;
      while (end > 0) {
        const nl = data.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        yield data.toString('utf8', nl + 1, end);
        end = nl;
      }
      carry = data.subarray(0, end);
    }
    if (carry.length > 0) yield carry.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** 文件末尾不是换行：能解析的补上换行，否则（没写完）截掉。 */
function repairTail(file: string, valid: (text: string) => boolean): void {
  const fd = openIfExists(file, constants.O_RDWR);
  if (fd === null) return;
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    readFully(fd, last, size - 1);
    if (last[0] === 0x0a) return;
    // 往前找最后一个换行，其后就是半行
    let start = 0;
    let pos = size;
    while (pos > 0) {
      const len = Math.min(64 * 1024, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      readFully(fd, chunk, pos);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl !== -1) {
        start = pos + nl + 1;
        break;
      }
    }
    const tail = Buffer.alloc(size - start);
    readFully(fd, tail, start);
    if (valid(tail.toString('utf8'))) writeAll(fd, Buffer.from('\n'));
    else ftruncateSync(fd, start);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 同目录临时文件 → fsync → rename：导出中途失败或被杀，不会留下写了一半的目标文件。 */
function writeFileAtomic(path: string, produce: (write: (chunk: string | Buffer) => void) => void) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
  try {
    let pending: string[] = [];
    let size = 0;
    const flush = () => {
      if (pending.length > 0) writeAll(fd, Buffer.from(pending.join('')));
      pending = [];
      size = 0;
    };
    produce((chunk) => {
      if (typeof chunk === 'string') {
        pending.push(chunk);
        size += chunk.length;
        if (size >= CHUNK) flush();
      } else {
        flush();
        writeAll(fd, chunk);
      }
    });
    flush();
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
    fsyncDir(dirname(path));
  } catch (e) {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// ---------- 行与主键 ----------

type Row = Record<string, unknown>;

function parseRow(text: string): Row | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : null;
  } catch {
    return null;
  }
}

function parseKeyLine(text: string): string | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** 主键字段的值转成字符串；缺失（undefined、null、空串）返回 undefined。数字 1 与字符串 '1' 是同一个主键。 */
function keyPart(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** 一行的主键；任一主键字段缺失返回 undefined。复合主键用 JSON 数组编码，字段值里含任何字符都不会撞。 */
function keyOf(row: Row, fields: string[]): string | undefined {
  if (fields.length === 1) return keyPart(row[fields[0] as string]);
  const parts: string[] = [];
  for (const f of fields) {
    const p = keyPart(row[f]);
    if (p === undefined) return undefined;
    parts.push(p);
  }
  return JSON.stringify(parts);
}

function normalizeKey(key: OutputKey | undefined): string[] | undefined {
  if (key === undefined) return undefined;
  const fields = typeof key === 'string' ? [key] : key;
  if (fields.length === 0 || fields.some((f) => typeof f !== 'string' || f === '')) {
    throw new ObactError(
      'invalid_params',
      `主键必须是字段名或非空的字段名数组：${JSON.stringify(key)}`,
    );
  }
  return fields;
}

/** 目录名 / 文件名片段：不能为空、不能含路径分隔符、不能是 . 或 ..。 */
function segment(label: string, v: unknown): string {
  if (typeof v !== 'string' || v === '' || v === '.' || v === '..' || /[\\/\0]/.test(v)) {
    throw new ObactError('invalid_params', `${label}不是合法的名称：${JSON.stringify(v)}`);
  }
  return v;
}

// ---------- 采集输出 ----------

/** 某个输出在本实例里的追加状态；keys 在第一次带主键追加时才从索引文件读入。 */
type NameState = { keys: Set<string> | null; reconciled: boolean };

export class Output {
  /** workspace/outputs/<任务>/<日期> */
  readonly dir: string;
  readonly #states = new Map<string, NameState>();

  constructor(workspace: string, taskName: string, date: string) {
    this.dir = join(workspace, 'outputs', segment('任务名', taskName), segment('日期', date));
  }

  /** 输出文件路径：<名称>.<后缀>。 */
  file(name: string, ext: 'jsonl' | 'index' | OutputFormat): string {
    return join(this.dir, `${segment('输出名', name)}.${ext}`);
  }

  /**
   * 追加若干行。有 key 时按主键去重（跳过已写入的和本批内重复的），没有 key 时全部写入。
   * 主键字段缺失的行报 invalid_params，且整批都不写（宁可让问题可见，也不悄悄丢行或写出无法去重的行）。
   */
  append(name: string, rows: Row[], opts: { key?: OutputKey } = {}): AppendResult {
    if (!Array.isArray(rows)) throw new ObactError('invalid_params', 'rows 必须是数组');
    const fields = normalizeKey(opts.key);
    const jsonl = this.file(name, 'jsonl');
    const index = this.file(name, 'index');

    const lines: string[] = [];
    const keys: string[] = [];
    let skipped = 0;
    const st = this.#state(name); // 先修复末尾的半行，没有 key 的追加也一样
    const known = fields ? this.#keys(name, st, fields) : undefined;
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new ObactError('invalid_params', `${name}：第 ${i} 行不是对象`);
      }
      let key: string | undefined;
      if (fields && known) {
        key = keyOf(row, fields);
        if (key === undefined) {
          throw new ObactError(
            'invalid_params',
            `${name}：第 ${i} 行缺少主键字段 ${fields.join('、')}（整批未写入）`,
          );
        }
        if (known.has(key) || seen.has(key)) {
          skipped++;
          return;
        }
        seen.add(key);
        keys.push(key);
      }
      try {
        lines.push(JSON.stringify(row));
      } catch (e) {
        throw new ObactError(
          'invalid_params',
          `${name}：第 ${i} 行无法序列化：${(e as Error).message}`,
        );
      }
    });
    if (lines.length === 0) return { written: 0, skipped };

    try {
      mkdirSync(this.dir, { recursive: true });
      appendBlock(jsonl, this.dir, `${lines.join('\n')}\n`); // 先数据
      if (known) appendBlock(index, this.dir, `${keys.map((k) => JSON.stringify(k)).join('\n')}\n`); // 后索引
    } catch (e) {
      this.#states.delete(name); // 文件可能留下半行：下次追加时重新修复并对账
      throw e;
    }
    if (known) for (const k of keys) known.add(k);
    return { written: lines.length, skipped };
  }

  /** 已写入的行数（逐行解析，半行和损坏的行不算）。 */
  count(name: string): number {
    let n = 0;
    for (const _ of this.#rows(name)) n++;
    return n;
  }

  /**
   * 导出为 CSV / xlsx，写到同目录的 <名称>.csv / <名称>.xlsx（覆盖旧文件，原子替换）。
   * 表头是全部行字段的并集（按首次出现顺序）；对象 / 数组的值导出为 JSON 文本。
   * 没有任何数据时导出空文件（CSV 只有 BOM）。
   */
  export(name: string, formats: OutputFormat[]): ExportResult {
    if (!Array.isArray(formats) || formats.length === 0) {
      throw new ObactError('invalid_params', '导出格式不能为空');
    }
    for (const f of formats) {
      if (f !== 'csv' && f !== 'xlsx') {
        throw new ObactError('invalid_params', `不支持的导出格式：${JSON.stringify(f)}`);
      }
    }
    const headers: string[] = [];
    const known = new Set<string>();
    let rows = 0;
    for (const row of this.#rows(name)) {
      rows++;
      for (const k of Object.keys(row)) {
        if (!known.has(k)) {
          known.add(k);
          headers.push(k);
        }
      }
    }
    if (formats.includes('xlsx')) {
      if (rows + 1 > XLSX_MAX_ROWS) {
        throw new ObactError(
          'invalid_params',
          `${name}：${rows} 行（加表头）超过 xlsx 单表上限 ${XLSX_MAX_ROWS} 行，请改用 CSV`,
          { rows, limit: XLSX_MAX_ROWS },
        );
      }
      if (headers.length > XLSX_MAX_COLS) {
        throw new ObactError(
          'invalid_params',
          `${name}：${headers.length} 列超过 xlsx 上限 ${XLSX_MAX_COLS} 列，请改用 CSV`,
          { columns: headers.length, limit: XLSX_MAX_COLS },
        );
      }
    }

    mkdirSync(this.dir, { recursive: true });
    const result: ExportResult = { rows, files: {}, warnings: [] };
    for (const format of new Set(formats)) {
      const path = this.file(name, format);
      if (format === 'csv') {
        writeFileAtomic(path, (write) => this.#writeCsv(name, headers, write));
      } else {
        const { zip, warnings } = this.#buildXlsx(name, headers);
        writeFileAtomic(path, (write) => write(zip));
        result.warnings.push(...warnings);
      }
      result.files[format] = path;
    }
    return result;
  }

  // ---------- 内部 ----------

  *#rows(name: string): Generator<Row> {
    for (const { text } of readLines(this.file(name, 'jsonl'))) {
      const row = parseRow(text);
      if (row) yield row;
    }
  }

  /** 某个输出的追加状态；第一次用到时修复数据文件末尾的半行。 */
  #state(name: string): NameState {
    let st = this.#states.get(name);
    if (!st) {
      repairTail(this.file(name, 'jsonl'), (t) => parseRow(t) !== null);
      st = { keys: null, reconciled: false };
      this.#states.set(name, st);
    }
    return st;
  }

  /** 已写入的主键集合：第一次从索引文件重建（修复索引的半行），并与数据文件对账。 */
  #keys(name: string, st: NameState, fields: string[]): Set<string> {
    const index = this.file(name, 'index');
    if (!st.keys) {
      repairTail(index, (t) => parseKeyLine(t) !== null);
      st.keys = new Set<string>();
      for (const { text } of readLines(index)) {
        const k = parseKeyLine(text.trim());
        if (k !== null) st.keys.add(k);
      }
    }
    if (!st.reconciled) {
      this.#reconcile(this.file(name, 'jsonl'), index, st.keys, fields);
      st.reconciled = true;
    }
    return st.keys;
  }

  /**
   * 数据与索引对账：数据文件尾部、还没进索引的行（上次在“写数据”和“写索引”之间被杀留下的），补进索引。
   * 从尾部往前找，遇到第一个已在索引里的主键就停，正常情况下只读最后一行。
   */
  #reconcile(jsonl: string, index: string, keys: Set<string>, fields: string[]): void {
    const missing: string[] = [];
    for (const text of readLinesReverse(jsonl)) {
      const row = parseRow(text);
      if (!row) continue;
      const key = keyOf(row, fields);
      if (key === undefined) continue;
      if (keys.has(key)) break;
      missing.push(key);
    }
    if (missing.length === 0) return;
    const ordered = [...new Set(missing.reverse())];
    mkdirSync(this.dir, { recursive: true });
    appendBlock(index, this.dir, `${ordered.map((k) => JSON.stringify(k)).join('\n')}\n`);
    for (const k of ordered) keys.add(k);
  }

  #writeCsv(name: string, headers: string[], write: (chunk: string) => void): void {
    write(BOM); // UTF-8 BOM：Excel 直接打开不乱码
    if (headers.length === 0) return;
    write(`${headers.map(csvCell).join(',')}\r\n`);
    for (const row of this.#rows(name)) {
      write(`${headers.map((h) => csvCell(row[h])).join(',')}\r\n`);
    }
  }

  #buildXlsx(name: string, headers: string[]): { zip: Buffer; warnings: string[] } {
    const warnings: string[] = [];
    const parts: Buffer[] = [];
    let chunk = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    chunk += `<worksheet xmlns="${NS_MAIN}"><sheetData>`;
    let truncated = 0;
    const cell = (ref: string, v: unknown): string => {
      const c = xlsxCell(ref, v);
      if (c.truncated) truncated++;
      return c.xml;
    };
    const cols = headers.map((_, i) => colName(i));
    const push = (s: string) => {
      chunk += s;
      if (chunk.length >= CHUNK) {
        parts.push(Buffer.from(chunk));
        chunk = '';
      }
    };
    if (headers.length > 0) {
      push(`<row r="1">${headers.map((h, i) => cell(`${cols[i]}1`, h)).join('')}</row>`);
      let r = 1;
      for (const row of this.#rows(name)) {
        r++;
        push(
          `<row r="${r}">${headers.map((h, i) => cell(`${cols[i]}${r}`, row[h])).join('')}</row>`,
        );
      }
    }
    push('</sheetData></worksheet>');
    parts.push(Buffer.from(chunk));
    if (truncated > 0) {
      warnings.push(
        `${name}：${truncated} 个单元格超过 ${XLSX_MAX_CELL} 个字符，xlsx 中已截断（CSV 不受影响）`,
      );
    }
    return {
      zip: zipStore(xlsxEntries(sheetName(name), Buffer.concat(parts))),
      warnings,
    };
  }
}

// ---------- CSV ----------

/** RFC 4180：含逗号、双引号、换行的字段加引号，引号翻倍；对象 / 数组写 JSON；null 写空。 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// ---------- xlsx ----------

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 0 → A，25 → Z，26 → AA，16383 → XFD。 */
function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/** XML 1.0 不允许的字符（控制字符、孤立代理项、U+FFFE / U+FFFF）。 */
const XML_ILLEGAL = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/**
 * 元素文本转义。非法字符按 OOXML 的 _xHHHH_ 写法保存（Excel 读回原字符），否则 Excel 会报文件损坏；
 * 文本里本来就有的 _xHHHH_ 先转义下划线，避免被误读；回车写成字符引用，XML 解析器才不会把它规范成换行。
 */
function xmlText(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;')
    .replace(
      XML_ILLEGAL,
      (c) => `_x${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}_`,
    );
}

function xmlAttr(s: string): string {
  return xmlText(s).replaceAll('"', '&quot;');
}

/**
 * 单元格：数字用 n，布尔用 b，其余（含对象 / 数组的 JSON 文本）用 inlineStr，null 不写。
 * 绝对值达到 1e15 的数字改存文本：Excel 只保留 15 位有效数字，长编号存成数字会被改写。
 */
function xlsxCell(ref: string, v: unknown): { xml: string; truncated: boolean } {
  if (v === null || v === undefined) return { xml: '', truncated: false };
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e15) {
    return { xml: `<c r="${ref}" t="n"><v>${v}</v></c>`, truncated: false };
  }
  if (typeof v === 'boolean')
    return { xml: `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`, truncated: false };
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const truncated = s.length > XLSX_MAX_CELL;
  if (truncated) s = s.slice(0, XLSX_MAX_CELL);
  return {
    xml: `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(s)}</t></is></c>`,
    truncated,
  };
}

/** 工作表名：不超过 31 个字符，去掉 []:*?/\ 和首尾单引号，空了用 Sheet1。 */
function sheetName(name: string): string {
  const n = name
    .replace(/[[\]:*?/\\]/g, '')
    .replace(/^'+|'+$/g, '')
    .slice(0, 31);
  return n || 'Sheet1';
}

function xlsxEntries(sheet: string, sheetXml: Buffer): { name: string; data: Buffer }[] {
  const text = (s: string) => Buffer.from(XML_HEAD + s);
  return [
    {
      name: '[Content_Types].xml',
      data: text(
        `<Types xmlns="${NS_TYPES}">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: text(
        `<Relationships xmlns="${NS_PKG_REL}">` +
          `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: text(
        `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
          `<sheets><sheet name="${xmlAttr(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        `<Relationships xmlns="${NS_PKG_REL}">` +
          `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
          '</Relationships>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
}

// ---------- 最小 ZIP 写入器（store 方式 + CRC32，无 ZIP64） ----------

/** 固定的 DOS 时间（1980-01-01 00:00），让相同内容得到相同字节。 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

export function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  if (entries.length >= 0xffff) throw new ObactError('invalid_params', 'ZIP 条目过多');
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (data.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new ObactError('invalid_params', `${name}：文件过大（超过 4 GiB），请改用 CSV`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8); // 压缩方式：store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    out.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // 制作版本
    entry.writeUInt16LE(20, 6); // 解压所需版本
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    // 扩展字段、注释、起始磁盘、内外部属性均为 0
    entry.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // 本盘条目数
  end.writeUInt16LE(entries.length, 10); // 总条目数
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, ...central, end]);
}
