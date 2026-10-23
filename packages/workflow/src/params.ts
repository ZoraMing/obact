// 参数库（FR-22）：workspace/params.yaml，按 工作流 → 网站 → 全局 三级查找。
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ObactError } from '@obact/core';
import { Contracts, type ParamsFile } from '@obact/schemas';
import { type Document, parseDocument } from 'yaml';
import { isSensitiveName } from './template.ts';
import type { ParamsStore } from './types.ts';
import { describeContractErrors } from './workflow.ts';

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SECTIONS = ['global', 'sites', 'workflows'] as const;

let contracts: Contracts | null = null;

function own(obj: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof obj !== 'object' || obj === null || !Object.hasOwn(obj, key)) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** 值必须能存成 YAML 与 JSON：不接受 undefined、函数、NaN、Infinity、类实例。 */
function isStorable(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isStorable);
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    return (proto === Object.prototype || proto === null) && Object.values(v).every(isStorable);
  }
  return false;
}

/** 解析并校验 params.yaml 的文本。空文件、只有注释的文件视为空参数库。 */
function parseParams(text: string, file: string): { doc: Document; data: ParamsFile } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ObactError('invalid_params', `参数库解析失败：${file}：${doc.errors[0]?.message}`, {
      file,
    });
  }
  const raw = doc.toJS() ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ObactError(
      'invalid_params',
      `参数库顶层必须是映射（global、sites、workflows）：${file}`,
      {
        file,
      },
    );
  }
  // 写了 `global:` 却没有内容，YAML 解出来是 null：当作空
  for (const k of SECTIONS) if (raw[k] === null) delete raw[k];
  for (const k of ['sites', 'workflows']) {
    const m = raw[k];
    if (typeof m === 'object' && m !== null && !Array.isArray(m)) {
      for (const [name, scope] of Object.entries(m)) if (scope === null) m[name] = {};
    }
  }
  contracts ??= new Contracts();
  const errors = contracts.check('params', raw);
  if (errors) {
    throw new ObactError(
      'invalid_params',
      `参数库不符合契约：${file}：${describeContractErrors(errors).join('；')}`,
      { file },
    );
  }
  return { doc, data: raw as ParamsFile };
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** 同目录临时文件 → fsync → rename；新建的文件只有本人可读写（里面可能有密码）。 */
function atomicWrite(file: string, text: string): void {
  const exists = existsSync(file);
  const target = exists ? realpathSync(file) : file;
  const mode = exists ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/**
 * 加载参数库。get 按 工作流 → 网站 → 全局 查找，找不到返回 undefined（值为 null 算找到）。
 * set 重新读取磁盘上的文件再改，保留注释与其他内容，原子写回。
 */
export function loadParams(workspace: string, workflowName: string, site?: string): ParamsStore {
  const file = join(workspace, 'params.yaml');
  let data = parseParams(readText(file), file).data;

  return {
    get(name) {
      const levels = [
        own(data.workflows, workflowName),
        site === undefined ? undefined : own(data.sites, site),
        data.global,
      ];
      for (const level of levels) {
        if (level && Object.hasOwn(level, name)) return level[name];
      }
      return undefined;
    },

    set(name, value, scope = 'global') {
      if (!NAME.test(name)) {
        throw new ObactError(
          'invalid_params',
          `参数名不合法：${name}（只能含字母、数字、_ . -，最长 64）`,
          {
            name,
          },
        );
      }
      if (!isStorable(value)) {
        throw new ObactError('invalid_params', `参数 ${name} 的值无法存入参数库`, { name });
      }
      let path: string[];
      if (scope === 'global') path = ['global', name];
      else if (scope === 'workflow') path = ['workflows', workflowName, name];
      else if (site !== undefined) path = ['sites', site, name];
      else
        throw new ObactError('invalid_params', `没有指定网站，不能写入网站级参数：${name}`, {
          name,
        });

      const { doc } = parseParams(readText(file), file);
      for (let i = 1; i < path.length; i++) {
        // 已写出但没有内容的层级（`global:`）要先换成空映射
        if (doc.getIn(path.slice(0, i)) === null) doc.setIn(path.slice(0, i), doc.createNode({}));
      }
      doc.setIn(path, value);
      const text = doc.toString();
      const next = parseParams(text, file);
      atomicWrite(file, text);
      data = next.data;
    },

    isSensitive: isSensitiveName,
  };
}
