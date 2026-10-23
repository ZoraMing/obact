// 多页面查询回填（BW-15）：Lab 服务器管理。main 页编辑表单 → 点“参数说明”新开 docs 页 → 读出 memory_limit
// 存成变量 → 关闭 docs → 回 main 填写并保存（单次提交）。再在保存前后各注入一次进程被杀，续跑后仍只提交一次。
// 判据以 Lab 服务端为准：服务器 1 的值、保存请求的次数；再与 side_effects / unverified 对账。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLab, type Lab } from '../../../../lab/src/app.ts';
import auth from '../../../../lab/src/modules/auth.ts';
import servers from '../../../../lab/src/modules/servers.ts';
import { control, SKIP } from '../../../../lab/test/helpers.ts';
import { RunStore } from '../../src/store.ts';
import { cleanup, type Kill, supervised, workspace } from './orders-helpers.ts';

const NAME = 'server-params';
const P = '"pageId":"main"';
const PRE = `"section":"preamble",${P}`;
const STEPS = `
{"step_id":"open","op":"navigate_page",${PRE},"url":"{{param:base}}/login"}
{"step_id":"user","op":"fill",${PRE},"target":{"css":"#username"},"value":"alice"}
{"step_id":"pass","op":"fill",${PRE},"target":{"css":"#password"},"value":"{{param:password}}"}
{"step_id":"login","op":"click",${PRE},"target":{"css":"#login-btn"},"post":[{"url_matches":"/account$"}]}
{"step_id":"redo","op":"checkpoint"}
{"step_id":"edit","op":"navigate_page",${P},"url":"{{param:base}}/servers/1/edit","post":[{"text_present":"内存上限"}]}
{"step_id":"name","op":"fill",${P},"target":{"css":"#name"},"value":"web-01-new"}
{"step_id":"cpu","op":"fill",${P},"target":{"css":"#cpu"},"value":"8"}
{"step_id":"docs","op":"click",${P},"target":{"role":"link","name":"参数说明"},"opens":"docs"}
{"step_id":"lookup","op":"extract","pageId":"docs","as":"doc","source":{"type":"dom","kind":"kv","root":{"css":"#params"}}}
{"step_id":"shut","op":"close_page","pageId":"docs"}
{"step_id":"mem","op":"fill",${P},"target":{"css":"#memory_limit"},"value":"{{var:doc.memory_limit}}"}
{"step_id":"save","op":"click",${P},"target":{"css":"#save"},"once_only":true,"idempotency_key":"server:1","post":[{"text_present":"已保存"}]}
`.trim();

describe('多页面查询回填', { skip: SKIP, timeout: 120_000 }, () => {
  let lab: Lab;
  before(async () => {
    lab = await createLab({ modules: [auth, servers] });
  });
  after(async () => {
    await lab?.close();
    cleanup();
  });

  // [说明, 击杀点, 检查点最终状态, 引擎确认完成, 待核实]
  const cases: [string, Kill[], string, string[], string[]][] = [
    ['不被杀', [], 'DONE', ['server:1'], []],
    [
      '保存前被杀（docs 页已关、值只在内存里）：续跑重新查询并保存',
      [{ at: 'before:mem', nth: 1 }],
      'DONE',
      ['server:1'],
      [],
    ],
    [
      '保存已生效、留痕前被杀：续跑记状态未明，不再提交',
      [{ at: 'sent', nth: 1 }],
      'STOPPED',
      [],
      ['server:1'],
    ],
    [
      '保存留痕后被杀：续跑认作已完成，不再提交',
      [{ at: 'recorded', nth: 1 }],
      'DONE',
      ['server:1'],
      [],
    ],
  ];
  for (const [name, kills, state, done, pending] of cases) {
    test(`BW-15 ${name}`, async () => {
      const space = `mp-${kills[0]?.at.replace(/\W/g, '') ?? 'plain'}`;
      const ws = workspace(NAME, STEPS, { password: 'alice123', base: lab.url(space) });
      assert.equal(await supervised(ws, NAME, kills), state);

      const st = await control(lab, space).state();
      const { servers: list, docs } = st.modules.servers as {
        servers: Record<string, unknown>[];
        docs: { memory_limit: string };
      };
      assert.notEqual(docs.memory_limit, '1024', '文档页的值不同于初始值，必然来自查询回填');
      assert.deepEqual(list[0], {
        id: '1',
        name: 'web-01-new',
        cpu: 8,
        memory_limit: docs.memory_limit,
        note: '',
      });
      const saves = st.submissions.filter((x) => x.op === 'server_save');
      assert.deepEqual(
        saves.map((x) => [(x.payload as { id: string }).id, x.count]),
        [['1', 1]],
        '服务器 1 只收到一次保存请求',
      );
      const store = new RunStore(ws, 'r');
      assert.deepEqual(
        store.listSideEffects().map((x) => x.idempotency_key),
        done,
      );
      assert.deepEqual(
        store.listUnverified().map((x) => [x.idempotency_key, x.reason]),
        pending.map((k) => [k, 'crash']),
      );
    });
  }
});
