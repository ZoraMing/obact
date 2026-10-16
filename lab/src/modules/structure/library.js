// /structure/library 页面脚本：用 Shoelace 组件做一个差旅申请的小表单流程（填写 → 选择 → 勾选 → 提交后显示结果）。
// 配置由服务端注入到 window.__LIBRARY__：{base, cities, transports, cabins}。
// 组件定义好之后（含升级完成）才在 <body> 上写 data-sl-ready="1"，测试和自动化可以条件等待它。
(() => {
  const CFG = window.__LIBRARY__;
  const $ = (id) => document.getElementById(id);
  const labelOf = (list, v) => list.find((x) => x.value === v)?.label ?? v;

  const group = $('wizard');
  const fields = {
    name: $('f-name'),
    email: $('f-email'),
    city: $('f-city'),
    cabin: $('f-cabin'),
    agree: $('f-agree'),
    hotel: $('f-hotel'),
  };
  const state = { transport: '' };
  const submit = $('btn-submit');
  const dialog = $('confirm-dialog');
  const confirmBtn = $('btn-confirm');

  const values = () => ({
    name: String(fields.name.value ?? '').trim(),
    email: String(fields.email.value ?? '').trim(),
    city: String(fields.city.value ?? ''),
    transport: state.transport,
    cabin: String(fields.cabin.value ?? ''),
    agree: Boolean(fields.agree.checked),
    hotel: Boolean(fields.hotel.checked),
  });

  const summaryRows = (v) => [
    ['姓名', v.name || '未填写'],
    ['邮箱', v.email || '未填写'],
    ['目的地', v.city ? labelOf(CFG.cities, v.city) : '未选择'],
    ['出行方式', v.transport ? labelOf(CFG.transports, v.transport) : '未选择'],
    ['座位等级', labelOf(CFG.cabins, v.cabin)],
    ['预订酒店', v.hotel ? '需要' : '不需要'],
  ];
  const renderSummary = (el) => {
    el.replaceChildren();
    for (const [k, val] of summaryRows(values())) {
      const li = document.createElement('li');
      li.textContent = `${k}：${val}`;
      el.append(li);
    }
  };

  const showError = (text) => {
    $('error-text').textContent = text;
    $('error-alert').show();
  };

  // 选项卡之间的“下一步”
  for (const btn of document.querySelectorAll('[data-next]')) {
    btn.addEventListener('click', () => group.show(btn.dataset.next));
  }
  group.addEventListener('sl-tab-show', (e) => {
    if (e.detail.name === 'confirm') renderSummary($('summary'));
  });

  // 出行方式：下拉菜单（sl-dropdown + sl-menu）
  $('f-transport-menu').addEventListener('sl-select', (e) => {
    state.transport = e.detail.item.value;
    $('transport-value').textContent = `已选：${labelOf(CFG.transports, state.transport)}`;
  });

  // 勾选同意后才能提交；切换“预订酒店”时核对页的摘要同步更新
  fields.agree.addEventListener('sl-change', () => {
    submit.disabled = !fields.agree.checked;
  });
  fields.hotel.addEventListener('sl-change', () => renderSummary($('summary')));

  // 提交申请：先本地校验，再弹确认对话框
  submit.addEventListener('click', () => {
    const v = values();
    const missing = [
      !v.name && '姓名',
      !v.email && '邮箱',
      !v.city && '目的地城市',
      !v.transport && '出行方式',
    ].filter(Boolean);
    if (missing.length) {
      showError(`请先填写：${missing.join('、')}`);
      return;
    }
    $('error-alert').hide();
    $('dialog-error').textContent = '';
    renderSummary($('dialog-summary'));
    dialog.show();
  });
  $('btn-cancel').addEventListener('click', () => dialog.hide());

  // 确认提交：幂等键在“结果未知”（超时、断开、5xx）时沿用，明确成功或被拒绝后换新
  let attemptKey = null;
  let busy = false;
  confirmBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    confirmBtn.loading = true;
    attemptKey ??= crypto.randomUUID();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${CFG.base}/api/structure/library/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values(), key: attemptKey }),
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        attemptKey = null;
        $('result').textContent =
          `申请已提交：编号 ${data.id}（${data.name}，${labelOf(CFG.cities, data.city)}，` +
          `${labelOf(CFG.transports, data.transport)}，${labelOf(CFG.cabins, data.cabin)}，` +
          `${data.hotel ? '需要酒店' : '不订酒店'}）`;
        dialog.hide();
      } else if (r.status >= 500) {
        $('dialog-error').textContent = '服务暂时出错，请再点一次“确认提交”（不会重复提交）。';
      } else {
        attemptKey = null;
        $('dialog-error').textContent = `提交失败：${data.error ?? r.status}`;
      }
    } catch {
      $('dialog-error').textContent = '提交状态未知，请再点一次“确认提交”（不会重复提交）。';
    } finally {
      clearTimeout(timer);
      confirmBtn.loading = false;
      busy = false;
    }
  });

  // ?tab=info|choose|confirm 直接打开某一步（测试和录制回放用）
  const initialTab = new URLSearchParams(location.search).get('tab');
  const components = [
    'sl-button',
    'sl-input',
    'sl-select',
    'sl-option',
    'sl-checkbox',
    'sl-switch',
    'sl-tab-group',
    'sl-tab',
    'sl-tab-panel',
    'sl-dialog',
    'sl-dropdown',
    'sl-menu',
    'sl-menu-item',
    'sl-radio-group',
    'sl-radio',
    'sl-alert',
  ];
  Promise.all(components.map((n) => customElements.whenDefined(n)))
    .then(() => {
      if (['info', 'choose', 'confirm'].includes(initialTab)) group.show(initialTab);
      const all = document.querySelectorAll(components.join(','));
      return Promise.all([...all].map((el) => el.updateComplete));
    })
    .then(() => {
      document.body.dataset.slReady = '1';
    });
})();
