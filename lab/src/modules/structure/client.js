// /structure 页面脚本：框架地址、Shadow DOM 组件、新标签页、同名按钮、动态属性区。
// 配置由服务端注入到 window.__STRUCTURE__：{base, ids}。ids 是本次加载随机生成的 id，脚本不写死。
(() => {
  const CFG = window.__STRUCTURE__;
  const send = (type, detail) => labSend(CFG.base, type, detail);
  const byId = (id) => document.getElementById(id);

  // 操作记录：页面上的“操作记录”列表与 window.__log
  window.__log = [];
  const record = (text) => {
    window.__log.push(text);
    const li = document.createElement('li');
    li.textContent = text;
    byId(CFG.ids.log).append(li);
  };

  // 跨域 iframe：同一服务的另一个主机名（127.0.0.1 与 localhost 互换），端口取 location.port，路径同在本空间下
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const crossOrigin = `${location.protocol}//${other}:${location.port}`;
  byId('cross-frame').src = `${crossOrigin}${CFG.base}/structure/frame?who=cross`;

  // 开放 Shadow DOM：店铺卡片（内嵌另一个开放的评分组件）
  customElements.define(
    'lab-rating',
    class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<span>评分组件</span> <button type="button">收藏</button>';
        root.querySelector('button').onclick = () => {
          record('已收藏');
          send('favorite');
        };
      }
    },
  );
  customElements.define(
    'lab-profile',
    class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML =
          '<div style="border:1px solid #ddd;padding:8px;margin:4px 0">' +
          '<strong>店铺：星河贸易</strong> <button type="button" id="follow">关注</button> <lab-rating></lab-rating></div>';
        root.getElementById('follow').onclick = () => {
          record('已关注');
          send('follow');
        };
      }
    },
  );

  // 封闭 Shadow DOM：页面脚本从外部拿不到 shadowRoot
  customElements.define(
    'lab-paybox',
    class extends HTMLElement {
      #attached = false;
      connectedCallback() {
        if (this.#attached) return;
        this.#attached = true;
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML =
          '<div style="border:1px solid #ddd;padding:8px;margin:4px 0">' +
          '<label for="amount">金额</label> <input id="amount" inputmode="decimal"> ' +
          '<button type="button" id="pay">支付</button></div>';
        root.getElementById('pay').onclick = () => {
          const amount = root.getElementById('amount').value;
          record(`已支付 ${amount} 元`);
          send('pay', { amount });
        };
      }
    },
  );

  // Shadow Root 里的 iframe
  customElements.define(
    'lab-frame-host',
    class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<iframe title="组件内框架" src="${CFG.base}/structure/frame?who=shadow" style="width:380px;height:190px;border:1px solid #ccc"></iframe>`;
      }
    },
  );

  // 各 frame 的“提交”通过 postMessage 通知顶层：状态行显示“跨域框架提交 1 次（a@x.cn）”这样的文字
  const LABEL = {
    same: '同源框架',
    cross: '跨域框架',
    nested: '嵌套框架',
    shadow: '组件内框架',
    outer: '外层框架',
  };
  const allowed = new Set([location.origin, crossOrigin]);
  addEventListener('message', (e) => {
    const d = e.data;
    if (!allowed.has(e.origin) || !d) return;
    if (d.type !== 'frame-submit') return;
    const text = `${LABEL[d.who] ?? d.who}提交 ${d.count} 次${d.email ? `（${d.email}）` : ''}`;
    byId(CFG.ids.status).textContent = text;
    record(text);
  });

  // 新标签页：target=_blank 链接由浏览器处理；window.open 按钮在这里
  byId('open-window').onclick = () => {
    send('open_window');
    window.open(`${CFG.base}/structure/report?from=open`, '_blank');
  };

  // 同名按钮：每个按钮各自监听，靠所在行（data-row-key）区分
  const table = byId(CFG.ids.table);
  for (const btn of table.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const row = tr.dataset.rowKey;
      const cells = tr.querySelectorAll('td');
      for (const r of table.querySelectorAll('tr.selected')) r.classList.remove('selected');
      tr.classList.add('selected');
      byId(CFG.ids.detail).textContent =
        `正在查看：${row} ${cells[1].textContent}（负责人：${cells[2].textContent}，金额 ${cells[3].textContent} 元）`;
      record(`查看 ${row}`);
      send('view', { row });
    });
  }

  // 动态属性区：按钮的 id 与类名每次加载都变，文字不变
  const counts = { draft: 0, approve: 0 };
  for (const kind of ['draft', 'approve']) {
    byId(CFG.ids[kind]).addEventListener('click', () => {
      counts[kind]++;
      const note = byId(CFG.ids.note).value.trim();
      byId(CFG.ids.dynStatus).textContent =
        `${kind === 'draft' ? '草稿已保存' : '审批已提交'}（第 ${counts[kind]} 次${note ? `，备注：${note}` : ''}）`;
      record(kind === 'draft' ? '保存草稿' : '提交审批');
      send(kind, note ? { note } : {});
    });
  }

  document.body.dataset.structureReady = '1';
})();
