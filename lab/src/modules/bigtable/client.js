// 大表页面脚本（虚拟滚动 /table/virtual 与无限滚动 /table/scroll 共用）。配置在 window.__BT__：{ mode, api, total, row_h }。
// 数据一律从 /api/rows 取（offset / limit），所以两种呈现都会产生接口响应。
(() => {
  const { mode, api, row_h: H } = window.__BT__;
  const $ = (id) => document.getElementById(id);
  const h = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const KEYS = ['id', 'name', 'category', 'price', 'updated'];
  const cells = (r, role) =>
    KEYS.map((k) => `<span class="${k}"${role}>${h(r[k])}</span>`).join('');
  const load = async (offset, limit) => {
    const r = await fetch(`${api}?offset=${offset}&limit=${limit}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  if (mode === 'scroll') {
    // 无限滚动：初始取 10 行，滚到底部再取 10 行，直到取完；失败时 1 秒后自动重试
    const list = $('list');
    let n = 0;
    let busy = false;
    let total = Infinity;
    const more = async () => {
      if (busy || n >= total) return;
      busy = true;
      try {
        const d = await load(n, 10);
        total = d.total;
        n += d.rows.length;
        list.insertAdjacentHTML(
          'beforeend',
          d.rows.map((r) => `<li class="row" data-id="${r.id}">${cells(r, '')}</li>`).join(''),
        );
        $('status').textContent =
          n >= total ? `已加载全部 ${total} 条` : `已加载 ${n} / ${total} 条`;
      } catch {
        $('status').textContent = '加载失败，1 秒后重试';
        setTimeout(more, 1000);
      }
      busy = false;
    };
    list.addEventListener('scroll', () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 20) more();
    });
    more();
  } else {
    // 虚拟滚动：只渲染可见行 ± 3 行；数据按 100 行一块取回，滚动时提前取前后各 20 行范围内的块
    const vp = $('viewport');
    const total = window.__BT__.total;
    const rows = new Map();
    const asked = new Set();
    const fetchChunk = async (c) => {
      if (asked.has(c)) return;
      asked.add(c);
      try {
        for (const [i, r] of (await load(c * 100, 100)).rows.entries()) rows.set(c * 100 + i, r);
        render();
      } catch {
        asked.delete(c);
        setTimeout(render, 1000);
      }
    };
    const render = () => {
      const first = Math.max(0, Math.floor(vp.scrollTop / H) - 3);
      const last = Math.min(total - 1, Math.ceil((vp.scrollTop + vp.clientHeight) / H) + 3);
      let html = '';
      for (let i = first; i <= last; i++) {
        const r = rows.get(i);
        if (r) {
          html += `<div class="row" role="row" aria-rowindex="${i + 2}" data-id="${r.id}" style="top: ${i * H}px">${cells(r, ' role="gridcell"')}</div>`;
        }
      }
      $('spacer').innerHTML = html;
      const lo = Math.max(0, first - 20);
      const hi = Math.min(total - 1, last + 20);
      for (let c = Math.floor(lo / 100); c <= Math.floor(hi / 100); c++) fetchChunk(c);
    };
    vp.addEventListener('scroll', render);
    render();
  }
})();
