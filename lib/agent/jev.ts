import type { PageSnapshot } from './actions';
import type { ChatUsage } from '../llm';
import { buildSnapshotMessage } from './prompt';

/**
 * Jev（TypeSafe System One）快路径：把「下一步操作哪个元素」这个离散决策
 * 从 LLM 全量推理降级为小模型的 Choice 判断，一次 HTTP 扇出同时拿
 * 动作选择 + done 判定。校准置信度是升级/执行的分流信号：
 * 高置信直接执行，低置信/需要生成文本/调用失败一律回退大模型。
 *
 * 解耦契约：本模块只在 settings.jevKey 非空时被调用；任何失败返回 null，
 * 主循环按未配置处理，行为与无 Jev 完全一致。
 */

/** 快路径执行的最低置信度（实测：歧义场景 ~0.43，明确场景 0.77+）。 */
export const JEV_CONFIDENCE_MIN = 0.7;
/** Choice 上限 255 选项；预留特殊选项余位，快照元素超过即跳过快路径。 */
export const JEV_MAX_OPTIONS = 240;
/** 快路径调用超时：超过即回退大模型（快路径的意义是快，不允许拖慢步）。 */
const JEV_TIMEOUT_MS = 4000;

/** 特殊选项 key 前缀：与数字元素 id 区分。 */
const OPT_SCROLL_DOWN = '_scroll_down';
const OPT_SCROLL_UP = '_scroll_up';
const OPT_LLM = '_llm';

export interface JevVerdict {
  /** 高置信时可直接执行的动作；null = 回退大模型。 */
  action: { tool: 'click'; id: number } | { tool: 'scroll'; direction: 'down' | 'up' } | null;
  /** 模型对所选选项的置信度（0-1）。 */
  confidence: number;
  /** 原始选中项（诊断/日志用）。 */
  choice: string;
  /** done 判定概率（0-1）；观测用，低值说明任务明显未完成。 */
  taskDone: number | null;
  /** 本次调用耗时（ms）。 */
  ms: number;
  /** Jev /systemone 响应里的 token 用量（provider 不给则为 undefined；与 LLM line 独立计算）。 */
  usage?: ChatUsage;
}

interface JevResponse {
  answers?: {
    next?: { type: string; choice?: string; confidence?: number };
    task_done?: { type: string; noul?: number };
  };
  /** /systemone 响应里的 token 用量；非必有（provider 不回 usage 时为 undefined）。 */
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** 动作去重键：用元素身份（tag+text）而非快照 id——id 随页面渲染漂移，
 *  同一按钮两次快照里 id 不同，用 id 做键会漏掉隔步重复。 */
export function jevActionKey(action: JevVerdict['action'], snapshot: PageSnapshot): string {
  if (!action) return '';
  if (action.tool === 'scroll') return `scroll|${action.direction}`;
  const el = snapshot.elements.find((e) => e.id === action.id);
  return `click|${el?.tag ?? ''}|${el?.text ?? ''}`;
}

/**
 * 对当前快照做一次快路径评估。永不抛错：任何失败（网络/超时/形状不符）返回 null。
 */
export async function jevFastPath(
  apiKey: string,
  baseUrl: string | undefined,
  task: string,
  snapshot: PageSnapshot,
  signal?: AbortSignal,
  recent?: string[],
): Promise<JevVerdict | null> {
  const snapshotText = buildSnapshotMessage(snapshot);
  const elLines = snapshotText.match(/^\[(\d+)\] (.+)$/gm) ?? [];
  if (elLines.length === 0 || elLines.length > JEV_MAX_OPTIONS) return null;

  const criteria: Record<string, string> = {};
  for (const line of elLines) {
    const m = line.match(/^\[(\d+)\] (.+)$/);
    if (!m) continue;
    criteria[m[1]] = m[2];
  }
  criteria[OPT_SCROLL_DOWN] = '向下滚动页面，寻找更多内容';
  criteria[OPT_SCROLL_UP] = '向上滚动页面，回看之前内容';
  criteria[OPT_LLM] =
    '以上都不适用：需要输入/生成文本、选择下拉、上传文件、导航换页、任务已完成需交付总结、或无法确定——交给大模型处理';

  const body = {
    state: { task, snapshot: snapshotText, recent_actions: recent && recent.length > 0 ? recent : undefined },
    model: 'jev-latest',
    questions: {
      next: {
        type: 'choice',
        instructions:
          '浏览器自动化 agent 要完成 `task` 中的任务。`snapshot` 是当前页面的可交互元素列表（格式 [id] 描述）。' +
          '`recent_actions` 是最近执行的动作摘要（最新在最后），据此判断当前进展，不要选择已执行过且无进展的动作。' +
          '如果下一步应该点击某个元素（链接/按钮/可点区域，包括已展开的浮层/下拉里的选项），选它的 id；需要滚动找内容选滚动项；' +
          '其余一切情况（要输入文字、做选择、上传、导航、任务已完成、拿不准）选 _llm。',
        criteria,
      },
      task_done: {
        type: 'noul',
        instructions: '根据 `snapshot`，`task` 的任务目标是否已经达成并有可交付内容？',
        criteria: { true: '任务已达成', false: '任务未达成' },
      },
    },
  };

  const base = (baseUrl ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
  const t0 = Date.now();
  try {
    const signals = [AbortSignal.timeout(JEV_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const res = await fetch(`${base}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as JevResponse;
    const next = data.answers?.next;
    const choice = next?.choice;
    const confidence = typeof next?.confidence === 'number' ? next.confidence : 0;
    if (typeof choice !== 'string') return null;
    const taskDone =
      typeof data.answers?.task_done?.noul === 'number' ? data.answers.task_done.noul : null;

    let action: JevVerdict['action'] = null;
    if (/^\d+$/.test(choice)) {
      const id = Number(choice);
      // 幻觉守卫：id 必须在当前快照里真实存在
      if (snapshot.elements.some((e) => e.id === id)) action = { tool: 'click', id };
    } else if (choice === OPT_SCROLL_DOWN) {
      action = { tool: 'scroll', direction: 'down' };
    } else if (choice === OPT_SCROLL_UP) {
      action = { tool: 'scroll', direction: 'up' };
    }
    const u = data.usage;
    let usage: ChatUsage | undefined;
    if (u && typeof u === 'object') {
      const p = Number(u.prompt_tokens);
      const c = Number(u.completion_tokens);
      if (Number.isFinite(p) && Number.isFinite(c)) usage = { prompt: p, completion: c };
    }
    return { action, confidence, choice, taskDone, ms: Date.now() - t0, usage };
  } catch {
    return null;
  }
}
