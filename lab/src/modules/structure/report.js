// 新标签页（报表页）脚本：?from=link 为 target=_blank 链接打开，?from=open 为 window.open 打开。
(() => {
  const CFG = window.__REPORT__;
  document.getElementById('ack').onclick = () => {
    document.getElementById('ack-result').textContent = `已确认（来自 ${CFG.from}）`;
    labSend(CFG.base, 'report_ack', { from: CFG.from });
  };
})();
