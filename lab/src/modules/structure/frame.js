// 内嵌表单页脚本（同源 / 跨域 / 嵌套的内层）与嵌套外层页脚本。
// 配置由服务端注入到 window.__FRAME__：{base, who} 或 {base, page: 'outer'}。
// “提交”后通过 postMessage 通知顶层页面，并上报事件。
(() => {
  const CFG = window.__FRAME__;
  const byId = (id) => document.getElementById(id);
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  let count = 0;

  if (CFG.page === 'outer') {
    // 嵌套外层：同源页面里再嵌一个跨域 iframe（另一个主机名，同在本空间下）
    byId('inner-frame').src =
      `${location.protocol}//${other}:${location.port}${CFG.base}/structure/frame?who=nested`;
    byId('outer-btn').onclick = () => {
      count++;
      labSend(CFG.base, 'outer_button');
      window.top.postMessage({ type: 'frame-submit', who: 'outer', count }, '*');
    };
    return;
  }

  byId('where').textContent = `框架：${CFG.who}（${location.host}）`;
  byId('submit').onclick = () => {
    count++;
    const email = byId('email').value.trim();
    byId('result').textContent = `已提交 ${count} 次${email ? `：${email}` : ''}`;
    labSend(CFG.base, 'frame_submit', { who: CFG.who, email });
    window.top.postMessage({ type: 'frame-submit', who: CFG.who, count, email }, '*');
  };
})();
