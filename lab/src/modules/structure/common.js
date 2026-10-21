// 各页面共用的前端助手（由 view.ts 拼在页面脚本之前）：带幂等键上报页面事件。
// 先更新界面，再上报；上报失败不影响页面（评分点以服务端账本为准，所以重试用同一个键）。
// 断网、连接被丢弃、服务端 5xx（error_rate 注入的 500）都算失败，最多再试 2 次，间隔 300 毫秒；
// 服务端按键去重，重试不会重复记账。
window.labSend = (base, type, detail = {}) => {
  const key = crypto.randomUUID();
  const body = JSON.stringify({ type, detail, key });
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
