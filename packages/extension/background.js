chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });

chrome.action?.onClicked?.addListener(() => {
  if (chrome.sidebarAction?.open) {
    chrome.sidebarAction.open();
  }
});
