// 各页面共用的前端助手（由 view.ts 拼在页面脚本之前）：带幂等键上报页面事件。
// 先更新界面，再上报；上报失败不影响页面（评分点以服务端账本为准，所以重试用同一个键）。
window.labSend = (base, type, detail = {}) => {
  const key = crypto.randomUUID();
  const body = JSON.stringify({ type, detail, key });
  const post = () =>
    fetch(`${base}/api/structure/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  post().catch(() => post().catch(() => {}));
};
