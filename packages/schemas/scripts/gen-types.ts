// 由 schemas/*.json 生成 src/types.ts。用法：node scripts/gen-types.ts [--check]
// --check：只比较，不写文件；生成结果与仓库中的不一致时退出码为 1（CI 使用）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, type JSONSchema } from 'json-schema-to-typescript';
import { loadSchemas, SCHEMA_BASE, SCHEMAS_DIR } from '../src/index.ts';

const OUT = join(SCHEMAS_DIR, '..', 'src', 'types.ts');
const HEADER =
  '// 本文件由 scripts/gen-types.ts 生成，请勿手改；改动请改 schemas/*.json 后运行 npm run gen:types。\n';

const schemas = loadSchemas();
const byId = new Map(schemas.map((s) => [s.$id, s]));

/** 把跨文件引用解析到本地文件，避免联网。 */
const localResolver = {
  order: 1,
  canRead: (file: { url: string }) => file.url.startsWith(SCHEMA_BASE),
  read: (file: { url: string }) => {
    const doc = byId.get(file.url.split('#')[0] ?? '');
    if (!doc) throw new Error(`未知 Schema：${file.url}`);
    return JSON.stringify(doc);
  },
};

/** 把每个文件的 $defs 提升为具名类型，另生成顶层类型。 */
function entryPoint(): JSONSchema {
  const refs: Record<string, JSONSchema> = {};
  for (const s of schemas) {
    const file = s.$id.slice(SCHEMA_BASE.length).replace(/\.json$/, '');
    const prefix = file
      .split('-')
      .map((p) => p[0]?.toUpperCase() + p.slice(1))
      .join('');
    if (s.type || s.allOf || s.items) refs[prefix] = { $ref: s.$id };
    for (const def of Object.keys((s.$defs as object | undefined) ?? {})) {
      if (def.startsWith('Call.')) continue;
      refs[`${prefix}_${def}`] = { $ref: `${s.$id}#/$defs/${def}` };
    }
  }
  return {
    $id: `${SCHEMA_BASE}__all__.json`,
    title: 'ObactContracts',
    type: 'object',
    properties: refs,
    additionalProperties: false,
  };
}

const raw = await compile(entryPoint(), 'ObactContracts', {
  bannerComment: HEADER,
  cwd: SCHEMAS_DIR,
  declareExternallyReferenced: true,
  unreachableDefinitions: false,
  additionalProperties: false,
  strictIndexSignatures: true,
  format: false,
  $refOptions: { resolve: { obact: localResolver, http: false, file: false } } as never,
});

// 用 biome 统一格式，保证 --check 与 lint 结果一致。
const ts = execFileSync('npx', ['biome', 'format', `--stdin-file-path=${OUT}`], {
  input: raw,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== ts) {
    console.error('src/types.ts 与 schemas 不一致，请运行 npm run gen:types');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, ts);
}
