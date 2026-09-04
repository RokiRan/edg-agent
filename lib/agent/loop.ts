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
import {
  cdpClick,
  cdpInsertText,
  cdpWheel,
  cdpDetach,
  cdpSetFiles,
  cdpSetFileChooserInterception,
  pollFileChooserOpened,
  clearFileChooserOpened,
  cdpEnableDialogWatch,
  cdpHandleDialog,
  peekPendingDialog,
  takePendingDialog,
  drainAutoDialogs,
  waitPendingDialog,
  onNextDialog,
} from './cdp';
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
/** 当前控制的标签页信息（回流 UI 展示用）。 */
export interface TargetTabInfo {
  tabId: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

/** 此前已完成任务的上下文摘要（跨任务连续性：注入后续任务的首条消息）。 */
export interface PriorTurn {
  task: string;
  summary: string;
}

export interface AgentHandlers {
  onStep: (step: AgentStep) => void;
  onConfirmRequired: (req: ConfirmRequest) => Promise<boolean>;
  onAskUser: (question: string, options?: string[]) => Promise<string>;
  /** 控制标签页确立/变化/标题更新时上报（任务开始、每步结束、换 tab 后）。 */
  onTargetTab?: (tab: TargetTabInfo) => void;
  /** 拉取用户在任务进行中补充的指令队列（取出即清空，注入对话历史）。 */
  getSteering?: () => string[];
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
/** 用户中止：统一走 stopped 出口的专用错误（与业务失败区分）。 */
class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/**
 * 让本身不支持 abort 的异步调用（chrome.* 回调 API、确认/提问等待）
 * 在 signal 触发时立即 reject——底层调用可能仍在飞，但 loop 不再等它。
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AbortedError());
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    }),
  ]);
}

/** 在指定标签页执行一个自包含函数（必须来自 ./actions），并取回结果。signal 中止时立即 reject AbortedError。 */
async function runInPage<T>(tabId: number, func: (...args: any[]) => unknown, args: unknown[], signal?: AbortSignal): Promise<T | null> {
  const inject = async (): Promise<T | null> => {
    // 已有待应答对话框（confirm/prompt）：页面已冻结，executeScript 注定 15s 超时，
    // 同步短路返回 null
    if (peekPendingDialog(tabId)) {
      lastPageError = '页面被原生对话框（alert/confirm/prompt）阻断';
      return null;
    }
    // 原生对话框（alert/confirm/prompt）冻结页面主线程时 executeScript 不会返回，
    // 与对话框事件竞态：立刻软失败（返回 null），不烧 15s 超时。
    const dlg = onNextDialog(tabId);
    const res = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args }),
      new Promise<null>((r) => setTimeout(() => r(null), 15000)),
      dlg.promise.then(() => 'dialog' as const),
    ]);
    dlg.cancel();
    if (res === 'dialog') {
      lastPageError = '页面被原生对话框（alert/confirm/prompt）阻断';
      return null;
    }
    if (res === null) throw new Error('页面脚本执行超时（15s）');
    return (res?.[0]?.result as T | undefined) ?? null;
  };

  const run = async (): Promise<T | null> => {
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
  };
  return abortable(run(), signal);
}

/** 轮询直到 loading 完成（8s 超时）。signal 中止时立即 reject AbortedError。 */
async function waitForTabComplete(tabId: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
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
  // 工具白名单：tool 写了且不是 done → 不救（其它工具没有 summary 交付语义）；
  // tool 还没写到（截断更早）→ summary 键只有 done 有，仍可救。
  const toolM = body.match(/"tool"\s*:\s*"(\w+)"/);
  if (toolM && toolM[1] !== 'done') return null;
  const m = body.match(/"summary"\s*:\s*"([\s\S]*)$/);
  if (!m) return null;
  // 形状守卫：捕获段含未转义引号 = summary 字符串已闭合、截断点在后面的键上，
  // 贪婪捕获会把别的键值当 summary 内容——不是本兜底处理的形状，不救。
  for (let i = 0; i < m[1].length; i++) {
    if (m[1][i] === '\\') i++;
    else if (m[1][i] === '"') return null;
  }
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
  opts?: { resume?: AgentContinuation; priorTurns?: PriorTurn[] },
): Promise<AgentResult> {
  const { onStep, onConfirmRequired, onAskUser, onTargetTab, getSteering, signal } = handlers;
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

  /** 上报当前控制的标签页（标题/URL 会随导航变化，每步结束刷一次）。 */
  const reportTab = async (): Promise<void> => {
    if (!onTargetTab) return;
    try {
      const t = await chrome.tabs.get(tabId);
      onTargetTab({ tabId, title: t.title ?? '', url: t.url ?? '', favIconUrl: t.favIconUrl });
    } catch {
      // 标签页已关闭——后续步骤会自然失败
    }
  };
  await reportTab();

  // 首轮：取快照 + 显示 overlay
  let snapshot = await runInPage<PageSnapshot>(tabId, domSnapshot, [], signal);
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
  await runInPage<unknown>(tabId, showOverlay, [], signal);
  await runInPage<unknown>(tabId, cursorShow, [], signal);
  // 开启原生对话框监听（attach + Page.enable）：必须在首个动作前完成，
  // 否则 beforeunload/confirm 事件静默丢失，navigate 会被对话框卡死
  await cdpEnableDialogWatch(tabId);

  // 跨任务上下文连续性：本会话此前完成的任务摘要注入首条消息
  // （resume 续跑自带完整历史，不需要）。
  const priorTurns = resume ? undefined : opts?.priorTurns;
  const historyNote =
    priorTurns && priorTurns.length > 0
      ? `\n\n此前本会话已完成的任务（上下文参考，不要重复执行；如与当前任务相关可复用其结论）:\n${priorTurns
          .map((t, i) => `${i + 1}. 任务: ${t.task}\n   结果: ${t.summary}`)
          .join('\n')}`
      : '';

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
          content: `任务: ${task}${historyNote}\n\n${buildSnapshotMessage(snapshot, { pageText: true })}`,
        },
      ];

  /** 取出并注入用户进行中的补充指令；返回注入条数。 */
  const drainSteering = (): number => {
    const steers = getSteering?.() ?? [];
    for (const text of steers) {
      messages.push({
        role: 'user',
        content: `用户插话: ${text}\n（以上是用户在任务进行中补充的指令。请结合当前页面状态继续推进任务；若与原任务冲突，以最新指令为准。）`,
      });
    }
    if (steers.length > 0) {
      onStep({ tool: 'steer', args: { text: steers.join(' | ') }, ok: true, info: `已接收 ${steers.length} 条用户补充指令` });
    }
    return steers.length;
  };

  let lastSummary = '';
  let consecutiveFormatErrors = 0;
  /** 最近一次 chat 的 finish_reason，格式错误终态诊断用 */
  let lastFinishReason: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    try {
      throwIfAborted(signal);
      // 步首吸收用户进行中的补充指令（不打断任务，注入对话历史）
      drainSteering();

    // 视觉兜底：连续失败 >=2 时，先发一张截图提示 LLM 用坐标动作
    if (consecutiveFail >= 2) {
      const snapshotText = buildSnapshotMessage(snapshot);
      throwIfAborted(signal);
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
      const resp = await chat(settings, messages, signal, {
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
      // 中止触发的 fetch abort 不是业务失败——交给外层 stopped 出口
      if (err instanceof AbortedError || signal?.aborted) throw err instanceof AbortedError ? err : new AbortedError();
      await safeCdpDetach(tabId);
      safeHideOverlay(tabId);
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', summary: `LLM 调用失败: ${msg}`, usage: totalUsage };
    }
    const json = extractJson(raw);
    if (!json) {
      // 截断形状（done.summary 写到一半未闭合）首轮即救：同预算重试必然再截，
      // 直接抢救省一轮 35-55s 的 LLM 往返；抢救不了（纯 think 垃圾等）才走重试。
      const salvaged = salvageDoneSummary(raw);
      if (salvaged) {
        await safeCdpDetach(tabId);
        safeHideOverlay(tabId);
        const summary = `${salvaged}\n\n（模型输出达到长度上限被截断，以上内容可能不完整，可发「继续」让我补全）`;
        lastSummary = summary;
        onStep({ tool: 'done', args: { summary: `${salvaged.slice(0, 30)}…（截断抢救）` }, ok: true, info: summary });
        return { status: 'done', summary, usage: totalUsage };
      }
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
    let confirmReason: string | null = null;
    if (tool === 'click' || tool === 'type') {
      const targetId = typeof action.id === 'number' ? action.id : -1;
      const el = snapshot.elements.find((e) => e.id === targetId);
      if ((el && DANGEROUS_RE.test(el.text)) || DANGEROUS_URL_RE.test(snapshot.url)) {
        confirmReason = dangerReason(action, el, snapshot.url);
      }
    } else if (tool === 'upload') {
      // 上传本地文件 = 数据外发，无论目标文案/URL 一律要用户确认
      const targetId = typeof action.id === 'number' ? action.id : -1;
      const el = snapshot.elements.find((e) => e.id === targetId);
      const label = el ? el.text || el.placeholder || el.tag : `#${targetId}`;
      const paths = Array.isArray(action.paths)
        ? action.paths.filter((p): p is string => typeof p === 'string')
        : [];
      confirmReason = `将把本机文件 ${paths.join(', ') || '(未指定路径)'} 上传到「${label}」（${snapshot.url}）。文件内容会发送给该网站，请确认路径与目标无误。`;
    }
    if (confirmReason) {
      const req: ConfirmRequest = {
        reason: confirmReason,
        actionJson: JSON.stringify(action),
      };
      let allowed = false;
      try {
        allowed = await abortable(onConfirmRequired(req), signal);
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        allowed = false;
      }
      if (!allowed) {
        await safeCdpDetach(tabId);
        safeHideOverlay(tabId);
        return { status: 'failed', summary: '用户拒绝了高危操作', usage: totalUsage };
      }
    }

    const argsForStep: Record<string, unknown> = { ...action };
    delete argsForStep.tool;

    let ok = false;
    let info = '';

    if (tool !== 'dialog' && peekPendingDialog(tabId)) {
      // 对话框未应答时页面 JS 冻结，任何页面动作都注定失败——直接拦截省一步往返
      ok = false;
      info = '页面有未应答的原生对话框，页面已冻结，其它工具暂时不可用。请先用 {"tool":"dialog","action":"accept"|"dismiss"} 应答';
    } else if (tool === 'click') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['click_prep', { id } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
      if (!prep.ok) {
        ok = false;
        info = prep.info ?? 'element not found';
      } else {
        const cdpOk = await cdpClick(tabId, Number(prep.x), Number(prep.y));
        if (cdpOk) {
          await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
          ok = true;
          info = String(prep.info);
        } else {
          const r = (await runInPage<EdgActResult>(tabId, edgAct, ['click', { id } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
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
        await waitForTabComplete(tabId, signal);
      }
    } else if (tool === 'type') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const text = typeof action.text === 'string' ? action.text : '';
      const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['type_prep', { id, text } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
      if (!prep.ok) {
        ok = false;
        info = prep.info ?? 'element not found';
      } else {
        const cdpOk = await cdpInsertText(tabId, text);
        if (cdpOk) {
          await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
          ok = true;
          info = String(prep.info);
        } else {
          const r = (await runInPage<EdgActResult>(tabId, edgAct, ['type', { id, text } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
          ok = !!r.ok;
          info = r.ok ? `${r.info} (dom)` : r.info;
        }
      }
    } else if (tool === 'select') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const value = typeof action.value === 'string' ? action.value : '';
      const res = (await runInPage<EdgActResult>(tabId, edgAct, ['select', { id, value } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
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
      const vs = (await runInPage<EdgActResult>(tabId, edgAct, ['viewport_size', {} as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
      const deltaY = dir === 'down' ? 600 : dir === 'up' ? -600 : 0;
      const canWheel = vs.ok && (dir === 'down' || dir === 'up');
      let wheeled = false;
      if (canWheel) {
        const w = Number(vs.w);
        const h = Number(vs.h);
        wheeled = await cdpWheel(tabId, w / 2, h / 2, deltaY);
      }
      if (wheeled) {
        await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
        ok = true;
        info = `scrolled ${dir}`;
      } else {
        const res = (await runInPage<EdgActResult>(tabId, edgAct, ['scroll', { direction: dir } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
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
        const prep = (await runInPage<EdgActResult>(tabId, edgAct, ['click_at_prep', { x, y } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
        if (!prep.ok) {
          ok = false;
          info = prep.info ?? 'no element at point';
        } else {
          const cdpOk = await cdpClick(tabId, Number(prep.x), Number(prep.y));
          if (cdpOk) {
            await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
            ok = true;
            info = String(prep.info);
          } else {
            const r = (await runInPage<EdgActResult>(tabId, edgAct, ['click_at', { x, y } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
            ok = !!r.ok;
            info = r.ok ? `${r.info} (dom)` : r.info;
          }
        }
      }
    } else if (tool === 'type_focused') {
      // 已知取舍：focused 动作无法从快照确定目标文本，跳过高危闸
      const text = typeof action.text === 'string' ? action.text : '';
      const res = (await runInPage<EdgActResult>(tabId, edgAct, ['type_focused', { text } as EdgActArgs], signal)) ?? { ok: false, info: 'no result' };
      ok = !!res.ok;
      info = res.info;
    } else if (tool === 'upload') {
      const id = typeof action.id === 'number' ? action.id : -1;
      const rawPaths = Array.isArray(action.paths)
        ? action.paths
        : typeof action.path === 'string'
          ? [action.path]
          : [];
      const paths = rawPaths
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .slice(0, 10);
      const badPath = paths.find((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p));
      const baseNames = paths.map((p) => p.split(/[\\/]/).pop() ?? p).join(', ');
      if (paths.length === 0) {
        ok = false;
        info = 'upload 需要 paths（本机绝对路径数组）；路径不明确时先用 ask_user 向用户确认，不要编造路径';
      } else if (badPath) {
        ok = false;
        info = `路径不是本机绝对路径: ${badPath}（需 / 或盘符开头）；请用 ask_user 向用户确认完整路径`;
      } else {
        const prep =
          (await runInPage<EdgActResult>(tabId, edgAct, ['upload_prep', { id } as EdgActArgs], signal)) ??
          { ok: false, info: `页面脚本未返回结果${lastPageError ? `: ${lastPageError}` : ''}` };
        if (!prep.ok) {
          ok = false;
          info = prep.info ?? 'element not found';
        } else if (prep.kind === 'input') {
          // 可见 file input：直接注入，不点不弹框
          const set = await cdpSetFiles(tabId, `[data-edg-id="${id}"]`, paths);
          await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
          ok = set.ok;
          info = set.ok
            ? `已注入 ${paths.length} 个文件: ${baseNames}`
            : `文件注入失败: ${set.error ?? '未知原因'}（路径: ${paths.join(', ')}）`;
        } else if (prep.kind === 'drop') {
          // 纯拖拽区：影子 input 已就位（data-edg-upload=1），喂文件后回页面合成 drop 事件
          const set = await cdpSetFiles(tabId, '[data-edg-upload="1"]', paths);
          if (!set.ok) {
            await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
            ok = false;
            info = `文件注入失败: ${set.error ?? '未知原因'}（路径: ${paths.join(', ')}）`;
          } else {
            const drop =
              (await runInPage<EdgActResult>(tabId, edgAct, ['upload_drop', { x: Number(prep.x), y: Number(prep.y) } as EdgActArgs], signal)) ??
              { ok: false, info: `页面脚本未返回结果${lastPageError ? `: ${lastPageError}` : ''}` };
            await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
            ok = !!drop.ok;
            info = drop.info;
          }
        } else {
          // 触发器路径：拦截原生文件选择框 → CDP 点击 → 等选择框事件 → 往隐藏 input 喂文件
          clearFileChooserOpened(tabId);
          const armed = await cdpSetFileChooserInterception(tabId, true);
          if (!armed) {
            ok = false;
            info = 'debugger 附加失败，无法拦截文件选择框';
          } else {
            const clicked = await cdpClick(tabId, Number(prep.x), Number(prep.y));
            const opened = clicked && (await pollFileChooserOpened(tabId, 5000));
            void cdpSetFileChooserInterception(tabId, false);
            await runInPage(tabId, edgAct, ['action_done', {} as EdgActArgs], signal);
            if (!opened) {
              ok = false;
              info = '点击后未弹出文件选择框（该元素可能不是上传按钮）；如页面只有拖拽区，请用 ask_user 请用户手动拖入文件';
            } else {
              const set = await cdpSetFiles(tabId, '[data-edg-upload="1"]', paths);
              ok = set.ok;
              info = set.ok
                ? `已注入 ${paths.length} 个文件: ${baseNames}`
                : `文件注入失败: ${set.error ?? '未知原因'}（路径: ${paths.join(', ')}）`;
            }
          }
        }
        // 上传后页面常做异步校验/预览，稍等再取快照
        if (ok) {
          const { promise: waitP, resolve: waitR } = Promise.withResolvers<void>();
          setTimeout(waitR, 800);
          await waitP;
        }
      }
    } else if (tool === 'navigate') {
      const url = typeof action.url === 'string' ? action.url : '';
      const { promise, resolve } = Promise.withResolvers<void>();
      chrome.tabs.update(tabId, { url }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
      await promise;
      await waitForTabComplete(tabId, signal);
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
        await waitForTabComplete(created.id, signal);
        // 新标签页重新开启对话框监听（cdpDetach 已清掉旧页状态）
        await cdpEnableDialogWatch(tabId);
        ok = true;
        info = `opened new tab ${created.id} with ${url}`;
      } else {
        ok = false;
        info = 'failed to create tab';
      }
    } else if (tool === 'dialog') {
      // 应答原生 confirm/prompt（alert/beforeunload 已在 cdp.ts 事件监听里自动应答）
      const pend = takePendingDialog(tabId);
      if (!pend) {
        ok = false;
        info = '当前没有等待应答的对话框（可能已被页面自动关闭），请基于最新快照继续任务';
      } else {
        const accept = action.action !== 'dismiss';
        const text = typeof action.text === 'string' ? action.text : undefined;
        const r = await cdpHandleDialog(tabId, accept, pend.type === 'prompt' ? text : undefined);
        ok = r.ok;
        info = r.ok
          ? `已${accept ? '确认' : '取消'}${pend.type === 'prompt' ? '输入对话框' : '确认对话框'}: "${pend.message}"${pend.type === 'prompt' && accept && text !== undefined ? `，输入: "${text}"` : ''}`
          : `对话框应答失败: ${r.error ?? '未知原因'}`;
      }
    } else if (tool === 'ask_user') {
      const question = typeof action.question === 'string' ? action.question : '';
      const rawOpts = action.options;
      const options = Array.isArray(rawOpts)
        ? rawOpts.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 8)
        : undefined;
      let answer = '';
      try {
        answer = await abortable(onAskUser(question, options && options.length > 0 ? options : undefined), signal);
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        answer = '';
      }
      ok = true;
      info = `用户回答: ${answer}`;
      snapshot = (await runInPage(tabId, domSnapshot, [], signal)) ?? snapshot;
      messages.push({
        role: 'user',
        content: `执行结果: ${info}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
      });
      pruneSnapshots(messages);
      onStep({ tool, args: argsForStep, ok, info });
      continue;
    } else if (tool === 'read_page') {
      // 按需读取正文：快照默认不含 pageText，LLM 显式索取时才回传（省 token）
      snapshot = (await runInPage(tabId, domSnapshot, [], signal)) ?? snapshot;
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
      // 模型想收尾时若用户刚补充了指令：不结束——新指令可能推翻 done 判断，
      // 注入后让模型带着补充信息继续推进。
      if (drainSteering() > 0) {
        messages.push({ role: 'user', content: '任务尚未结束，请结合上面的用户补充指令继续推进。' });
        snapshot = (await runInPage(tabId, domSnapshot, [], signal)) ?? snapshot;
        continue;
      }
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

    // 仅对页面动作（click/type/select/scroll/click_at/type_focused/upload）累计连续失败
    // navigate/new_tab/ask_user/done/unknown 不计入
    if (
      tool === 'click' ||
      tool === 'type' ||
      tool === 'select' ||
      tool === 'scroll' ||
      tool === 'click_at' ||
      tool === 'type_focused' ||
      tool === 'upload'
    ) {
      if (ok) {
        consecutiveFail = 0;
      } else {
        consecutiveFail++;
      }
    }

    onStep({ tool, args: argsForStep, ok, info });

    // 自动应答的对话框（alert/beforeunload）不静默吞，message 拼进执行结果给 LLM 观察
    const autoDlgs = drainAutoDialogs(tabId);
    const autoNote =
      autoDlgs.length > 0
        ? `\n（${autoDlgs.map((d) => `页面弹出 ${d.type}: "${d.message}"，已自动${d.type === 'beforeunload' ? '允许继续' : '关闭'}`).join('；')}）`
        : '';

    // confirm/prompt 待应答：页面 JS 已冻结，快照拿不到——跳过快照直接上抛给 LLM。
    // 短轮询 300ms：对话框事件经 chrome.debugger.onEvent 异步到达，动作刚结束时可能还在路上
    const pendDlg = await waitPendingDialog(tabId, 300);
    if (pendDlg) {
      messages.push({
        role: 'user',
        content:
          `执行结果: ${ok ? info : `失败 - ${info}`}${autoNote}\n\n` +
          `页面弹出${pendDlg.type === 'prompt' ? '输入对话框' : '确认对话框'}: "${pendDlg.message}"` +
          (pendDlg.type === 'prompt' && pendDlg.defaultPrompt ? `（默认输入: "${pendDlg.defaultPrompt}"）` : '') +
          `\n页面已冻结，其它工具暂时不可用。请用 {"tool":"dialog","action":"accept"|"dismiss"` +
          (pendDlg.type === 'prompt' ? ',"text":"输入内容"' : '') +
          '} 应答（confirm 需读清消息：与任务目标一致才 accept，涉及删除/支付/发送等不可逆操作且任务未明确要求时 dismiss）。',
      });
      await reportTab();
      continue;
    }

    snapshot = (await runInPage(tabId, domSnapshot, [], signal)) ?? snapshot;
    messages.push({
      role: 'user',
      content: `执行结果: ${ok ? info : `失败 - ${info}`}${autoNote}\n\n最新页面:\n\n${buildSnapshotMessage(snapshot)}`,
    });
    pruneSnapshots(messages);
      await reportTab();
    } catch (err) {
      // 用户中止：步内任意阻塞点（LLM fetch / 页面脚本 / 加载轮询 / 确认等待）立即出口
      if (err instanceof AbortedError || signal?.aborted) {
        await safeCdpDetach(tabId);
        safeHideOverlay(tabId);
        return { status: 'stopped', summary: '用户已中止', usage: totalUsage };
      }
      throw err;
    }
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