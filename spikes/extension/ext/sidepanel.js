// 侧边栏页面连接本机服务的 WebSocket（JSON-RPC 2.0）。端口从 #port= 传入，预研用。
const port = new URLSearchParams(location.hash.slice(1)).get('port') || '47210';
const logEl = document.getElementById('log');
const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
ws.onopen = () => {
  ws.send(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: { run_id: 'run_42' } }),
  );
};
ws.onmessage = (e) => {
  logEl.textContent += `${e.data}\n`;
  document.title = 'connected';
};
ws.onerror = () => {
  document.title = 'ws-error';
};
