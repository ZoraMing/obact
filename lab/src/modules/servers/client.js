// 服务器编辑页脚本：以 JSON 提交到 window.__SERVERS__.api（{ api, submit_timeout_ms }）。
// 幂等键在页面加载时生成；状态未明（超时、5xx、断连）重试沿用同一个键，成功或 4xx 之后换新键。
(() => {
  const cfg = window.__SERVERS__;
  const form = document.getElementById('server-form');
  const status = document.getElementById('status');
  let key = crypto.randomUUID();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '保存中…';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.submit_timeout_ms);
    try {
      const r = await fetch(cfg.api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), key }),
        signal: ctl.signal,
      });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      status.textContent = r.ok ? '已保存' : `保存失败：${(await r.json()).error}`;
      key = crypto.randomUUID();
    } catch {
      status.textContent = '提交状态未明，请重试';
    } finally {
      clearTimeout(timer);
    }
  });
})();
