// 订单后台的页面脚本（列表页和详情页共用）。配置由服务端注入到 window.__ORDERS__：
//   { mode: 'list' | 'detail', api, base, login, ids, cls, text, cards, orderId? }
// id、类名和文案都从配置里取（改版变体只改配置，不改这个脚本）。
// 列表页的筛选、排序、翻页全部在浏览器里完成，不改 URL；数据一次取回（/api/orders）。
// 排序规则必须和服务端 data.ts 的 queryOrders 一致：金额按数值，状态按固定顺序，其余按码点，同值按订单号升序。
(() => {
  const cfg = window.__ORDERS__;
  const { ids, cls, text } = cfg;
  const PAGE_SIZE = 20;
  const STATUSES = ['待审核', '已审核', '已驳回'];
  const COLUMNS = [
    ['id', '订单号'],
    ['customer', '客户'],
    ['amount', '金额'],
    ['status', '状态'],
    ['region', '地区'],
    ['created_at', '下单时间'],
  ];
  /** 提交接口的等待上限：超过就按“状态未明”处理（测试可在加载后改 window.__ORDERS__.submit_timeout_ms 缩短）。 */
  const SUBMIT_TIMEOUT_MS = 15000;
  const LOAD_TIMEOUT_MS = 20000;

  const $ = (id) => document.getElementById(id);
  const h = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const fmtAmount = (n) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const newKey = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };

  /** 带超时的请求：永远不抛异常，返回 { ok, status, body, timeout }。 */
  async function request(url, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...init?.headers },
      });
      let body = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      return { ok: r.ok, status: r.status, body, timeout: false };
    } catch (e) {
      return { ok: false, status: 0, body: null, timeout: ctl.signal.aborted, error: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 失败原因的中文说明；unknown 表示请求可能已经被服务端处理（超时、断开、5xx）。 */
  function describe(res, timeoutMs) {
    if (res.status === 401) return { text: '登录已过期，请重新登录', unknown: false, login: true };
    if (res.status === 0 && res.timeout) {
      return { text: `请求超时（等待 ${Math.round(timeoutMs / 1000)} 秒无响应）`, unknown: true };
    }
    if (res.status === 0) return { text: '网络错误，连接被中断', unknown: true };
    const detail = res.body?.error ? `（${res.body.error}）` : '';
    return { text: `服务器返回 ${res.status}${detail}`, unknown: res.status >= 500 };
  }

  const msgEl = $(ids.msg);
  const errEl = $(ids.err);
  function setMsg(s) {
    msgEl.textContent = s;
  }
  /** 错误提示（role=alert）；action 是可选的按钮 { label, run }。 */
  function setErr(s, extra) {
    errEl.textContent = '';
    if (!s) {
      errEl.hidden = true;
      return;
    }
    const span = document.createElement('span');
    span.textContent = s;
    errEl.append(span);
    if (extra?.login) {
      const a = document.createElement('a');
      a.href = cfg.login;
      a.textContent = '重新登录';
      errEl.append(' ', a);
    }
    if (extra?.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = extra.action.label;
      b.style.marginLeft = '10px';
      b.addEventListener('click', extra.action.run);
      errEl.append(b);
    }
    errEl.hidden = false;
  }

  // ---------------------------------------------------------------- 提交（批量审核与单条审核共用）

  let busy = false;
  /** 上一次没有明确结果的提交：重试时沿用同一个幂等键。 */
  let attempt = null;

  /** 提交审核；onDone(result) 在成功后更新页面。 */
  async function submit(idList, comment, onDone, onBusy) {
    if (busy) return;
    const sig = `${[...idList].sort().join(',')}|${comment}`;
    if (!attempt || attempt.sig !== sig) {
      attempt = { sig, key: newKey(), ids: [...idList], comment };
    }
    const cur = attempt;
    const timeoutMs = cfg.submit_timeout_ms ?? SUBMIT_TIMEOUT_MS;
    busy = true;
    onBusy(true);
    setErr(null);
    setMsg('提交中…');
    const res = await request(
      `${cfg.api}/approve`,
      { method: 'POST', body: JSON.stringify({ ids: cur.ids, key: cur.key, comment }) },
      timeoutMs,
    );
    busy = false;
    onBusy(false);
    if (res.ok && res.body?.ok) {
      attempt = null;
      const r = res.body;
      let s = `已审核 ${r.approved} 条`;
      if (r.skipped.length > 0) s += `，另有 ${r.skipped.length} 条被跳过（已审核或已驳回）`;
      if (r.duplicate) s += '（此前的提交已生效，本次没有重复处理）';
      setMsg(s);
      onDone(r);
      return;
    }
    const d = describe(res, timeoutMs);
    // 明确失败（4xx）：这次操作作废，下次是新操作；状态未明：保留键，重试沿用
    if (!d.unknown) attempt = null;
    setMsg('');
    const note = d.unknown
      ? '提交状态未明：服务端可能已经处理，请先核对订单状态；重试会沿用同一个幂等键。'
      : '';
    setErr(`提交失败：${d.text}。${note}`, {
      login: d.login,
      action: d.unknown
        ? { label: text.retry, run: () => submit(cur.ids, cur.comment, onDone, onBusy) }
        : null,
    });
  }

  // ---------------------------------------------------------------- 详情页

  if (cfg.mode === 'detail') {
    const approveBtn = $(ids.approve);
    if (approveBtn) {
      approveBtn.addEventListener('click', () => {
        if (busy) return;
        const comment = ($(ids.comment).value || '').trim();
        if (!window.confirm(text.confirmDetail.replace('{id}', cfg.orderId))) return;
        submit(
          [cfg.orderId],
          comment,
          (r) => {
            const st = $(ids.state);
            if (
              r.approved_ids.includes(cfg.orderId) ||
              r.skipped.some((x) => x.reason === 'already_approved')
            ) {
              st.textContent = '已审核';
              st.className = `${cls.badge} st-1`;
              $(ids.actions).textContent = '该订单已审核。';
            }
          },
          (b) => {
            approveBtn.disabled = b;
          },
        );
      });
    }
    return;
  }

  // ---------------------------------------------------------------- 列表页

  const S = {
    all: [],
    filter: { status: '', q: '' },
    sort: { key: 'created_at', dir: 'desc' },
    page: 1,
    selected: new Set(),
  };

  const compare = (key, a, b) => {
    if (key === 'amount') return a.amount - b.amount;
    if (key === 'status') return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
    return a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
  };
  function filtered() {
    const kw = S.filter.q.toLowerCase();
    const sign = S.sort.dir === 'asc' ? 1 : -1;
    return S.all
      .filter(
        (o) =>
          (S.filter.status === '' || o.status === S.filter.status) &&
          (kw === '' || o.id.includes(kw) || o.customer.toLowerCase().includes(kw)),
      )
      .sort((a, b) => sign * compare(S.sort.key, a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const pageCount = (n) => Math.max(1, Math.ceil(n / PAGE_SIZE));

  const listEl = $(ids.list);
  const pagerEl = $(ids.pager);
  const batchBtn = $(ids.batch);

  function exportHref() {
    const p = new URLSearchParams();
    if (S.filter.status) p.set('status', S.filter.status);
    if (S.filter.q) p.set('q', S.filter.q);
    p.set('sort', S.sort.key);
    p.set('dir', S.sort.dir);
    return `${cfg.api}/export.csv?${p}`;
  }

  function updateSelection() {
    $(ids.selected).textContent = `已选 ${S.selected.size} 条`;
    batchBtn.disabled = busy || S.selected.size === 0;
    const all = $(ids.all);
    if (all) {
      const boxes = [...listEl.querySelectorAll(`input.${cls.check}`)];
      all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    }
  }

  function badge(o) {
    return `<span class="${cls.badge} st-${STATUSES.indexOf(o.status)}">${h(o.status)}</span>`;
  }
  function checkbox(o) {
    return `<input type="checkbox" class="${cls.check}" data-id="${o.id}" aria-label="选择订单 ${o.id}"${S.selected.has(o.id) ? ' checked' : ''}>`;
  }
  function approveBtn(o) {
    return o.status === '待审核'
      ? `<button type="button" class="${cls.approve}" data-id="${o.id}">${h(text.rowApprove)}</button>`
      : '';
  }

  function renderTable(rows) {
    const head = COLUMNS.map(([key, label]) => {
      const on = S.sort.key === key;
      const aria = on ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" aria-sort="${aria}"${key === 'amount' ? ` class="${cls.num}"` : ''}><button type="button" class="${cls.sort}" data-key="${key}">${label}</button></th>`;
    }).join('');
    const body = rows
      .map(
        (o) => `<tr class="${cls.row}" data-id="${o.id}">
<td>${checkbox(o)}</td>
<td><a href="${cfg.base}/orders/${o.id}">${o.id}</a></td>
<td>${h(o.customer)}</td>
<td class="${cls.num}">${fmtAmount(o.amount)}</td>
<td>${badge(o)}</td>
<td>${h(o.region)}</td>
<td>${o.created_at}</td>
<td class="ops"><a href="${cfg.base}/orders/${o.id}">${h(text.detail)}</a>${approveBtn(o)}</td>
</tr>`,
      )
      .join('');
    return `<table id="${ids.table}" aria-label="订单列表">
<thead><tr><th scope="col"><input type="checkbox" id="${ids.all}" aria-label="全选本页"></th>${head}<th scope="col">操作</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
  }

  function renderCards(rows) {
    const items = rows
      .map(
        (o) => `<li class="${cls.card}" data-id="${o.id}">
<div class="card-head">${checkbox(o)}<a href="${cfg.base}/orders/${o.id}">订单 ${o.id}</a>${badge(o)}</div>
<dl><dt>客户</dt><dd>${h(o.customer)}</dd><dt>金额</dt><dd>${fmtAmount(o.amount)}</dd><dt>地区</dt><dd>${h(o.region)}</dd><dt>下单时间</dt><dd>${o.created_at}</dd></dl>
<div class="ops"><a href="${cfg.base}/orders/${o.id}">${h(text.detail)}</a>${approveBtn(o)}</div>
</li>`,
      )
      .join('');
    return `<ul class="cards" aria-label="订单列表">${items}</ul>`;
  }

  function renderPager(pages) {
    let s = `<button type="button" class="${cls.page}" data-page="prev"${S.page <= 1 ? ' disabled' : ''}>${h(text.prev)}</button>`;
    for (let p = 1; p <= pages; p++) {
      s += `<button type="button" class="${cls.page}" data-page="${p}" aria-label="第 ${p} 页"${p === S.page ? ' aria-current="page"' : ''}>${p}</button>`;
    }
    s += `<button type="button" class="${cls.page}" data-page="next"${S.page >= pages ? ' disabled' : ''}>${h(text.next)}</button>`;
    return s;
  }

  function render() {
    const rows = filtered();
    const pages = pageCount(rows.length);
    S.page = Math.min(Math.max(1, S.page), pages);
    const slice = rows.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    $(ids.summary).textContent =
      rows.length === 0
        ? '共 0 条'
        : `共 ${rows.length} 条，第 ${S.page} / ${pages} 页，每页 ${PAGE_SIZE} 条`;
    listEl.innerHTML =
      rows.length === 0
        ? '<p class="o-empty">没有符合条件的订单</p>'
        : cfg.cards
          ? renderCards(slice)
          : renderTable(slice);
    pagerEl.innerHTML = rows.length === 0 ? '' : renderPager(pages);
    $(ids.export).href = exportHref();
    if (cfg.cards) {
      $(ids.sortField).value = S.sort.key;
      $(ids.sortDir).textContent = S.sort.dir === 'asc' ? '升序' : '降序';
    }
    updateSelection();
  }

  function sortBy(key) {
    S.sort =
      S.sort.key === key
        ? { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' };
    S.page = 1;
    render();
  }

  function applyFilter() {
    S.filter = { status: $(ids.status).value, q: $(ids.keyword).value.trim() };
    S.page = 1;
    S.selected.clear();
    setMsg('');
    render();
  }

  // 列表内的操作用事件委托：重绘后不需要重新绑定
  // 点击委托到 document（和常见框架一致），不把列表容器变成“可点击元素”
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('button') : null;
    if (!t) return;
    if (pagerEl.contains(t)) return onPagerClick(t);
    if (!listEl.contains(t)) return;
    if (t.classList.contains(cls.sort)) sortBy(t.dataset.key);
    else if (t.classList.contains(cls.approve)) startApprove([t.dataset.id], 'row', t.dataset.id);
  });
  listEl.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === ids.all) {
      for (const b of listEl.querySelectorAll(`input.${cls.check}`)) {
        b.checked = t.checked;
        if (t.checked) S.selected.add(b.dataset.id);
        else S.selected.delete(b.dataset.id);
      }
    } else if (t.classList.contains(cls.check)) {
      if (t.checked) S.selected.add(t.dataset.id);
      else S.selected.delete(t.dataset.id);
    }
    updateSelection();
  });
  function onPagerClick(t) {
    if (t.disabled) return;
    const v = t.dataset.page;
    S.page = v === 'prev' ? S.page - 1 : v === 'next' ? S.page + 1 : Number(v);
    render();
  }
  $(ids.form).addEventListener('submit', (e) => {
    e.preventDefault();
    applyFilter();
  });
  $(ids.reset).addEventListener('click', () => {
    $(ids.status).value = '';
    $(ids.keyword).value = '';
    applyFilter();
  });
  if (cfg.cards) {
    $(ids.sortField).addEventListener('change', (e) => {
      S.sort = { key: e.target.value, dir: S.sort.dir };
      S.page = 1;
      render();
    });
    $(ids.sortDir).addEventListener('click', () => {
      S.sort = { key: S.sort.key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' };
      S.page = 1;
      render();
    });
  }

  /** 确认后提交；source 为 'batch' 时用已选的订单，为 'row' 时只审核这一条。 */
  function startApprove(idList, source, rowId) {
    if (busy || idList.length === 0) return;
    const msg =
      source === 'row'
        ? text.confirmRow.replace('{id}', rowId)
        : text.confirmBatch.replace('{n}', String(idList.length));
    if (!window.confirm(msg)) return;
    submit(
      idList,
      '',
      (r) => {
        const done = new Set([
          ...r.approved_ids,
          ...r.skipped.filter((x) => x.reason === 'already_approved').map((x) => x.id),
        ]);
        for (const o of S.all) if (done.has(o.id)) o.status = '已审核';
        for (const id of idList) S.selected.delete(id);
        render();
      },
      (b) => {
        batchBtn.disabled = b || S.selected.size === 0;
      },
    );
  }
  batchBtn.addEventListener('click', () => startApprove([...S.selected], 'batch'));

  async function load() {
    setErr(null);
    $(ids.summary).textContent = '加载中…';
    const res = await request(`${cfg.api}?page_size=500`, {}, LOAD_TIMEOUT_MS);
    if (res.ok && res.body && Array.isArray(res.body.items)) {
      S.all = res.body.items;
      render();
      return;
    }
    const d = describe(res, LOAD_TIMEOUT_MS);
    $(ids.summary).textContent = '订单数据未能加载';
    listEl.innerHTML = `<p class="o-empty">订单数据未能加载，请点击“${h(text.reload)}”重试</p>`;
    pagerEl.innerHTML = '';
    setErr(`加载订单失败：${d.text}`, {
      login: d.login,
      action: { label: text.reload, run: load },
    });
  }

  load();
})();
