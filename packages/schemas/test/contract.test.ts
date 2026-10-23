import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Contracts, loadSchemas, methodTable, SCHEMA_BASE, SCHEMAS_DIR } from '../src/index.ts';

const EXAMPLES_DIR = join(SCHEMAS_DIR, '..', 'examples');
const contracts = new Contracts();

/** examples/<目标>/valid-*.json(l) 必须通过，invalid-*.json(l) 必须不通过；.jsonl 逐行校验。 */
function readExamples(file: string): unknown[] {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.jsonl')) return [JSON.parse(text)];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('契约样例', () => {
  for (const target of readdirSync(EXAMPLES_DIR).sort()) {
    for (const file of readdirSync(join(EXAMPLES_DIR, target)).sort()) {
      const expectValid = file.startsWith('valid');
      assert.ok(
        expectValid || file.startsWith('invalid'),
        `样例文件名需以 valid/invalid 开头：${file}`,
      );
      test(`${target}/${file}`, () => {
        readExamples(join(EXAMPLES_DIR, target, file)).forEach((data, i) => {
          const errors = contracts.check(target, data);
          if (expectValid) {
            assert.equal(errors, null, `第 ${i + 1} 条：${contracts.ajv.errorsText(errors)}`);
          } else {
            assert.notEqual(errors, null, `第 ${i + 1} 条应当不通过`);
          }
        });
      });
    }
  }
});

describe('契约完整性', () => {
  const schemas = loadSchemas();

  test('每个 Schema 文件都能编译，且至少有一个通过的样例', () => {
    const targets = readdirSync(EXAMPLES_DIR);
    for (const s of schemas) {
      const file = s.$id.slice(SCHEMA_BASE.length).replace(/\.json$/, '');
      if (file === 'common') continue; // 只有 $defs，由其他文件引用
      assert.ok(
        targets.some((t) => t === file || t.startsWith(`${file}.`)),
        `${file}.json 缺少样例`,
      );
      const defs = Object.keys((s.$defs as object | undefined) ?? {});
      for (const def of defs) contracts.validator(`${file}.json#/$defs/${def}`);
      if (s.type || s.allOf || s.items) contracts.validator(`${file}.json`);
    }
  });

  test('PRD 7.1 的方法都有参数与返回结构', () => {
    const table = methodTable(schemas);
    const prdMethods = [
      'observe',
      'act',
      'act_batch',
      'resolve_locator',
      'list_network_requests',
      'get_network_request',
      'ask_human',
      'files.list',
      'files.read',
      'files.write',
      'run',
      'pause',
      'resume',
      'stop',
      'status',
      'switch_mode',
      'params.get',
      'params.set',
      'task.load',
      'task.evaluate',
    ];
    for (const m of prdMethods) assert.ok(table[m], `缺少方法 ${m}`);
    for (const [m, { params, result }] of Object.entries(table)) {
      assert.ok(contracts.validator(params), `${m} 参数结构无法解析`);
      assert.ok(result && contracts.validator(result), `${m} 返回结构无法解析`);
    }
  });
});
