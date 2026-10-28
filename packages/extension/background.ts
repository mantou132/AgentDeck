chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });

// Firefox: `sidebarAction` is not in the Chrome types.
const { sidebarAction } = chrome as typeof chrome & { sidebarAction?: { open: () => Promise<void> } };
chrome.action?.onClicked?.addListener(() => sidebarAction?.open());
