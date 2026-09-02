export type LLMProvider = 'openai' | 'deepseek' | 'custom';

export interface LLMSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Agent 单次任务最大步骤数；缺省由 loop 决定 */
  maxSteps?: number;
}

import type { AgentStep } from './agent/loop';
export type { AgentStep };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'text' | 'agent';
  steps?: AgentStep[];
  status?: 'running' | 'done' | 'failed' | 'stopped' | 'waiting';
}
