// 各页面共用的前端助手（由 view.ts 拼在页面脚本之前）：带幂等键上报页面事件。
// 先更新界面，再上报；断网、连接被丢弃、服务端 5xx（error_rate 注入的 500）都算失败，
// 最多再试 2 次，间隔 300 毫秒；重试沿用同一个键，服务端按键去重，不会重复记账。
window.labSend = (base, type, detail = {}) => {
  const body = JSON.stringify({ type, detail, key: crypto.randomUUID() });
  const post = (retries) =>
    fetch(`${base}/api/structure/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    })
      .then((r) => {
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      })
      .catch(() => {
        if (retries > 0) setTimeout(() => post(retries - 1), 300);
      });
  post(2);
};
