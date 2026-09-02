import type { LLMProvider, LLMSettings } from './types';

export interface OutgoingMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | unknown[];
}
/** 单次 LLM 调用的 token 用量（OpenAI 兼容 usage 字段）。 */
export interface ChatUsage {
  prompt: number;
  completion: number;
}

/** 非流式 chat() 的返回：正文 + 可选用量（provider 不给 usage 时缺省）。 */
export interface ChatResponse {
  content: string;
  usage?: ChatUsage;
}

export const PROVIDER_PRESETS: Record<LLMProvider, { label: string; baseUrl: string; model: string }> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    model: '',
  },
};

export async function streamChat(
  settings: LLMSettings,
  messages: OutgoingMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`LLM 请求失败 (${res.status}): ${text}`);
  }

  if (!res.body) {
    throw new Error('LLM 请求失败: 无响应体');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        // 跳过无法解析的行
      }
    }
  }

  // 处理尾部残留 buffer（不以 \n 结尾的最后一段）
  if (buffer.length > 0) {
    const line = buffer.replace(/\r$/, '');
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data !== '[DONE]') {
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
        } catch {
          // 忽略尾部残留解析错误
        }
      }
    }
  }
}

/**
 * 非流式聊天：与 streamChat 同源，但请求一次拿完整响应，返回 choices[0].message.content。
 * Agent 循环用它来做多轮动作 JSON 生成。
 */
export async function chat(
  settings: LLMSettings,
  messages: OutgoingMessage[],
  signal?: AbortSignal,
  /** 格式错误重试时的预算升级：更大 max_tokens 兜住长 think，温度非零打破确定性重试 */
  retryBoost?: { maxTokens?: number; temperature?: number },
): Promise<ChatResponse> {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: false,
      // Agent 动作生成要确定性：温度归零，减少同页同快照下动作漂移/死循环
      temperature: retryBoost?.temperature ?? 0,
      // 推理模型（MiniMax M3 等）会在 JSON 前输出 think 段；
      // provider 默认 max_tokens 可能把响应截断在 think 中途 → 无 JSON 可解析。
      // 显式给足 think + 动作 JSON 的预算。
      max_tokens: retryBoost?.maxTokens ?? 4096,
    }),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`LLM 请求失败 (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = data?.choices?.[0]?.message?.content;
  const prompt = Number(data?.usage?.prompt_tokens);
  const completion = Number(data?.usage?.completion_tokens);
  return {
    content: typeof content === 'string' ? content : '',
    usage:
      Number.isFinite(prompt) && Number.isFinite(completion)
        ? { prompt, completion }
        : undefined,
  };
}