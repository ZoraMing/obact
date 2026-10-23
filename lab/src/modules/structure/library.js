// /structure/library 页面脚本：用 Shoelace 组件做一个差旅申请的小表单流程（填写 → 选择 → 勾选 → 提交后显示结果）。
// 配置由服务端注入到 window.__LIBRARY__：{base, cities, cabins}。
// 组件定义好之后（含升级完成）才在 <body> 上写 data-sl-ready="1"，测试和自动化可以条件等待它。
(() => {
  const CFG = window.__LIBRARY__;
  const $ = (id) => document.getElementById(id);
  const labelOf = (list, v) => list.find((x) => x.value === v)?.label ?? v;

  const fields = {
    name: $('f-name'),
    email: $('f-email'),
    city: $('f-city'),
    cabin: $('f-cabin'),
    agree: $('f-agree'),
  };
  const submit = $('btn-submit');
  const dialog = $('confirm-dialog');
  const confirmBtn = $('btn-confirm');

  const values = () => ({
    name: String(fields.name.value ?? '').trim(),
    email: String(fields.email.value ?? '').trim(),
    city: String(fields.city.value ?? ''),
    cabin: String(fields.cabin.value ?? ''),
    agree: Boolean(fields.agree.checked),
  });

  const renderSummary = (el) => {
    const v = values();
    el.replaceChildren();
    for (const [k, val] of [
      ['姓名', v.name || '未填写'],
      ['邮箱', v.email || '未填写'],
      ['目的地', v.city ? labelOf(CFG.cities, v.city) : '未选择'],
      ['座位等级', labelOf(CFG.cabins, v.cabin)],
    ]) {
      const li = document.createElement('li');
      li.textContent = `${k}：${val}`;
      el.append(li);
    }
  };

  // 选项卡之间的“下一步”；进入核对页时刷新摘要
  for (const btn of document.querySelectorAll('[data-next]')) {
    btn.addEventListener('click', () => $('wizard').show(btn.dataset.next));
  }
  $('wizard').addEventListener('sl-tab-show', (e) => {
    if (e.detail.name === 'confirm') renderSummary($('summary'));
  });

  // 勾选同意后才能提交；点“提交申请”弹确认对话框
  fields.agree.addEventListener('sl-change', () => {
    submit.disabled = !fields.agree.checked;
  });
  submit.addEventListener('click', () => {
    $('dialog-error').textContent = '';
    renderSummary($('dialog-summary'));
    dialog.show();
  });
  $('btn-cancel').addEventListener('click', () => dialog.hide());

  // 确认提交：每次点击带一个新的幂等键；结果未知（超时、断开、5xx）时提示再试
  confirmBtn.addEventListener('click', async () => {
    if (confirmBtn.loading) return;
    confirmBtn.loading = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${CFG.base}/api/structure/library/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values(), key: crypto.randomUUID() }),
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        $('result').textContent =
          `申请已提交：编号 ${data.id}（${data.name}，${labelOf(CFG.cities, data.city)}，${labelOf(CFG.cabins, data.cabin)}）`;
        dialog.hide();
      } else {
        $('dialog-error').textContent = `提交失败：${data.error ?? r.status}`;
      }
    } catch {
      $('dialog-error').textContent = '提交状态未知，请核对后再试。';
    } finally {
      clearTimeout(timer);
      confirmBtn.loading = false;
    }
  });

  const components = [
    'sl-button',
    'sl-input',
    'sl-select',
    'sl-option',
    'sl-checkbox',
    'sl-tab-group',
    'sl-tab',
    'sl-tab-panel',
    'sl-dialog',
    'sl-radio-group',
    'sl-radio',
  ];
  Promise.all(components.map((n) => customElements.whenDefined(n)))
    .then(() =>
      Promise.all(
        [...document.querySelectorAll(components.join(','))].map((el) => el.updateComplete),
      ),
    )
    .then(() => {
      document.body.dataset.slReady = '1';
    });
})();
