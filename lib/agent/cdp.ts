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

// User dismissed the "Chrome is being debugged" infobar or navigated away.
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  });
}