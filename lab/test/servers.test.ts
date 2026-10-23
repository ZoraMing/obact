// Lab 服务器管理（BW-15 的前提）：编辑表单与文档页、提交的幂等键、提交超时但已落库、新标签页取值回填。
// 只装配 auth 与 servers 两个模块。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import auth from '../src/modules/auth.ts';
import servers from '../src/modules/servers.ts';
import { control, type LabEnv, type LabState, loginCookie, SKIP, setup } from './helpers.ts';

type ServersState = { servers: Record<string, unknown>[]; docs: { memory_limit: string } };
const serversOf = (s: LabState) => s.modules.servers as ServersState;
const saves = (s: LabState) => s.submissions.filter((x) => x.op === 'server_save');
const counts = (s: LabState) => saves(s).map((x) => x.count);

describe('服务器管理', { skip: SKIP }, () => {
  let env: LabEnv;
  before(async () => {
    env = await setup({ modules: [auth, servers] });
  });
  after(async () => {
    await env?.close();
  });

  /** 登录（HTTP）后的请求助手：页面文本、保存接口（signal 用来模拟客户端超时）。 */
  async function http(space: string) {
    const headers = { cookie: await loginCookie(env.lab, space) };
    const url = (path: string) => `${env.lab.url(space)}${path}`;
    return {
      c: control(env.lab, space),
      html: async (path: string) => (await fetch(url(path), { headers })).text(),
      save: (id: string, body: unknown, signal?: AbortSignal) =>
        fetch(url(`/api/servers/${id}`), {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
    };
  }
  const input = { name: 'db-02', cpu: '8', memory_limit: '4096', note: 'a' };

  test('编辑表单有四个字段和新标签页打开的“参数说明”链接；文档页键值里的 memory_limit 由种子决定，且不等于初始值', async () => {
    const space = 'sv-pages';
    const { c, html } = await http(space);
    const form = await html('/servers/1/edit');
    assert.match(form, /id="name"[\s\S]*id="cpu"[\s\S]*id="memory_limit"[\s\S]*id="note"/);
    assert.ok(form.includes(`href="/s/${space}/servers/docs/params" target="_blank">参数说明</a>`));

    const docs = await html('/servers/docs/params');
    const value = /<dt>memory_limit<\/dt><dd>(\d+)<\/dd>/.exec(docs)?.[1];
    const st = serversOf(await c.state());
    assert.equal(value, st.docs.memory_limit);
    assert.ok(st.servers.every((s) => s.memory_limit !== value));
    const docsAt = async (seed: number) => {
      await c.reset(seed);
      return serversOf(await c.state()).docs.memory_limit;
    };
    assert.equal(await docsAt(1), await docsAt(1), '同一个种子的值不变');
    assert.notEqual(await docsAt(1), await docsAt(2), '换种子值可以变（录制的工作流不能写死）');
  });

  test('提交幂等：同一个键再次提交只计数、不重复写入；校验不过回 400 且不记录', async () => {
    const { c, save } = await http('sv-idem');
    assert.equal((await save('2', { ...input, key: 'k1' })).status, 200);
    const again = await save('2', { ...input, note: 'b', key: 'k1' });
    assert.equal(((await again.json()) as { duplicate: boolean }).duplicate, true);
    const st = await c.state();
    assert.deepEqual(serversOf(st).servers[1], { id: '2', ...input, cpu: 8 });
    assert.deepEqual([counts(st), saves(st)[0]?.conflict], [[2], true]);
    for (const bad of [{ cpu: '0' }, { memory_limit: '4G' }, { name: '' }]) {
      const r = await save('2', { ...input, ...bad, key: 'k2' });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(counts(await c.state()), [2], '校验不过的没有记录');
  });

  test('提交超时但已落库：客户端等不到响应，服务端已写入并记录；沿用同一个键重试只计数', async () => {
    const { c, save } = await http('sv-timeout');
    await c.faults({ commit_timeout: true });
    await assert.rejects(save('3', { ...input, key: 'k-t' }, AbortSignal.timeout(500)));
    const st = await c.state();
    assert.equal(serversOf(st).servers[2]?.memory_limit, '4096', '已落库');
    assert.deepEqual(counts(st), [1]);
    await c.faults({ commit_timeout: false });
    assert.equal((await save('3', { ...input, key: 'k-t' })).status, 200);
    assert.deepEqual(counts(await c.state()), [2]);
  });

  test('跨页取值回填（BW-15）：新标签页文档页读到 memory_limit，回原页填写保存，页面显示“已保存”，服务端恰好一次提交且值等于文档页', async () => {
    const space = 'sv-flow';
    await env.login(space);
    const pageId = await env.open(space, '/servers/1/edit');
    const click = await env.ok({ op: 'click', pageId, target: { role: 'link', name: '参数说明' } });
    assert.equal(click.effects.new_pages.length, 1);
    const docsId = click.effects.new_pages[0] as string;
    const value = await env.session.pages.get(docsId).evaluate(() => {
      const dts = [...document.querySelectorAll('#params dt')];
      return dts.find((e) => e.textContent === 'memory_limit')?.nextElementSibling?.textContent;
    });
    await env.ok({ op: 'close_page', pageId: docsId });
    await env.ok({ op: 'fill', pageId, target: { css: '#memory_limit' }, value: value as string });
    const save = { op: 'click', pageId, target: { css: '#save' } } as const;
    await env.ok({ ...save, post: [{ text_present: '已保存' }] });

    const st = await control(env.lab, space).state();
    assert.equal(serversOf(st).servers[0]?.memory_limit, value);
    assert.equal(value, serversOf(st).docs.memory_limit);
    assert.deepEqual(counts(st), [1]);
  });
});
