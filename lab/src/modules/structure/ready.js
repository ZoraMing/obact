// 放在 <head> 里的小脚本（早于页面里的 iframe 开始加载，不会漏掉消息）：
// 各 frame 加载完会通知顶层“frame-ready”，这里记下已就绪的框架；
// <html> 的 data-frames-ready 是已就绪个数（测试和自动化据此判断四个框架都加载好了），window.__framesReady 是它们的名字。
(() => {
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  const allowed = new Set([location.origin, `${location.protocol}//${other}:${location.port}`]);
  const ready = new Set();
  document.documentElement.dataset.framesReady = '0';
  addEventListener('message', (e) => {
    const d = e.data;
    if (!allowed.has(e.origin) || d?.type !== 'frame-ready') return;
    ready.add(d.who);
    window.__framesReady = [...ready];
    document.documentElement.dataset.framesReady = String(ready.size);
  });
})();
