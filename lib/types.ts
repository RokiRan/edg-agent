export type LLMProvider = 'openai' | 'deepseek' | 'custom';

export interface LLMSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Agent 单次任务最大步骤数；缺省由 loop 决定 */
  maxSteps?: number;
  /** TypeSafe Jev（System One）快路径 key；为空则快路径完全关闭，行为不变 */
  jevKey?: string;
  /** Jev 快路径总开关（默认关）；与 jevKey 同时满足才启用 */
  jevEnabled?: boolean;
  /** Jev API base（缺省 https://api.typesafe.ai/v1）；e2e 指向 mock */
  jevBaseUrl?: string;
}

import type { AgentStep, TargetTabInfo } from './agent/loop';
export type { AgentStep };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'text' | 'agent';
  steps?: AgentStep[];
  status?: 'running' | 'done' | 'failed' | 'stopped' | 'waiting' | 'max-steps';
  /** agent 任务当前控制的标签页（运行期间由 loop 实时回流）。 */
  targetTab?: TargetTabInfo;
}
