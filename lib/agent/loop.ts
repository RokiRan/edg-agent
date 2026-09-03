import { chat, type ChatUsage, OutgoingMessage } from '../llm';
import {
  domSnapshot,
  showOverlay,
  hideOverlay,
  edgAct,
  cursorShow,
  type EdgActArgs,
  type PageSnapshot,
  type ElInfo,
} from './actions';
import { getTargetTabId } from './targetTab';
import { buildSystemPrompt, buildSnapshotMessage } from './prompt';
import { cdpClick, cdpInsertText, cdpWheel, cdpDetach } from './cdp';
import type { LLMSettings } from '../types';

/** 注入函数 edgAct 的返回值（含 CDP prep 分支的额外字段）。 */
type EdgActResult = { ok: boolean; info: string; [k: string]: unknown };
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
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  signal?: AbortSignal;
}

export interface AgentResult {
  status: 'done' | 'stopped' | 'failed' | 'max-steps';
  summary: string;
  /** 任务全程 LLM token 用量累计（provider 不给 usage 时各字段为 0）。 */
  usage: ChatUsage;
  /** status 为 max-steps 时携带：完整对话历史 + 目标标签页，用于无缝续跑 */
  continuation?: AgentContinuation;
}
/** max-steps 中断时的续跑状态。仅内存持有（sidepanel ref），侧栏关闭即失效。 */
export interface AgentContinuation {
  task: string;
  tabId: number;
  messages: OutgoingMessage[];
  usage: ChatUsage;
}

/** 契约定义的高危关键词正则。 */
const DANGEROUS_RE = /(submit|pay|purchase|buy|delete|remove|send|post|publish|order|支付|付款|购买|删除|移除|发送|发布|提交|下单)/i;
const DANGEROUS_URL_RE = /(checkout|payment|cart|pay)/i;

const DEFAULT_MAX_STEPS = 20;
const LOAD_POLL_MS = 500;
const LOAD_TIMEOUT_MS = 8000;
/**
 * 历史快照剪枝：snapshot-bearing user 消息（执行结果: 前缀 + 含 页面: 行）
 * 只保留最近 2 份完整内容，更早的改写为占位符。
 * 占位符保留 执行结果: 首行（mock 计数契约）与 页面: 行（场景标记），幂等。
 * 把 prompt 体积从 O(步数²) 降到 O(步数)。
 */
function isSnapshotMessage(m: OutgoingMessage): boolean {
  return (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.startsWith('执行结果:') &&
    m.content.includes('\n页面: ')
  );
}

function pruneSnapshots(messages: OutgoingMessage[]): void {
  const idxs: number[] = [];
  messages.forEach((m, i) => {
    if (isSnapshotMessage(m)) idxs.push(i);
  });
  for (const i of idxs.slice(0, -2)) {
    const c = messages[i].content as string;
    if (c.includes('（更早快照已省略）')) continue;
    const firstLine = c.slice(0, c.indexOf('\n'));
    const pageLine = c.match(/\n页面: [^\n]*/)?.[0] ?? '';
    messages[i] = { role: 'user', content: `${firstLine}${pageLine}\n（更早快照已省略）` };
  }
}

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

/** 终态出口附带 cdpDetach（chrome.debugger 已在 cdp.ts 内部对 lastError 自容错）。 */
async function safeCdpDetach(tabId: number): Promise<void> {
  try {
    await cdpDetach(tabId);
  } catch {
    // ignore
  }
}

let lastPageError: string | null = null;

/** 连续动作失败计数；触发视觉步注入阈值。 */
let consecutiveFail = 0;

/** 在指定标签页执行一个自包含函数（必须来自 ./actions），并取回结果。 */
async function runInPage<T>(tabId: number, func: (...args: any[]) => unknown, args: unknown[]): Promise<T | null> {
  const inject = async (): Promise<T | null> => {
    const res = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args }),
      new Promise<null>((r) => setTimeout(() => r(null), 15000)),
    ]);
    if (res === null) throw new Error('页面脚本执行超时（15s）');
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
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 未闭合 think（推理被 max_tokens 截断时）：其后全是推理内容，整体剥掉
  s = s.replace(/<think>[\s\S]*$/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 提取第一个配平 JSON 对象（字符串感知：忽略串内引号/括号）。
  // 不能用 lastIndexOf('}')——模型在 JSON 后追加的正文（如含 } 的 Markdown 试卷正文）
  // 会把尾随垃圾切进结果导致 parse 失败；配平扫描只取首个完整对象，尾随正文丢弃。
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
/** 单趟反转义 JSON 字符串内容（容忍尾部半个转义——截断场景）。 */
function unescapeJsonString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    i++;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default: out += next;
    }
  }
  return out;
}

/**
 * 截断抢救：模型在 done.summary 里写长交付时被 max_tokens 截断，
 * JSON 永不闭合 → extractJson 返回 null。此时把已写出的 summary 内容
 * 尽力反转义救出，好过整体失败。只在工具是 done 且 summary 有实质内容时生效。
 */
function salvageDoneSummary(raw: string): string | null {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  const body = s.slice(start);
  if (!/"tool"\s*:\s*"done"/.test(body)) return null;
  const m = body.match(/"summary"\s*:\s*"([\s\S]*)$/);
  if (!m) return null;
  const inner = unescapeJsonString(m[1]).trim();
  return inner.length >= 20 ? inner : null;
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
  opts?: { resume?: AgentContinuation },
): Promise<AgentResult> {
  const { onStep, onConfirmRequired, onAskUser, signal } = handlers;
  const rawMax = Number(settings.maxSteps);
  const maxSteps = Number.isFinite(rawMax)
    ? Math.min(Math.max(Math.floor(rawMax), 1), 100)
    : DEFAULT_MAX_STEPS;
  lastPageError = null;

  consecutiveFail = 0;
  const resume = opts?.resume;
  const totalUsage: ChatUsage = resume ? { ...resume.usage } : { prompt: 0, completion: 0 };

  let tabId: number;
  if (resume) {
    // 续跑：回到原标签页；页已关闭则无法继续
    tabId = resume.tabId;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return { status: 'failed', summary: '原标签页已关闭，无法继续任务', usage: totalUsage };
    }
  } else {
    const resolvedTabId = await getTargetTabId();
    if (resolvedTabId === null) {
      return { status: 'failed', summary: '找不到可操作的标签页', usage: totalUsage };
    }
    tabId = resolvedTabId;
  }
  const targetTab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(targetTab.url ?? '')) {
    return {
      status: 'failed',
      summary: '当前页面不支持自动化（chrome://、新建标签页、应用商店等页面不可用），请切换到普通网页后再试',
      usage: totalUsage,
    };
  }

  // 首轮：取快照 + 显示 overlay
  let snapshot = await runInPage<PageSnapshot>(tabId, domSnapshot, []);
  if (!snapshot) {
    await safeCdpDetach(tabId);
    safeHideOverlay(tabId);
    const errMsg = lastPageError ?? '未知错误';
    const isPerm = /Cannot access|permission|未授予/i.test(errMsg);
    return {
      status: 'failed',
      summary: isPerm ? '没有页面访问权限，请点击允许后重试' : `页面操作失败: ${errMsg.slice(0, 200)}`,
      usage: totalUsage,
    };
  }
  await runInPage<unknown>(tabId, showOverlay, []);
  await runInPage<unknown>(tabId, cursorShow, []);

  const messages: OutgoingMessage[] = resume
    ? [
        // 续跑：完整历史 + 一条「继续」指令和最新快照（页面可能已变化，旧元素 id 作废）
        ...resume.messages,
        {
          role: 'user',
          content: `用户要求继续。原始任务不变: ${task}\n已完成的步骤不要重复，基于当前页面状态继续推进，直到任务完成。\n\n最新页面:\n\n${buildSnapshotMessage(snapshot, { pageText: true })}`,
        },
      ]
    : [
        { role: 'system', content: buildSystemPrompt() },
        {
          role: 'user',
          content: `任务: ${task}\n\n${buildSnapshotMessage(snapshot, { pageText: true })}`,
        },
      ];

  let lastSummary = '';
  let consecutiveFormatErrors = 0;
  /** 最近一次 chat 的 finish_reason，格式错误终态诊断用 */
  let lastFinishReason: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      await safeCdpDetach(tabId);
      safeHideOverlay(tabId);
      return { status: 'stopped', summary: '用户已中止', usage: totalUsage };
    }

    // 视觉兜底：连续失败 >=2 时，先发一张截图提示 LLM 用坐标动作
    if (consecutiveFail >= 2) {
      const snapshotText = buildSnapshotMessage(snapshot);
      try {
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 70,
        });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `DOM 操作已连续失败 ${consecutiveFail} 次。附当前页面截图。若元素 id 不可用，请用坐标动作 {"tool":"click_at","x":0到1的小数,"y":0到1的小数}（视口归一化坐标）点击目标，或用 {"tool":"type_focused","text":"..."} 在当前焦点输入。也可以继续用元素 id 动作或 done。\n\n页面信息:\n` +
                snapshotText,
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        });
        consecutiveFail = 0;
      } catch {
        // captureVisibleTab 失败时跳过视觉步，按原样继续
      }
    }

    let raw: string;
    try {
      // 格式错误后的重试：加大 token 预算兜住推理模型的长 think，
      // 温度非零打破 temperature:0 下两次重试输出完全相同的死局
      const isFormatRetry = consecutiveFormatErrors > 0;
      const resp = await chat(settings, messages, undefined, {
        maxTokens: isFormatRetry ? 8192 : undefined,
        temperature: isFormatRetry ? 0.2 : undefined,
      });
      raw = resp.content;
      lastFinishReason = resp.finishReason;
      if (resp.usage) {
        totalUsage.prompt += resp.usage.prompt;
        totalUsage.completion += resp.usage.completion;
      }
    } catch (err) {
      await safeCdpDetach(tabId);
      safeHideOverlay(tabId);
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', summary: `LLM 调用失败: ${msg}`, usage: totalUsage };
    }
    const json = extractJson(raw);
    if (!json) {
      consecutiveFormatErrors++;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: '格式错误：请只回复一个 JSON 动作对象，不要输出任何解释、问候、前后缀文字或思考过程，直接输出 JSON' });
      if (consecutiveFormatErrors >= 2) {
        await safeCdpDetach(tabId);
        safeHideOverlay(tabId);
        // 长交付被 max_tokens 截断的兜底：done.summary 写了一半断掉时，
        // 把已写出的内容抢救出来返回给用户，而不是整体失败
        const salvaged = salvageDoneSummary(raw);
        if (salvaged) {
          const summary = `${salvaged}\n\n（模型输出达到长度上限被截断，以上内容可能不完整，可发「继续」让我补全）`;
          lastSummary = summary;
          onStep({ tool: 'done', args: { summary: `${salvaged.slice(0, 30)}…（截断抢救）` }, ok: true, info: summary });
          return { status: 'done', summary, usage: totalUsage };
        }
        const diag = ` [finish_reason=${lastFinishReason ?? '?'}, 输出长度=${raw.length}]`;
        return { status: 'failed', summary: `模型输出格式错误: ${raw.replace(/\s+/g, ' ').slice(0, 120)}${diag}`, usage: totalUsage };
      }
      continue;
    }

    let action: { tool: string; [k: string]: unknown };
    try {
      action = JSON.parse(json);
    } catch {
      consecutiveFormatErrors++;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: '格式错误：请只回复一个 JSON 动作对象，不要输出任何解释、问候、前后缀文字或思考过程，直接输出 JSON' });
      if (consecutiveFormatErrors >= 2) {
        await safeCdpDetach(tabId);
        safeHideOverlay(tabId);
        const diag = ` [finish_reason=${lastFinishReason ?? '?'}, 输出长度=${raw.length}]`;
        return { status: 'failed', summary: `模型输出格式错误: ${raw.replace(/\s+/g, ' ').slice(0, 120)}${diag}`, usage: totalUsage };
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
          await safeCdpDetach(tabId);
          safeHideOverlay(tabId);
          return { status: 'failed', summary: '用户拒绝了高危操作', usage: totalUsage };
        }
      }
    }

    const argsForStep: Record<string, unknown> = { ...action };
    delete argsForStep.tool;

    let ok = false;
    let info = '';

    if (tool === 'click') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['click_prep', { id } as EdgActArgs])) ?? { ok: false, info: 'no result' };
      if (!prep.ok) {
        ok = false;
        info = prep.info ?? 'element not found';
      } else {
        const cdpOk = await cdpClick(tabId, Number(prep.x), Number(prep.y));
        if (cdpOk) {
          await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs]);
          ok = true;
          info = String(prep.info);
        } else {
          const r = (await runInPage<EdgActResult>(tabId, edgAct, ['click', { id } as EdgActArgs])) ?? { ok: false, info: 'no result' };
          ok = !!r.ok;
          info = r.ok ? `${r.info} (dom)` : r.info;
        }
      }
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
      const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['type_prep', { id, text } as EdgActArgs])) ?? { ok: false, info: 'no result' };
      if (!prep.ok) {
        ok = false;
        info = prep.info ?? 'element not found';
      } else {
        const cdpOk = await cdpInsertText(tabId, text);
        if (cdpOk) {
          await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs]);
          ok = true;
          info = String(prep.info);
        } else {
          const r = (await runInPage<EdgActResult>(tabId, edgAct, ['type', { id, text } as EdgActArgs])) ?? { ok: false, info: 'no result' };
          ok = !!r.ok;
          info = r.ok ? `${r.info} (dom)` : r.info;
        }
      }
    } else if (tool === 'select') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const value = typeof action.value === 'string' ? action.value : '';
      const res = (await runInPage<EdgActResult>(tabId, edgAct, ['select', { id, value } as EdgActArgs])) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
      if (!ok && /not a select element/i.test(info)) {
        // 失败点强引导：前置提示词对中档模型不够，在报错处直接给恢复路径
        info += '（目标不是原生 <select>：这是组件库自定义下拉，请 click 该元素展开浮层，然后从快照顶部浮层选项中 click 目标项，不要再用 select 工具）';
      }
    } else if (tool === 'scroll') {
      const dir = (typeof action.direction === 'string' ? action.direction : 'down') as
        | 'up'
        | 'down'
        | 'top'
        | 'bottom';
      const vs = (await runInPage<EdgActResult>(tabId, edgAct, ['viewport_size', {} as EdgActArgs])) ?? { ok: false, info: 'no result' };
      const deltaY = dir === 'down' ? 600 : dir === 'up' ? -600 : 0;
      const canWheel = vs.ok && (dir === 'down' || dir === 'up');
      let wheeled = false;
      if (canWheel) {
        const w = Number(vs.w);
        const h = Number(vs.h);
        wheeled = await cdpWheel(tabId, w / 2, h / 2, deltaY);
      }
      if (wheeled) {
        await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs]);
        ok = true;
        info = `scrolled ${dir}`;
      } else {
        const res = (await runInPage<EdgActResult>(tabId, edgAct, ['scroll', { direction: dir } as EdgActArgs])) ?? { ok: false, info: 'no result' };
        ok = !!res.ok;
        info = res.info;
      }
    } else if (tool === 'click_at') {
      // 已知取舍：坐标动作无法判定目标文本，跳过高危闸
      const x = typeof action.x === 'number' ? action.x : NaN;
      const y = typeof action.y === 'number' ? action.y : NaN;
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
        ok = false;
        info = 'invalid coordinates';
      } else {
        const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['click_at_prep', { x, y } as EdgActArgs])) ?? { ok: false, info: 'no result' };
        if (!prep.ok) {
          ok = false;
          info = prep.info ?? 'no element at point';
        } else {
          const cdpOk = await cdpClick(tabId, Number(prep.x), Number(prep.y));
          if (cdpOk) {
            await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs]);
            ok = true;
            info = String(prep.info);
          } else {
            const r = (await runInPage<EdgActResult>(tabId, edgAct, ['click_at', { x, y } as EdgActArgs])) ?? { ok: false, info: 'no result' };
            ok = !!r.ok;
            info = r.ok ? `${r.info} (dom)` : r.info;
          }
        }
      }
    } else if (tool === 'type_focused') {
      // 已知取舍：focused 动作无法从快照确定目标文本，跳过高危闸
      const text = typeof action.text === 'string' ? action.text : '';
      const res = (await runInPage<EdgActResult>(tabId, edgAct, ['type_focused', { text } as EdgActArgs])) ?? { ok: false, info: 'no result' };
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
      const created = await promise;
      if (created?.id !== undefined) {
        await safeCdpDetach(tabId);
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
      const rawOpts = action.options;
      const options = Array.isArray(rawOpts)
        ? rawOpts.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 8)
        : undefined;
      let answer = '';
      try {
        answer = await onAskUser(question, options && options.length > 0 ? options : undefined);
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
      pruneSnapshots(messages);
      onStep({ tool, args: argsForStep, ok, info });
      continue;
    } else if (tool === 'read_page') {
      // 按需读取正文：快照默认不含 pageText，LLM 显式索取时才回传（省 token）
      snapshot = (await runInPage(tabId, domSnapshot, [])) ?? snapshot;
      ok = true;
      info = `页面正文: ${snapshot.pageText || '(无正文)'}`;
      messages.push({
        role: 'user',
        content: `执行结果: ${info}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
      });
      pruneSnapshots(messages);
      onStep({ tool, args: argsForStep, ok, info });
      continue;
    } else if (tool === 'done') {
      await safeCdpDetach(tabId);
      const summary = typeof action.summary === 'string' ? action.summary : '任务完成';
      lastSummary = summary;
      onStep({ tool, args: argsForStep, ok: true, info: summary });
      safeHideOverlay(tabId);
      return { status: 'done', summary, usage: totalUsage };
    } else {
      ok = false;
      info = `unknown tool ${tool}`;
    }

    // 仅对六个页面动作（click/type/select/scroll/click_at/type_focused）累计连续失败
    // navigate/new_tab/ask_user/done/unknown 不计入
    if (
      tool === 'click' ||
      tool === 'type' ||
      tool === 'select' ||
      tool === 'scroll' ||
      tool === 'click_at' ||
      tool === 'type_focused'
    ) {
      if (ok) {
        consecutiveFail = 0;
      } else {
        consecutiveFail++;
      }
    }

    onStep({ tool, args: argsForStep, ok, info });

    snapshot = (await runInPage(tabId, domSnapshot, [])) ?? snapshot;
    messages.push({
      role: 'user',
      content: `执行结果: ${ok ? info : `失败 - ${info}`}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
    });
    pruneSnapshots(messages);
  }

  await safeCdpDetach(tabId);
  safeHideOverlay(tabId);
  return {
    status: 'max-steps',
    summary: lastSummary || `已达最大步数 ${maxSteps}`,
    usage: totalUsage,
    continuation: { task, tabId, messages, usage: totalUsage },
  };
}