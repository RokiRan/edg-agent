import type { LLMProvider, LLMSettings } from './types';

export interface OutgoingMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
): Promise<string> {
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
    }),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`LLM 请求失败 (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}