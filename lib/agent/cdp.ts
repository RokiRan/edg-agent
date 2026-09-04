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
  clearDialogState(tabId);
}

export async function cdpClick(
  tabId: number,
  x: number,
  y: number,
): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  // 点击触发 alert/confirm/prompt 时渲染主线程冻结，Input.dispatchMouseEvent 的
  // ack 要等渲染线程——与对话框事件竞态，打开即返回（输入已派发，dialog 流程接管），
  // 否则 sendCommand 无超时永久挂死（confirm 待 LLM 应答、LLM 等 click 返回的互等）。
  const dlg = onNextDialog(tabId);
  const sequence = (async (): Promise<boolean> => {
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
  })();
  try {
    const r = await Promise.race([sequence, dlg.promise.then(() => 'dialog' as const)]);
    if (r === 'dialog') return true;
    return r;
  } finally {
    dlg.cancel();
  }
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
/* ================= 原生 JS 对话框（alert/confirm/prompt/beforeunload） =================
 * 策略（与用户对齐的混合分流）：
 * - beforeunload：立即 accept——不接住等于拒绝、整次导航取消（CDP 硬约束，不是设计偏好）；
 * - alert：立即 accept（无分支语义），message 进 autoDialogs 供 loop 带回给 LLM（不静默吞）；
 * - confirm/prompt：不自动应答，进 pendingDialogs 上抛 LLM，由 dialog 工具调
 *   cdpHandleDialog 决策（防自动 accept「确认删除?」类不可逆分支）。
 * 事件走 chrome.debugger.onEvent，不依赖页面 JS——对话框冻结渲染主线程时照样到达。
 * 清理边界：未应答的对话框在 debugger detach 时由 Chrome 自动 cancel，
 * 不要在 detach 路径补 handleJavaScriptDialog——对话框可能已随页面销毁，
 * 补应答只会引入 lastError 竞态。
 */

/** 待 LLM 应答的对话框（confirm/prompt）。 */
export interface PendingJsDialog {
  type: 'confirm' | 'prompt';
  message: string;
  defaultPrompt: string;
}

/** 已自动应答的对话框（alert/beforeunload），message 留给 LLM 观察。 */
export interface AutoHandledDialog {
  type: 'alert' | 'beforeunload';
  message: string;
}

const pendingDialogs = new Map<number, PendingJsDialog[]>();
const autoDialogs = new Map<number, AutoHandledDialog[]>();

/** runInPage 竞态用：标签页下一次对话框事件的一次性等待者（避免页面冻结后干等 15s 超时）。 */
const dialogWaiters = new Map<number, Set<() => void>>();

/** 注册「下一次 javascriptDialogOpening」一次性通知；用毕必须 cancel 防泄漏。 */
export function onNextDialog(tabId: number): { promise: Promise<void>; cancel: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  let set = dialogWaiters.get(tabId);
  if (!set) {
    set = new Set();
    dialogWaiters.set(tabId, set);
  }
  set.add(resolve);
  return {
    promise,
    cancel: () => {
      set.delete(resolve);
    },
  };
}

/** 查看队首待应答对话框（不消费；dialog 工具应答时才 take）。 */
export function peekPendingDialog(tabId: number): PendingJsDialog | undefined {
  return pendingDialogs.get(tabId)?.[0];
}

/** 取出队首待应答对话框（dialog 工具应答时调用）。 */
export function takePendingDialog(tabId: number): PendingJsDialog | undefined {
  const list = pendingDialogs.get(tabId);
  const head = list?.shift();
  if (list && list.length === 0) pendingDialogs.delete(tabId);
  return head;
}

/** 取走并清空已自动应答的对话框记录（loop 拼进执行结果消息）。 */
export function drainAutoDialogs(tabId: number): AutoHandledDialog[] {
  const list = autoDialogs.get(tabId) ?? [];
  autoDialogs.delete(tabId);
  return list;
}

/** 短轮询等待待应答对话框出现（事件异步到达，动作后需给小窗口）。 */
export async function waitPendingDialog(tabId: number, timeoutMs = 300): Promise<PendingJsDialog | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const head = peekPendingDialog(tabId);
    if (head) return head;
    if (Date.now() >= deadline) return undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }
}

/**
 * 开启对话框监听（attach + Page.enable）。
 * Page 域事件必须先 enable 才推送，任务开始/new_tab 后各调一次（Page.enable 幂等）。
 */
export async function cdpEnableDialogWatch(tabId: number): Promise<boolean> {
  if (!(await cdpAttach(tabId))) return false;
  const pe = await sendCommandRaw(tabId, 'Page.enable');
  return pe.ok;
}

/** 应答当前打开的对话框（Page.handleJavaScriptDialog）。promptText 仅 prompt 类型有意义。 */
export async function cdpHandleDialog(
  tabId: number,
  accept: boolean,
  promptText?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await cdpAttach(tabId))) return { ok: false, error: 'debugger 附加失败' };
  const params: Record<string, unknown> = { accept };
  if (promptText !== undefined) params.promptText = promptText;
  const r = await sendCommandRaw(tabId, 'Page.handleJavaScriptDialog', params);
  if (!r.ok) return { ok: false, error: r.error ?? 'unknown' };
  return { ok: true };
}

/** detach/异常断开时清掉该标签页的对话框状态。 */
function clearDialogState(tabId: number): void {
  pendingDialogs.delete(tabId);
  autoDialogs.delete(tabId);
  dialogWaiters.delete(tabId);
}

// 文件选择框被拦截时记录标签页（pollFileChooserOpened 消费）；
// 原生对话框按混合策略分流（见上方「原生 JS 对话框」注释块）。
if (typeof chrome !== 'undefined' && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== 'number') return;
    const tabId = source.tabId;
    if (method === 'Page.fileChooserOpened') {
      fileChooserTabs.add(tabId);
      return;
    }
    if (method !== 'Page.javascriptDialogOpening') return;
    const p = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
    const type = p.type ?? '';
    // 先唤醒 runInPage 竞态（任何类型）：页面主线程已冻结，注入脚本不必再等 15s
    const waiters = dialogWaiters.get(tabId);
    if (waiters) {
      dialogWaiters.delete(tabId);
      for (const r of waiters) r();
    }
    if (type === 'beforeunload' || type === 'alert') {
      const list = autoDialogs.get(tabId) ?? [];
      list.push({ type, message: p.message ?? '' });
      autoDialogs.set(tabId, list);
      void sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept: true });
    } else if (type === 'confirm' || type === 'prompt') {
      const list = pendingDialogs.get(tabId) ?? [];
      list.push({ type, message: p.message ?? '', defaultPrompt: p.defaultPrompt ?? '' });
      pendingDialogs.set(tabId, list);
    }
  });
}

// User dismissed the "Chrome is being debugged" infobar or navigated away.
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    if (tabId !== undefined) {
      attached.delete(tabId);
      clearDialogState(tabId);
    }
  });
}