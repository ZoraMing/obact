// 扩展后台只做界面相关的转发；与服务的连接放在侧边栏页面里（PRD 8.2）。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 供服务通过 CDP 调用：把一组标签页编入带名称的标签组（FR-03）。
self.obactGroup = async (tabIds, title) => {
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title, color: 'blue' });
  return groupId;
};
