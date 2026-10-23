import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type * from './types.ts';

export const SCHEMA_BASE = 'https://obact.local/schemas/v1/';
export const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** 只作注解、不参与校验的自定义关键字：x-result 标注方法返回结构，tsType 供类型生成使用。 */
const ANNOTATION_KEYWORDS = ['x-result', 'tsType'];

export type SchemaDoc = { $id: string; [key: string]: unknown };

export function loadSchemas(dir: string = SCHEMAS_DIR): SchemaDoc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SchemaDoc);
}

/**
 * 契约目标的写法：`observe.json#/$defs/Result`，或简写 `observe.Result`、`action`。
 */
export function schemaUri(target: string): string {
  if (target.includes('#') || target.endsWith('.json')) return SCHEMA_BASE + target;
  const [file, ...defs] = target.split('.');
  const uri = `${SCHEMA_BASE}${file}.json`;
  return defs.length ? `${uri}#/$defs/${defs.join('.')}` : uri;
}

export class Contracts {
  readonly ajv: Ajv2020;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor(schemas: SchemaDoc[] = loadSchemas()) {
    this.ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
      allowUnionTypes: true,
    });
    addFormats.default(this.ajv);
    this.ajv.addVocabulary(ANNOTATION_KEYWORDS);
    for (const s of schemas) this.ajv.addSchema(s);
  }

  validator(target: string): ValidateFunction {
    const uri = schemaUri(target);
    let fn = this.#cache.get(uri);
    if (!fn) {
      fn = this.ajv.getSchema(uri);
      if (!fn) throw new Error(`未知的契约目标：${target}`);
      this.#cache.set(uri, fn);
    }
    return fn;
  }

  /** 校验通过返回 null，否则返回错误列表。 */
  check(target: string, data: unknown): ErrorObject[] | null {
    const fn = this.validator(target);
    return fn(data) ? null : (fn.errors ?? []);
  }

  assert(target: string, data: unknown): void {
    const errors = this.check(target, data);
    if (errors) {
      throw new Error(`不符合契约 ${target}：${this.ajv.errorsText(errors)}`);
    }
  }
}

export type MethodContract = { params: string; result: string };

/** 从 rpc.json 读出 方法名 → 参数与返回结构 的对照表。 */
export function methodTable(schemas: SchemaDoc[] = loadSchemas()): Record<string, MethodContract> {
  const rpc = schemas.find((s) => s.$id === `${SCHEMA_BASE}rpc.json`);
  if (!rpc) throw new Error('缺少 rpc.json');
  const defs = rpc.$defs as Record<string, Record<string, unknown>>;
  const table: Record<string, MethodContract> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (!name.startsWith('Call.')) continue;
    const props = def.properties as { method: { const: string }; params: { $ref: string } };
    table[props.method.const] = { params: props.params.$ref, result: def['x-result'] as string };
  }
  return table;
}
