/**
 * CDP (chrome.debugger) trusted input — runs in the extension context.
 *
 * Falls through to DOM synthetic events when the debugger can't be attached
 * or any command fails. Caller owns the lifecycle (attach implicitly via the
 * helpers below; detach explicitly via cdpDetach).
 */

const attached = new Set<number>();

function sendCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}
/** 同 sendCommand，但把命令结果和真实错误带回来（CDP 失败时 lastError.message 有原因）。 */
function sendCommandRaw(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>();
  try {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve({ ok: true, result: (result ?? {}) as Record<string, unknown> });
    });
  } catch (err) {
    resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return promise;
}

export async function cdpAttach(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;
  return await new Promise<boolean>((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        attached.add(tabId);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function cdpDetach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  await new Promise<void>((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
  attached.delete(tabId);
}

export async function cdpClick(
  tabId: number,
  x: number,
  y: number,
): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  const moved = await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });
  if (!moved) return false;
  const pressed = await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  if (!pressed) return false;
  return await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
}

export async function cdpInsertText(
  tabId: number,
  text: string,
): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  return await sendCommand(tabId, 'Input.insertText', { text });
}

export async function cdpWheel(
  tabId: number,
  x: number,
  y: number,
  deltaY: number,
): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  return await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY,
  });
}
/**
 * 向匹配 selector 的 <input type=file> 注入本机文件（DOM.setFileInputFiles）。
 * Chrome 浏览器进程直接读盘，不弹文件选择框；页面收到与手动选择一致的 change。
 * paths 必须是绝对路径。
 */
export async function cdpSetFiles(
  tabId: number,
  selector: string,
  paths: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!(await cdpAttach(tabId))) return { ok: false, error: 'debugger 附加失败' };
  const doc = await sendCommandRaw(tabId, 'DOM.getDocument', { depth: 0 });
  // getDocument 返回 { root: { nodeId } }（不是扁平 nodeId——曾误读导致恒 'no root'）
  const rootNode = doc.result?.root as Record<string, unknown> | undefined;
  const rootId = typeof rootNode?.nodeId === 'number' ? rootNode.nodeId : 0;
  if (!doc.ok || !rootId) return { ok: false, error: `DOM.getDocument: ${doc.error ?? 'no root'}` };
  const q = await sendCommandRaw(tabId, 'DOM.querySelector', { nodeId: rootId, selector });
  const nodeId = typeof q.result?.nodeId === 'number' ? q.result.nodeId : 0;
  if (!q.ok) return { ok: false, error: `DOM.querySelector: ${q.error ?? 'unknown'}` };
  if (!nodeId) return { ok: false, error: `元素未找到（selector ${selector} 无匹配，页面可能已重渲染）` };
  const set = await sendCommandRaw(tabId, 'DOM.setFileInputFiles', { files: paths, nodeId });
  if (!set.ok) return { ok: false, error: `DOM.setFileInputFiles: ${set.error ?? 'unknown'}` };
  return { ok: true };
}

/**
 * 开关原生文件选择框拦截（Page.setInterceptFileChooserDialog）。
 * 拦截开启后，页面 input.click() 触发的选择框不再弹出，改发
 * Page.fileChooserOpened 事件——pollFileChooserOpened 据此判定时机。
 */
export async function cdpSetFileChooserInterception(
  tabId: number,
  enabled: boolean,
): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  if (enabled) {
    // Page 域事件（fileChooserOpened）必须先 enable 才推送，否则拦截生效但事件静默丢失
    const pe = await sendCommandRaw(tabId, 'Page.enable');
    if (!pe.ok) return false;
  }
  return await sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled });
}

/** 自上次消费以来收到过 Page.fileChooserOpened 的标签页（chrome.debugger.onEvent 写入）。 */
const fileChooserTabs = new Set<number>();

export function clearFileChooserOpened(tabId: number): void {
  fileChooserTabs.delete(tabId);
}

/**
 * 轮询等待文件选择框被拦截触发（trigger click 后调用）。
 * 事件经 chrome.debugger.onEvent 异步到达，sendCommand 的同步应答拿不到它，只能轮询。
 */
export async function pollFileChooserOpened(tabId: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fileChooserTabs.has(tabId)) {
      fileChooserTabs.delete(tabId);
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 150);
    await promise;
  }
  return false;
}

// 文件选择框被拦截时记录标签页（pollFileChooserOpened 消费）。
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method) => {
    if (method === 'Page.fileChooserOpened' && typeof source.tabId === 'number') {
      fileChooserTabs.add(source.tabId);
    }
  });
}

// User dismissed the "Chrome is being debugged" infobar or navigated away.
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId !== undefined) attached.delete(tabId);
  });
}