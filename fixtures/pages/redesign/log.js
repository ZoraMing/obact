// 改版夹具的事件记录：落在页面上的每次点击、输入都记下“语义身份”（最近的 data-x-key）。
// 不记 change：文本框的 change 在失焦时才触发，会被算到下一个动作头上（复选框、下拉框也会触发 input）。
// data-x-key 只供测试判断“点中的是不是同一个元素”，定位器生成不使用它。
// window.__events = [{ type, key, tag }]；key 为 null 表示落在了没有身份的地方（空白处、标签文字等）。
window.__events = [];
for (const type of ['click', 'input']) {
  document.addEventListener(
    type,
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const el = t ? t.closest('[data-x-key]') : null;
      window.__events.push({
        type,
        key: el ? el.dataset.xKey : null,
        tag: t ? t.tagName.toLowerCase() : '',
      });
    },
    true,
  );
}
// 表单不真正提交，链接只改 hash
document.addEventListener('submit', (e) => e.preventDefault(), true);
