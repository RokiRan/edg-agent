/**
 * 解析"当前要操作的标签页"。
 *
 * 优先级：
 * 1. 向 background service worker 发送 'edg:getTargetTab' 消息（由 background 维护的"最近激活/更新的 http(s) 标签"映射）。
 * 2. 失败/返回 null → 回退到 chrome.tabs.query 当前窗口的 active http(s) 标签。
 */
export async function getTargetTabId(): Promise<number | null> {
  try {
    const fromBg = await chrome.runtime.sendMessage({ type: 'edg:getTargetTab' });
    const id = fromBg?.tabId;
    if (typeof id === 'number') return id;
  } catch {
    // ignore — fallback below
  }

  const { promise, resolve } = Promise.withResolvers<number | null>();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs.find((t) => typeof t.url === 'string' && /^https?:\/\//.test(t.url));
    resolve(tab?.id ?? null);
  });
  return promise;
}