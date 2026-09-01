export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-side-panel') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.sidePanel.open({ tabId });
    });
  });

  // 记录每个窗口最近激活/更新的 http(s) 标签，供 Agent 操作使用
  const lastHttpTabByWindow = new Map<number, number>();

  const isHttpUrl = (url: string | undefined): boolean =>
    typeof url === 'string' && /^https?:\/\//.test(url);

  const recordTab = (windowId: number, tabId: number, url?: string) => {
    if (isHttpUrl(url)) lastHttpTabByWindow.set(windowId, tabId);
  };

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      recordTab(windowId, tabId, tab.url);
    } catch {
      // ignore
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
    if (tab.windowId === undefined) return;
    recordTab(tab.windowId, tabId, tab.url);
  });

  chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
    const cur = lastHttpTabByWindow.get(windowId);
    if (cur === tabId) lastHttpTabByWindow.delete(windowId);
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    lastHttpTabByWindow.delete(windowId);
  });

  // Agent 循环查询"当前目标标签页"
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'edg:getTargetTab') return false;

    const resolveAsync = async (): Promise<{ tabId: number | null }> => {
      // 1) 确定窗口：消息来自扩展页面标签时用其 windowId；真实 side panel 没有 sender.tab，取最后聚焦窗口
      let winId = sender?.tab?.windowId;
      if (typeof winId !== 'number') {
        const win = await chrome.windows.getLastFocused();
        winId = win?.id;
      }
      if (typeof winId === 'number') {
        const recorded = lastHttpTabByWindow.get(winId);
        if (recorded !== undefined) return { tabId: recorded };

        // 2) 当前窗口 active http 标签
        const { promise: p1, resolve: r1 } = Promise.withResolvers<chrome.tabs.Tab[]>();
        chrome.tabs.query({ active: true, windowId: winId }, (ts) => r1(ts ?? []));
        const tabsInWin = await p1;
        const active = tabsInWin.find((t) => isHttpUrl(t.url));
        if (active?.id !== undefined) return { tabId: active.id };

        // 3) 当前窗口任意 http 标签
        const { promise: p2, resolve: r2 } = Promise.withResolvers<chrome.tabs.Tab[]>();
        chrome.tabs.query({ windowId: winId }, (ts) => r2(ts ?? []));
        const anyHttp = await p2;
        const fallback = anyHttp.find((t) => isHttpUrl(t.url));
        if (fallback?.id !== undefined) return { tabId: fallback.id };
      }

      // 4) 最后兜底：全局任一 http 标签
      const { promise: p3, resolve: r3 } = Promise.withResolvers<chrome.tabs.Tab[]>();
      chrome.tabs.query({}, (ts) => r3(ts ?? []));
      const allTabs = await p3;
      const fallbackAny = allTabs.find((t) => isHttpUrl(t.url));
      return { tabId: fallbackAny?.id ?? null };
    };

    resolveAsync().then(sendResponse);
    return true; // 表示异步响应
  });
});