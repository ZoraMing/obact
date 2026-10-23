/**
 * Obact Lab 模块：服务器管理（PRD 9.3；BW-15 多页面查询回填的前提）。页面和接口都需要登录。
 *
 * 页面：
 *   GET /servers              列表：3 台服务器（编号 1~3）的名称、CPU、内存上限，每台带“编辑”
 *   GET /servers/:id/edit     编辑表单 #server-form：名称 #name、CPU #cpu、内存上限 #memory_limit、备注 #note，
 *                             提交按钮 #save，结果显示在 #status（“已保存”）；内存上限旁有链接“参数说明”（#docs-link，target=_blank）
 *   GET /servers/docs/params  文档页：dl#params 列出参数名与推荐值（dt / dd 成对）；memory_limit 的值由种子决定
 *                             （2048 / 4096 / 8192 / 16384 之一，同一个种子永远相同），内存上限要填它
 * 接口：
 *   POST /api/servers/:id     保存 {name, cpu, memory_limit, note, key?}（写接口，op 为 server_save）：同一个 key 再次提交
 *                             只计数、不重复写入（仍按首次内容）；校验不通过返回 400，不记录
 *
 * 幂等键：页面加载时生成，状态未明（超时、5xx、断连）后重试沿用同一个键，成功或 4xx 后换新键。
 * 状态（_lab/state 的 modules.servers）：servers（每台服务器的当前值）、docs.memory_limit（文档页上的值，对账用）；
 * 每个幂等键的提交次数看 _lab/state 的 submissions。
 * 随机性：不消耗 space.rng()。服务器初始的内存上限都不是文档页可能给出的值，所以“值正确”必然来自填写。不定义改版变体。
 */ import { readFileSync } from 'node:fs';
import { type Ctx, esc, type LabModule, page, type Space } from '../core.ts';

type Server = { id: string; name: string; cpu: number; memory_limit: string; note: string };

const MEMORY = ['2048', '4096', '8192', '16384'];
const CLIENT_JS = readFileSync(new URL('./servers/client.js', import.meta.url), 'utf8');

const serversOf = (space: Space) => space.data.servers as Server[];
const docMemory = (space: Space): string => MEMORY[Math.abs(space.seed) % MEMORY.length] as string;

/** 校验保存请求；cpu 从表单来的是字符串。 */
function parseInput(b: Record<string, unknown>): Omit<Server, 'id'> | { error: string } {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    name: text(b.name),
    cpu: Number(b.cpu ?? Number.NaN),
    memory_limit: text(b.memory_limit),
    note: text(b.note),
  };
  if (!out.name || out.name.length > 50) return { error: 'name 必填，最长 50 个字' };
  if (!Number.isInteger(out.cpu) || out.cpu < 1 || out.cpu > 64) {
    return { error: 'cpu 必须是 1~64 的整数' };
  }
  if (!/^\d{1,6}$/.test(out.memory_limit)) return { error: 'memory_limit 必须是数字' };
  if (out.note.length > 200) return { error: 'note 最长 200 个字' };
  return out;
}

const mod: LabModule = {
  name: 'servers',
  title: '服务器管理',
  nav: '/servers',

  init(space) {
    space.data.servers = [
      { id: '1', name: 'web-01', cpu: 2, memory_limit: '1024', note: '' },
      { id: '2', name: 'db-01', cpu: 4, memory_limit: '1536', note: '' },
      { id: '3', name: 'cache-01', cpu: 2, memory_limit: '512', note: '' },
    ] satisfies Server[];
  },

  routes(r) {
    const view = (ctx: Ctx, title: string, body: string) =>
      ctx.html(page(ctx, [mod], title, `<h1>${esc(title)}</h1>${body}`));

    r.get(
      '/servers',
      (ctx) => {
        const li = serversOf(ctx.space).map(
          (s) =>
            `<li>${s.id}：${esc(s.name)}，${s.cpu} 核，内存上限 ${esc(s.memory_limit)} <a href="${ctx.base}/servers/${s.id}/edit">编辑</a></li>`,
        );
        view(ctx, '服务器列表', `<ul>${li.join('')}</ul>`);
      },
      { auth: true },
    );

    r.get(
      '/servers/:id/edit',
      (ctx) => {
        const s = serversOf(ctx.space).find((x) => x.id === ctx.params.id);
        if (!s) return ctx.html(page(ctx, [mod], '未找到', '<h1>服务器不存在</h1>'), 404);
        const cfg = { api: `${ctx.base}/api/servers/${s.id}`, submit_timeout_ms: 5000 };
        view(
          ctx,
          `编辑服务器 ${s.name}`,
          `<form id="server-form">
<p><label for="name">名称</label> <input id="name" name="name" value="${esc(s.name)}" required maxlength="50"></p>
<p><label for="cpu">CPU 核数</label> <input id="cpu" name="cpu" type="number" min="1" max="64" value="${s.cpu}"></p>
<p><label for="memory_limit">内存上限（memory_limit）</label> <input id="memory_limit" name="memory_limit" value="${esc(s.memory_limit)}">
 <a id="docs-link" href="${ctx.base}/servers/docs/params" target="_blank">参数说明</a></p>
<p><label for="note">备注</label> <input id="note" name="note" value="${esc(s.note)}" maxlength="200"></p>
<p><button id="save" type="submit">保存</button> <span id="status" role="status"></span></p>
</form>
<script>window.__SERVERS__ = ${JSON.stringify(cfg)};</script><script>${CLIENT_JS}</script>`,
        );
      },
      { auth: true },
    );

    r.get(
      '/servers/docs/params',
      (ctx) => {
        const params = [
          ['max_connections', '500'],
          ['memory_limit', docMemory(ctx.space)],
          ['timeout_s', '30'],
          ['log_level', 'info'],
        ];
        const dl = params.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
        view(ctx, '参数说明', `<p>各参数的推荐值：</p><dl id="params">${dl}</dl>`);
      },
      { auth: true },
    );

    r.post(
      '/api/servers/:id',
      async (ctx) => {
        const s = serversOf(ctx.space).find((x) => x.id === ctx.params.id);
        if (!s) return ctx.json({ error: 'not_found' }, 404);
        const b = await ctx.body();
        const input = parseInput(b);
        if ('error' in input) return ctx.json({ error: input.error }, 400);
        const key = typeof b.key === 'string' && b.key !== '' ? b.key : undefined;
        // 同一个键再次到达只计数，不重复写入（记录的载荷、写入的内容都是首次的）
        const sub = ctx.record('server_save', key, { id: s.id, ...input });
        if (sub.count === 1) Object.assign(s, input);
        ctx.json({ ok: true, duplicate: sub.count > 1, server: s });
      },
      { auth: true, commit: true },
    );
  },

  state: (space) => ({ servers: serversOf(space), docs: { memory_limit: docMemory(space) } }),
};

export default mod;
