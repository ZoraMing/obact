// /structure 页面脚本：框架地址、Shadow DOM 组件、新标签页、同名按钮。
// 配置由服务端注入到 window.__STRUCTURE__：{base}。各操作的结果写在 #status 里。
(() => {
  const { base } = window.__STRUCTURE__;
  const byId = (id) => document.getElementById(id);
  const say = (text) => {
    byId('status').textContent = text;
  };

  // 跨域 iframe：同一服务的另一个主机名（127.0.0.1 与 localhost 互换），端口取 location.port，路径同在本空间下
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const crossOrigin = `${location.protocol}//${other}:${location.port}`;
  byId('cross-frame').src = `${crossOrigin}${base}/structure/frame?who=cross`;

  // 开放 Shadow DOM：店铺卡片（内嵌另一个开放的评分组件）
  customElements.define(
    'lab-rating',
    class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<span>评分组件</span> <button type="button">收藏</button>';
        root.querySelector('button').onclick = () => {
          say('已收藏');
          labSend(base, 'favorite');
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
          say('已关注');
          labSend(base, 'follow');
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
          say(`已支付 ${amount} 元`);
          labSend(base, 'pay', { amount });
        };
      }
    },
  );

  // 各 frame 的“提交”通过 postMessage 通知顶层：状态行显示“跨域框架提交 1 次（a@x.cn）”这样的文字
  const LABEL = { same: '同源框架', cross: '跨域框架', nested: '嵌套框架', outer: '外层框架' };
  const allowed = new Set([location.origin, crossOrigin]);
  addEventListener('message', (e) => {
    const d = e.data;
    if (!allowed.has(e.origin) || d?.type !== 'frame-submit') return;
    say(`${LABEL[d.who] ?? d.who}提交 ${d.count} 次${d.email ? `（${d.email}）` : ''}`);
  });

  // 新标签页：target=_blank 链接由浏览器处理；window.open 按钮在这里
  byId('open-window').onclick = () => {
    labSend(base, 'open_window');
    window.open(`${base}/structure/report?from=open`, '_blank');
  };

  // 同名按钮：每个按钮各自监听，靠所在行（data-row-key）区分
  const table = document.querySelector('table');
  for (const btn of table.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      for (const r of table.querySelectorAll('tr.selected')) r.classList.remove('selected');
      tr.classList.add('selected');
      say(`查看 ${tr.dataset.rowKey}`);
      labSend(base, 'view', { row: tr.dataset.rowKey });
    });
  }
})();
