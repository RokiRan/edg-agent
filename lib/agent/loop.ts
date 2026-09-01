import { chat, type OutgoingMessage } from '../llm';
import {
  domSnapshot,
  showOverlay,
  hideOverlay,
  actClick,
  actType,
  actSelect,
  actScroll,
  type PageSnapshot,
  type ElInfo,
} from './actions';
import { getTargetTabId } from './targetTab';
import { buildSystemPrompt, buildSnapshotMessage } from './prompt';
import type { LLMSettings } from '../types';

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  info: string;
}

export interface ConfirmRequest {
  reason: string;
  actionJson: string;
}

export interface AgentHandlers {
  onStep: (step: AgentStep) => void;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  onAskUser: (question: string) => Promise<string>;
  signal?: AbortSignal;
}

export interface AgentResult {
  status: 'done' | 'stopped' | 'failed' | 'max-steps';
  summary: string;
}

/** 契约定义的高危关键词正则。 */
const DANGEROUS_RE = /(submit|pay|purchase|buy|delete|remove|send|post|publish|order|支付|付款|购买|删除|移除|发送|发布|提交|下单)/i;
const DANGEROUS_URL_RE = /(checkout|payment|cart|pay)/i;

const MAX_STEPS = 20;
const LOAD_POLL_MS = 500;
const LOAD_TIMEOUT_MS = 8000;

/** 安全地清掉页面 overlay（页面可能已经跳转，try/catch 容错）。 */
function safeHideOverlay(tabId: number): void {
  try {
    chrome.scripting.executeScript({ target: { tabId }, func: hideOverlay }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore
  }
}

type PageFunc = (...args: unknown[]) => unknown;
/** runInPage 最近一次失败的真实原因（供上层报错透传）。 */
let lastPageError: string | null = null;

/** 在指定标签页执行一个自包含函数（必须来自 ./actions），并取回结果。 */
async function runInPage<T>(tabId: number, func: PageFunc, args: unknown[]): Promise<T | null> {
  const inject = async (): Promise<T | null> => {
    const res = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return (res?.[0]?.result as T | undefined) ?? null;
  };

  try {
    return await inject();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastPageError = msg;
    if (/Cannot access|permission/i.test(msg)) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      chrome.permissions.request({ origins: ['<all_urls>'] }, (ok) => resolve(!!ok));
      const granted = await promise;
      if (granted) {
        try {
          return await inject();
        } catch (retryErr) {
          lastPageError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return null;
        }
      }
      lastPageError = '用户未授予页面访问权限';
    }
    return null;
  }
}

/** 轮询直到 loading 完成（8s 超时）。 */
async function waitForTabComplete(tabId: number): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<chrome.tabs.Tab | undefined>();
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return resolve(undefined);
      resolve(t);
    });
    const tab = await promise;
    if (!tab || tab.status === 'complete') return;
    const { promise: sleepP, resolve: sleepR } = Promise.withResolvers<void>();
    setTimeout(sleepR, LOAD_POLL_MS);
    await sleepP;
  }
}

/** 从模型原始文本中抽出 JSON 主体（去 ```json 围栏）。 */
function extractJson(raw: string): string | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function dangerReason(
  action: { tool: string; id?: number },
  el: ElInfo | undefined,
  url: string,
): string {
  const verb = action.tool === 'type' ? '向' : '点击';
  if (el) {
    const label = el.text || el.placeholder || el.href || el.tag;
    const pageNote = DANGEROUS_URL_RE.test(url) ? `（当前页面 URL 含敏感关键词）` : '';
    return `该操作将${verb}「${label}」，可能产生实际后果（支付/删除/发送/提交等）${pageNote}。请确认无误后再继续。`;
  }
  if (DANGEROUS_URL_RE.test(url)) {
    return `当前页面 URL 含敏感关键词（${url}），该操作可能产生实际后果，请确认无误后再继续。`;
  }
  return '该操作可能产生实际后果，请确认无误后再继续。';
}

/**
 * 主入口：浏览器操作代理循环。
 */
export async function runAgentTask(
  task: string,
  settings: LLMSettings,
  handlers: AgentHandlers,
): Promise<AgentResult> {
  const { onStep, onConfirmRequired, onAskUser, signal } = handlers;
  lastPageError = null;

  let tabId = await getTargetTabId();
  if (tabId === null) {
    return { status: 'failed', summary: '找不到可操作的标签页' };
  }

  // 首轮：取快照 + 显示 overlay
  let snapshot = await runInPage<PageSnapshot>(tabId, domSnapshot, []);
  if (!snapshot) {
    safeHideOverlay(tabId);
    const errMsg = lastPageError ?? '未知错误';
    const isPerm = /Cannot access|permission|未授予/i.test(errMsg);
    return {
      status: 'failed',
      summary: isPerm ? '没有页面访问权限，请点击允许后重试' : `页面操作失败: ${errMsg.slice(0, 200)}`,
    };
  }
  await runInPage<unknown>(tabId, showOverlay, []);

  const messages: OutgoingMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: `任务: ${task}\n\n${buildSnapshotMessage(snapshot)}`,
    },
  ];

  let lastSummary = '';
  let consecutiveFormatErrors = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) {
      safeHideOverlay(tabId);
      return { status: 'stopped', summary: '用户已中止' };
    }

    let raw: string;
    try {
      raw = await chat(settings, messages);
    } catch (err) {
      safeHideOverlay(tabId);
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', summary: `LLM 调用失败: ${msg}` };
    }

    const json = extractJson(raw);
    if (!json) {
      consecutiveFormatErrors++;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: '格式错误，请只回复一个 JSON 动作' });
      if (consecutiveFormatErrors >= 2) {
        safeHideOverlay(tabId);
        return { status: 'failed', summary: '模型输出格式错误' };
      }
      continue;
    }

    let action: { tool: string; [k: string]: unknown };
    try {
      action = JSON.parse(json);
    } catch {
      consecutiveFormatErrors++;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: '格式错误，请只回复一个 JSON 动作' });
      if (consecutiveFormatErrors >= 2) {
        safeHideOverlay(tabId);
        return { status: 'failed', summary: '模型输出格式错误' };
      }
      continue;
    }
    consecutiveFormatErrors = 0;

    messages.push({ role: 'assistant', content: raw });

    // 高危闸
    const tool = action.tool;
    if (tool === 'click' || tool === 'type') {
      const targetId = typeof action.id === 'number' ? action.id : -1;
      const el = snapshot.elements.find((e) => e.id === targetId);
      if ((el && DANGEROUS_RE.test(el.text)) || DANGEROUS_URL_RE.test(snapshot.url)) {
        const req: ConfirmRequest = {
          reason: dangerReason(action, el, snapshot.url),
          actionJson: JSON.stringify(action),
        };
        let allowed = false;
        try {
          allowed = await onConfirmRequired(req);
        } catch {
          allowed = false;
        }
        if (!allowed) {
          safeHideOverlay(tabId);
          return { status: 'failed', summary: '用户拒绝了高危操作' };
        }
      }
    }

    const argsForStep: Record<string, unknown> = { ...action };
    delete argsForStep.tool;

    let ok = false;
    let info = '';

    if (tool === 'click') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const res = (await runInPage(tabId, actClick, [id])) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
      // 等可能的跳页
      const { promise: waitP, resolve: waitR } = Promise.withResolvers<void>();
      setTimeout(waitR, 800);
      await waitP;
      const { promise, resolve } = Promise.withResolvers<chrome.tabs.Tab | undefined>();
      chrome.tabs.get(tabId, (tt) => {
        if (chrome.runtime.lastError) return resolve(undefined);
        resolve(tt);
      });
      const t = await promise;
      if (t?.status === 'loading') {
        await waitForTabComplete(tabId);
      }
    } else if (tool === 'type') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const text = typeof action.text === 'string' ? action.text : '';
      const res = (await runInPage(tabId, actType, [id, text])) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
    } else if (tool === 'select') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const value = typeof action.value === 'string' ? action.value : '';
      const res = (await runInPage(tabId, actSelect, [id, value])) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
    } else if (tool === 'scroll') {
      const dir = (typeof action.direction === 'string' ? action.direction : 'down') as
        | 'up'
        | 'down'
        | 'top'
        | 'bottom';
      const res = (await runInPage(tabId, actScroll, [dir])) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
    } else if (tool === 'navigate') {
      const url = typeof action.url === 'string' ? action.url : '';
      const { promise, resolve } = Promise.withResolvers<void>();
      chrome.tabs.update(tabId, { url }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
      await promise;
      await waitForTabComplete(tabId);
      ok = true;
      info = `navigated to ${url}`;
    } else if (tool === 'new_tab') {
      const url = typeof action.url === 'string' ? action.url : '';
      const { promise, resolve } = Promise.withResolvers<chrome.tabs.Tab | undefined>();
      chrome.tabs.create({ url }, (t) => {
        if (chrome.runtime.lastError) return resolve(undefined);
        resolve(t);
      });
      if (created?.id !== undefined) {
        tabId = created.id;
        await waitForTabComplete(created.id);
        ok = true;
        info = `opened new tab ${created.id} with ${url}`;
      } else {
        ok = false;
        info = 'failed to create tab';
      }
    } else if (tool === 'ask_user') {
      const question = typeof action.question === 'string' ? action.question : '';
      let answer = '';
      try {
        answer = await onAskUser(question);
      } catch {
        answer = '';
      }
      ok = true;
      info = `用户回答: ${answer}`;
      snapshot = (await runInPage(tabId, domSnapshot, [])) ?? snapshot;
      messages.push({
        role: 'user',
        content: `执行结果: ${info}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
      });
      onStep({ tool, args: argsForStep, ok, info });
      continue;
    } else if (tool === 'done') {
      const summary = typeof action.summary === 'string' ? action.summary : '任务完成';
      lastSummary = summary;
      onStep({ tool, args: argsForStep, ok: true, info: summary });
      safeHideOverlay(tabId);
      return { status: 'done', summary };
    } else {
      ok = false;
      info = `unknown tool ${tool}`;
    }

    onStep({ tool, args: argsForStep, ok, info });

    snapshot = (await runInPage(tabId, domSnapshot, [])) ?? snapshot;
    messages.push({
      role: 'user',
      content: `执行结果: ${ok ? info : `失败 - ${info}`}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
    });
  }

  safeHideOverlay(tabId);
  return { status: 'max-steps', summary: lastSummary || `已达最大步数 ${MAX_STEPS}` };
}