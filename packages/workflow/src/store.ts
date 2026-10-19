// 运行目录存储（FR-17、FR-18、FR-26，PRD 7.5 / 7.6）：workspace/runs/<run_id>/ 下的
// checkpoint.json、side_effects.jsonl、unverified.jsonl、steps.log、trajectory.jsonl 和 shots/。
//
// 崩溃安全的依据（C-1 的存储层）：
//  - 检查点：同目录临时文件 → fsync 文件 → rename → fsync 目录。任何时刻 checkpoint.json 要么是完整的旧版本，
//    要么是完整的新版本；半写的只会是临时文件，读取时忽略并清理。
//  - 追加类文件（*.jsonl、steps.log）：每次把“完整的一行（含换行）”一次 write 出去，O_APPEND，
//    side_effects / unverified 再 fsync。进程被 SIGKILL 时最坏是末尾留下不完整的一行（大块写入被打断）：
//    读取时把“没有换行结尾且解析不了”的末行忽略；下一次追加前发现文件不以换行结尾，先补一个换行，
//    使残片自成一行（读取时因解析失败被跳过），新记录不会接在残片后面而一起损坏。
//  - 单写者假设：同一个运行目录同一时刻只有一个进程写（运行子进程）；别的进程（命令行 status、监督进程）可以读，
//    也可以在运行停止后写（如 resolveUnverified）。索引按文件增量刷新，所以跨进程追加也能看到。
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ObactError } from '@obact/core';
import {
  type Checkpoint,
  Contracts,
  type SideEffectRecord,
  type TrajectoryRecord,
  type UnverifiedRecord,
} from '@obact/schemas';
import { redact } from './template.ts';

// ---------- 契约校验 ----------

let contracts: Contracts | null = null;

/**
 * 按契约校验，返回“实际会落盘的形态”（经 JSON 往返：去掉 undefined 等）。
 * 不符合契约或无法序列化时抛 invalid_params。
 */
function validate(target: string, value: unknown): unknown {
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(value));
  } catch (e) {
    throw new ObactError('invalid_params', `${target}：无法序列化：${(e as Error).message}`);
  }
  contracts ??= new Contracts();
  const errors = contracts.check(target, plain);
  if (errors) {
    throw new ObactError(
      'invalid_params',
      `${target} 不符合契约：${contracts.ajv.errorsText(errors)}`,
    );
  }
  return plain;
}

/** 读取用的校验：通过返回原值，否则 null。 */
function accepts<T>(target: string, value: unknown): T | null {
  contracts ??= new Contracts();
  return contracts.check(target, value) ? null : (value as T);
}

// ---------- 文件原语 ----------

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** 目录项落盘（rename、新建文件之后）；Windows 等不支持对目录 fsync 的平台忽略。 */
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

/**
 * 追加一行：一次 write 出去完整的“[补换行]行内容\n”。durable 时 fsync（新建文件时再 fsync 目录）。
 * 行内容里不能有换行（JSON.stringify 的结果天然满足）。
 */
function appendLine(file: string, line: string, durable: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o644);
  try {
    const { size } = fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      // 上次写到一半被打断（SIGKILL、磁盘满）时末尾没有换行：先补上，残片自成一行
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) prefix = '\n';
    }
    writeAll(fd, Buffer.from(`${prefix}${line}\n`));
    if (durable) {
      fsyncSync(fd);
      if (size === 0) fsyncDir(dirname(file));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 从文件尾部往前找最后一条能通过 accept 的记录（用于恢复序号，不必读完整个文件）。
 * 一条记录可能很长（带抽取数据的轨迹），所以窗口不够就放大重读。
 */
function lastRecord<T>(file: string, accept: (v: unknown) => T | null): T | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    let span = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - span);
      const buf = Buffer.alloc(size - start);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, start + got);
        if (n === 0) break;
        got += n;
      }
      const lines = buf.toString('utf8', 0, got).split('\n');
      if (start > 0) lines.shift(); // 窗口起点可能落在一行中间
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = (lines[i] as string).trim();
        if (!t) continue;
        try {
          const rec = accept(JSON.parse(t));
          if (rec) return rec;
        } catch {}
      }
      if (start === 0) return undefined;
      span *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 按键索引的 JSONL 表：构造时为空，refresh() 从上次读到的位置增量读取新增的完整行。
 * 文件变短（被截断、重建）时整表重建。解析失败或不符合契约的行跳过。
 * 末尾没有换行的一行：能解析就算数（写到换行前被打断），否则不前进，留待下次再看（也许对方还在写）。
 */
class JsonlTable<T> {
  readonly #file: string;
  readonly #accept: (v: unknown) => T | null;
  readonly #key: (r: T) => string;
  /** 同一个键再次出现时怎么合并：返回要保留的记录。 */
  readonly #merge: (old: T | undefined, next: T) => T;
  readonly #map = new Map<string, T>();
  #offset = 0;

  constructor(
    file: string,
    accept: (v: unknown) => T | null,
    key: (r: T) => string,
    merge: (old: T | undefined, next: T) => T,
  ) {
    this.#file = file;
    this.#accept = accept;
    this.#key = key;
    this.#merge = merge;
  }

  has(key: string): boolean {
    this.refresh();
    return this.#map.has(key);
  }

  get(key: string): T | undefined {
    this.refresh();
    return this.#map.get(key);
  }

  /** 按键第一次出现的顺序。 */
  values(): T[] {
    this.refresh();
    return [...this.#map.values()];
  }

  refresh(): void {
    let fd: number;
    try {
      fd = openSync(this.#file, 'r');
    } catch {
      this.#offset = 0;
      this.#map.clear();
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.#offset) {
        this.#offset = 0;
        this.#map.clear();
      }
      if (size === this.#offset) return;
      const buf = Buffer.alloc(size - this.#offset);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, this.#offset + got);
        if (n === 0) break;
        got += n;
      }
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1 || nl >= got) break;
        this.#ingest(buf.toString('utf8', start, nl));
        start = nl + 1;
      }
      let consumed = start;
      if (start < got && this.#ingest(buf.toString('utf8', start, got))) consumed = got;
      this.#offset += consumed;
    } finally {
      closeSync(fd);
    }
  }

  #ingest(line: string): boolean {
    const t = line.trim();
    if (!t) return false;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return false;
    }
    const rec = this.#accept(v);
    if (!rec) return false;
    const k = this.#key(rec);
    this.#map.set(k, this.#merge(this.#map.get(k), rec));
    return true;
  }
}

// ---------- 命名 ----------

const RUN_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** 检查点临时文件：checkpoint.json.<pid>.<序号>.tmp */
const TMP_NAME = /^checkpoint\.json\.(\d+)\.\d+\.tmp$/;
/** 临时文件即使属主进程“还活着”（进程号可能被复用），超过这个时间也当作遗留清掉。 */
const TMP_STALE_MS = 60 * 60 * 1000;
let tmpCounter = 0;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 截图文件名：只留字母数字与 _.-，其余换成 _（路径分隔符、冒号等），不能以点开头，不超过 200 字节。 */
function safeShotName(name: string): string {
  const s = name.replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/^\.+/, '_') || '_';
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out) + Buffer.byteLength(ch) > 200) break;
    out += ch;
  }
  return out;
}

function now(): string {
  return new Date().toISOString();
}

// ---------- 对外类型 ----------

/** 追加成功记录：run_id、time 缺省时由存储补上。 */
export type SideEffectInput = Omit<SideEffectRecord, 'run_id' | 'time'> & {
  run_id?: string;
  time?: string;
};
/** 追加待核实记录：run_id、time 缺省时由存储补上；resolution 只能经 resolveUnverified 写入。 */
export type UnverifiedInput = Omit<UnverifiedRecord, 'run_id' | 'time' | 'resolution'> & {
  run_id?: string;
  time?: string;
};
/** 追加轨迹：seq 由存储分配（续跑后接着上次的往下编），run_id、time 缺省时补上。 */
export type TrajectoryInput = Omit<TrajectoryRecord, 'run_id' | 'seq' | 'time'> & {
  run_id?: string;
  time?: string;
};

// ---------- RunStore ----------

export class RunStore {
  readonly runId: string;
  readonly workspace: string;
  /** workspace/runs/<run_id>，第一次写入时才创建。 */
  readonly dir: string;
  readonly checkpointPath: string;
  readonly sideEffectsPath: string;
  readonly unverifiedPath: string;
  readonly stepsLogPath: string;
  readonly trajectoryPath: string;
  readonly shotsDir: string;

  /** 已写入的最大检查点序号；null：还没从磁盘取。 */
  #seq: number | null = null;
  #trajSeq: number | null = null;
  #tmpCleaned = false;
  readonly #sideEffects: JsonlTable<SideEffectRecord>;
  /** 同一幂等键以最后一行为准（resolve 追加新行），位置仍是该键第一次出现的位置。 */
  readonly #unverified: JsonlTable<UnverifiedRecord>;

  constructor(workspace: string, runId: string) {
    if (!RUN_ID.test(runId) || runId === '.' || runId === '..') {
      throw new ObactError('invalid_params', `run_id 不合法：${runId}`, { run_id: runId });
    }
    this.runId = runId;
    this.workspace = resolve(workspace);
    this.dir = join(this.workspace, 'runs', runId);
    this.checkpointPath = join(this.dir, 'checkpoint.json');
    this.sideEffectsPath = join(this.dir, 'side_effects.jsonl');
    this.unverifiedPath = join(this.dir, 'unverified.jsonl');
    this.stepsLogPath = join(this.dir, 'steps.log');
    this.trajectoryPath = join(this.dir, 'trajectory.jsonl');
    this.shotsDir = join(this.dir, 'shots');
    // 打开已有文件时在这里就重建索引
    this.#sideEffects = new JsonlTable(
      this.sideEffectsPath,
      (v) => accepts<SideEffectRecord>('side-effect', v),
      (r) => r.idempotency_key,
      (old, next) => old ?? next,
    );
    this.#unverified = new JsonlTable(
      this.unverifiedPath,
      (v) => accepts<UnverifiedRecord>('unverified', v),
      (r) => r.idempotency_key,
      (_old, next) => next,
    );
    this.#sideEffects.refresh();
    this.#unverified.refresh();
  }

  // ----- 检查点 -----

  /**
   * 原子写检查点，返回实际写入的内容。seq 由存储维护（上一次的 +1，续跑后接着磁盘上的往下编，
   * 调用方传入的 seq 与 updated_at 被覆盖）；写前按契约校验，不符合抛 invalid_params 且不动旧文件。
   * vars、cursor 里名称含 password|token|secret 的值再做一道防御性脱敏（调用方本不该放进来）。
   */
  writeCheckpoint(cp: Checkpoint): Checkpoint {
    if (cp.run_id !== this.runId) {
      throw new ObactError('invalid_params', `检查点的 run_id（${cp.run_id}）与运行目录不符`, {
        run_id: this.runId,
      });
    }
    if (this.#seq === null) this.#seq = this.#readFile()?.seq ?? 0;
    const next: Checkpoint = { ...cp, seq: this.#seq + 1, updated_at: now() };
    if (cp.vars) next.vars = redact(cp.vars) as NonNullable<Checkpoint['vars']>;
    if (cp.cursor) next.cursor = redact(cp.cursor) as NonNullable<Checkpoint['cursor']>;
    const plain = validate('checkpoint', next) as Checkpoint;

    mkdirSync(this.dir, { recursive: true });
    if (!this.#tmpCleaned) this.#cleanTmp();
    const tmp = `${this.checkpointPath}.${process.pid}.${++tmpCounter}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o644);
      writeAll(fd, Buffer.from(`${JSON.stringify(plain, null, 2)}\n`));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.checkpointPath);
    } catch (e) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }
    fsyncDir(this.dir);
    this.#seq = plain.seq ?? this.#seq + 1;
    return plain;
  }

  /** 读取并校验检查点；不存在、损坏或不符合契约返回 null。顺带清理崩溃遗留的临时文件。 */
  readCheckpoint(): Checkpoint | null {
    this.#cleanTmp();
    const cp = this.#readFile();
    if (cp && this.#seq !== null) this.#seq = Math.max(this.#seq, cp.seq ?? 0);
    return cp;
  }

  #readFile(): Checkpoint | null {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(this.checkpointPath, 'utf8'));
    } catch {
      return null;
    }
    const cp = accepts<Checkpoint>('checkpoint', v);
    return cp && cp.run_id === this.runId ? cp : null;
  }

  /**
   * 清理崩溃时写到一半的临时文件。属主进程还活着的不动（可能是别的进程正在写），
   * 自己进程的、属主已死的、或超过 1 小时的删除。每个实例只在第一次写入时扫一次，读取时每次扫。
   */
  #cleanTmp(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = TMP_NAME.exec(name);
      if (!m) continue;
      const file = join(this.dir, name);
      const pid = Number(m[1]);
      try {
        const stale =
          pid === process.pid ||
          !pidAlive(pid) ||
          Date.now() - statSync(file).mtimeMs > TMP_STALE_MS;
        if (stale) unlinkSync(file);
      } catch {}
    }
    this.#tmpCleaned = true;
  }

  // ----- 单次提交：成功记录 -----

  /**
   * 追加一条已确认成功的单次提交（FR-18）。同一幂等键已有记录时不重复写，返回 false。
   * 追加后 fsync：写成功返回之后，续跑一定能看到它。
   */
  recordSideEffect(rec: SideEffectInput): boolean {
    const full = { ...rec, run_id: rec.run_id ?? this.runId, time: rec.time ?? now() };
    this.#ownRun(full.run_id);
    const plain = validate('side-effect', full) as SideEffectRecord;
    if (this.#sideEffects.has(plain.idempotency_key)) return false;
    appendLine(this.sideEffectsPath, JSON.stringify(plain), true);
    this.#sideEffects.refresh();
    return true;
  }

  /** 这个幂等键是否已有成功记录（续跑时据此跳过）。 */
  hasSideEffect(key: string): boolean {
    return this.#sideEffects.has(key);
  }

  listSideEffects(): SideEffectRecord[] {
    return this.#sideEffects.values();
  }

  // ----- 单次提交：待核实清单 -----

  /**
   * 追加一条“状态未明”记录（FR-18）。同一幂等键已有未核实的记录时不重复写，返回 false；
   * 已核实过的键（比如判定为没做成、重做后又状态未明）则追加新行，重新变成未核实。
   */
  recordUnverified(rec: UnverifiedInput): boolean {
    const full = { ...rec, run_id: rec.run_id ?? this.runId, time: rec.time ?? now() };
    this.#ownRun(full.run_id);
    const plain = validate('unverified', full) as UnverifiedRecord;
    const old = this.#unverified.get(plain.idempotency_key);
    if (old && !old.resolution) return false;
    appendLine(this.unverifiedPath, JSON.stringify(plain), true);
    this.#unverified.refresh();
    return true;
  }

  /** 待核实清单（每个幂等键取最后一行），顺序为各键第一次出现的顺序。unresolved：只要还没核实的。 */
  listUnverified(opts: { unresolved?: boolean } = {}): UnverifiedRecord[] {
    const all = this.#unverified.values();
    return opts.unresolved ? all.filter((r) => !r.resolution) : all;
  }

  getUnverified(key: string): UnverifiedRecord | undefined {
    return this.#unverified.get(key);
  }

  /**
   * 人工核实。做法：**追加**一行（原记录 + resolution），同键以最后一行为准；文件始终只追加，
   * 崩溃时不会丢历史，也不需要重写。
   *  - done：先写成功记录（side_effects.jsonl），再写核实结果。顺序不能反：反过来的话，
   *    两步之间崩溃会留下“已核实为完成却没有成功记录”，续跑时就会把这一步再做一遍。
   *  - not_done：只写核实结果，之后续跑可以重做这一步。
   *  - 已核实为 done 的不能改成 not_done（成功记录已经生效，文件只追加，撤不回）；
   *    not_done 可以改成 done；同结论重复核实原样返回。
   * 键不存在抛 invalid_params。
   */
  resolveUnverified(
    key: string,
    resolution: { outcome: 'done' | 'not_done'; note?: string },
  ): UnverifiedRecord {
    const old = this.#unverified.get(key);
    if (!old) {
      throw new ObactError('invalid_params', `待核实清单里没有幂等键：${key}`, {
        idempotency_key: key,
      });
    }
    if (old.resolution) {
      if (old.resolution.outcome === resolution.outcome) return old;
      if (old.resolution.outcome === 'done') {
        throw new ObactError(
          'invalid_params',
          `幂等键 ${key} 已核实为已完成并记入成功记录，不能再改成未完成`,
          { idempotency_key: key },
        );
      }
    }
    const time = now();
    const next = validate('unverified', {
      ...old,
      resolution: {
        outcome: resolution.outcome,
        time,
        ...(resolution.note !== undefined ? { note: resolution.note } : {}),
      },
    }) as UnverifiedRecord;
    if (resolution.outcome === 'done') {
      this.recordSideEffect({ step_id: old.step_id, idempotency_key: key, time });
    }
    appendLine(this.unverifiedPath, JSON.stringify(next), true);
    this.#unverified.refresh();
    return next;
  }

  // ----- 留痕 -----

  /**
   * 追加 steps.log 的一行（FR-26）。敏感值由调用方先脱敏；内部的换行写成 \n 两个字符，保证一步一行。
   * 不 fsync（进程被杀不丢数据；断电可能丢最后几行，不影响续跑）。
   */
  appendStepLog(line: string): void {
    appendLine(this.stepsLogPath, line.replace(/\r\n|\r|\n/g, '\\n'), false);
  }

  /**
   * 追加 trajectory.jsonl 的一行，按契约 trajectory.json 校验（不符合抛 invalid_params，什么都不写）。
   * seq 由存储分配：从 1 起，续跑后接着文件里最后一条往下编。返回实际写入的记录。
   * 不 fsync；敏感值由调用方脱敏。
   */
  appendTrajectory(entry: TrajectoryInput): TrajectoryRecord {
    if (this.#trajSeq === null) {
      this.#trajSeq =
        lastRecord(this.trajectoryPath, (v) => accepts<TrajectoryRecord>('trajectory', v))?.seq ??
        0;
    }
    const full = {
      ...entry,
      run_id: entry.run_id ?? this.runId,
      seq: this.#trajSeq + 1,
      time: entry.time ?? now(),
    };
    this.#ownRun(full.run_id);
    const plain = validate('trajectory', full) as TrajectoryRecord;
    appendLine(this.trajectoryPath, JSON.stringify(plain), false);
    this.#trajSeq = plain.seq;
    return plain;
  }

  // ----- 截图 -----

  /**
   * 截图文件路径（绝对路径）：runs/<run_id>/shots/<name>.webp，目录自动创建。name 里不是字母数字或 _.- 的字符换成 _，
   * 所以不会写到 shots 之外。keep 为真时放进 shots/keep/，不受 pruneShots 的数量上限约束
   * （失败现场、人工接管现场按 FR-26 要保留）。
   */
  shotPath(name: string, opts: { keep?: boolean } = {}): string {
    const dir = opts.keep ? join(this.shotsDir, 'keep') : this.shotsDir;
    mkdirSync(dir, { recursive: true });
    return join(dir, `${safeShotName(name)}.webp`);
  }

  /**
   * 只保留最近的 max 张普通截图（按修改时间，相同时按文件名），删除其余，返回删除的张数。
   * 不计入也不删除：shots/keep/ 里的，以及被待核实记录的 screenshot 引用的（那是人工核实的依据）。
   */
  pruneShots(max = 200): number {
    if (!Number.isInteger(max) || max < 0) {
      throw new ObactError('invalid_params', `max 必须是非负整数：${max}`);
    }
    let names: string[];
    try {
      names = readdirSync(this.shotsDir);
    } catch {
      return 0;
    }
    const referenced = new Set<string>();
    for (const r of this.#unverified.values()) {
      if (r.screenshot) referenced.add(resolve(this.workspace, r.screenshot));
    }
    const shots: { file: string; name: string; mtime: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.webp')) continue;
      const file = join(this.shotsDir, name);
      if (referenced.has(file)) continue;
      try {
        const st = statSync(file);
        if (st.isFile()) shots.push({ file, name, mtime: st.mtimeMs });
      } catch {}
    }
    shots.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    let removed = 0;
    for (const s of shots.slice(max)) {
      try {
        unlinkSync(s.file);
        removed++;
      } catch {}
    }
    return removed;
  }

  #ownRun(runId: string): void {
    if (runId !== this.runId) {
      throw new ObactError('invalid_params', `记录的 run_id（${runId}）与运行目录不符`, {
        run_id: this.runId,
      });
    }
  }
}
