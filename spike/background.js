// Throwaway: a popup would close when the permission prompt takes focus, so open the page as a tab.
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') }));
