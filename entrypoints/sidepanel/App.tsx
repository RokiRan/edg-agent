import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, LLMProvider, LLMSettings } from '../../lib/types';
import { PROVIDER_PRESETS, streamChat, type ChatUsage, OutgoingMessage } from '../../lib/llm';
import { getSettings, saveSettings } from '../../lib/storage';
import { runAgentTask, type AgentStep } from '../../lib/agent/loop';
import { ThinkingOrb } from './ThinkingOrb';

type SettingsForm = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxSteps: string;
};

type ConfirmState = {
  messageId: string;
  resolve: (ok: boolean) => void;
  reason: string;
  actionJson: string;
};

type AskState = {
  messageId: string;
  resolve: (answer: string) => void;
  question: string;
  options?: string[];
};

const AGENT_MODE_KEY = 'agent_mode';
const DEFAULT_MAX_STEPS = 20;

function parseMaxSteps(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(Math.max(n, 1), 100);
}

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

async function loadAgentMode(): Promise<boolean> {
  if (hasChromeStorage()) {
    try {
      const items = await new Promise<Record<string, unknown>>((resolve, reject) => {
        chrome.storage.local.get(AGENT_MODE_KEY, (got) => {
          if (chrome.runtime?.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(got ?? {});
        });
      });
      const v = items[AGENT_MODE_KEY];
      if (typeof v === 'boolean') return v;
      return true;
    } catch {
      return true;
    }
  }
  if (typeof localStorage === 'undefined') return true;
  const raw = localStorage.getItem(AGENT_MODE_KEY);
  if (raw === null) return true;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return true;
}

async function saveAgentMode(value: boolean): Promise<void> {
  if (hasChromeStorage()) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.set({ [AGENT_MODE_KEY]: value }, () => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
    return;
  }
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AGENT_MODE_KEY, value ? 'true' : 'false');
}

function summarizeArgs(args: Record<string, unknown>, tool: string): string {
  if (tool === 'click') return `id=${args.id ?? ''}`;
  if (tool === 'type') {
    const t = String(args.text ?? '');
    return `id=${args.id ?? ''}, text="${t.length > 20 ? `${t.slice(0, 20)}…` : t}"`;
  }
  if (tool === 'select') return `id=${args.id ?? ''}, value="${args.value ?? ''}"`;
  if (tool === 'scroll') return `dir=${args.direction ?? ''}`;
  if (tool === 'navigate' || tool === 'new_tab') return String(args.url ?? '');
  if (tool === 'ask_user') {
    const q = String(args.question ?? '');
    return `"${q.length > 30 ? `${q.slice(0, 30)}…` : q}"`;
  }
  if (tool === 'done') {
    const s = String(args.summary ?? '');
    return `"${s.length > 30 ? `${s.slice(0, 30)}…` : s}"`;
  }
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
/** token 数紧凑格式化：1234 → 1.2k。 */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<SettingsForm>({
    provider: 'openai',
    apiKey: '',
    baseUrl: PROVIDER_PRESETS.openai.baseUrl,
    model: PROVIDER_PRESETS.openai.model,
    maxSteps: String(DEFAULT_MAX_STEPS),
  });
  const [hydrated, setHydrated] = useState(false);
  const [agentMode, setAgentMode] = useState(true);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskState | null>(null);
  /** 最近一次 agent 任务的 token 用量（footer 显示；新任务开始时清零）。 */
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // 「本次会话始终允许」：仅内存态，侧栏重开即失效
  const alwaysAllowRiskRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [saved, mode] = await Promise.all([getSettings(), loadAgentMode()]);
      if (cancelled) return;
      if (saved) {
        setSettingsForm({
          provider: saved.provider,
          apiKey: saved.apiKey,
          baseUrl: saved.baseUrl,
          model: saved.model,
          maxSteps: String(saved.maxSteps ?? DEFAULT_MAX_STEPS),
        });
      }
      setAgentMode(mode);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isStreaming, pendingConfirm, pendingAsk]);

  const handleAgentModeToggle = (next: boolean) => {
    setAgentMode(next);
    void saveAgentMode(next).catch(() => {
      // 静默失败：UI 已经更新，持久化是次要路径
    });
  };

  const handleProviderChange = (provider: LLMProvider) => {
    const preset = PROVIDER_PRESETS[provider];
    setSettingsForm((prev) => ({
      ...prev,
      provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
  };

  const handleSaveSettings = async () => {
    const payload: LLMSettings = {
      provider: settingsForm.provider,
      apiKey: settingsForm.apiKey,
      baseUrl: settingsForm.baseUrl,
      model: settingsForm.model,
      maxSteps: parseMaxSteps(settingsForm.maxSteps),
    };
    await saveSettings(payload);
    setSettingsForm((prev) => ({ ...prev, maxSteps: String(payload.maxSteps) }));
    setShowSettings(false);
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const updateAssistant = (id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
  };
  // 有 agent 任务处于 running（非等待确认/提问）时，底部悬浮思考球
  const agentThinking = messages.some((m) => m.kind === 'agent' && m.status === 'running');

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
    };

    setInput('');

    const settings: LLMSettings | null = (() => {
      if (!hydrated) return null;
      if (!settingsForm.apiKey) return null;
      return {
        provider: settingsForm.provider,
        apiKey: settingsForm.apiKey,
        baseUrl: settingsForm.baseUrl,
        model: settingsForm.model,
        maxSteps: parseMaxSteps(settingsForm.maxSteps),
      };
    })();

    if (!settings) {
      setMessages((prev) => [
        ...prev,
        userMsg,
        { ...assistantMsg, content: '请先在右上角设置中配置 API Key' },
      ]);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    if (agentMode) {
      const agentMsg: ChatMessage = {
        ...assistantMsg,
        kind: 'agent',
        steps: [],
        status: 'running',
        content: '',
      };
      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setIsStreaming(true);
      setLastUsage(null);

      try {
        const result = await runAgentTask(trimmed, settings, {
          signal: controller.signal,
          onStep: (step: AgentStep) => {
            updateAssistant(assistantId, (m) => ({
              ...m,
              steps: [...(m.steps ?? []), step],
            }));
          },
          onConfirmRequired: (req) => {
            // 本次会话始终允许：跳过人肉确认
            if (alwaysAllowRiskRef.current) return Promise.resolve(true);
            return new Promise<boolean>((resolve) => {
              setPendingConfirm({
                messageId: assistantId,
                resolve,
                reason: req.reason,
                actionJson: req.actionJson,
              });
              updateAssistant(assistantId, (m) => ({ ...m, status: 'waiting' }));
            });
          },
          onAskUser: (question, options) =>
            new Promise<string>((resolve) => {
              setPendingAsk({
                messageId: assistantId,
                resolve,
                question,
                options,
              });
              updateAssistant(assistantId, (m) => ({ ...m, status: 'waiting' }));
            }),
        });

        const finalStatus: ChatMessage['status'] =
          result.status === 'done'
            ? 'done'
            : result.status === 'stopped'
              ? 'stopped'
              : 'failed';

        updateAssistant(assistantId, (m) => ({
          ...m,
          status: finalStatus,
          content: result.summary,
        }));
        setLastUsage(result.usage.prompt + result.usage.completion > 0 ? result.usage : null);
      } catch (err) {
        const e = err as { message?: string };
        updateAssistant(assistantId, (m) => ({
          ...m,
          status: 'failed',
          content: `错误：${e.message ?? String(err)}`,
        }));
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        setPendingConfirm((cur) => {
          if (cur && cur.messageId === assistantId) {
            cur.resolve(false);
            return null;
          }
          return cur;
        });
        setPendingAsk((cur) => {
          if (cur && cur.messageId === assistantId) {
            cur.resolve('');
            return null;
          }
          return cur;
        });
      }
      return;
    }

    // 纯聊天路径（M1 行为）
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const history: OutgoingMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    history.push({ role: 'user', content: trimmed });

    try {
      await streamChat(
        settings,
        history,
        (delta) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m
            )
          );
        },
        controller.signal
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const isAbort = e.name === 'AbortError';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: isAbort
                  ? `${m.content}（已停止）`
                  : `错误：${e.message ?? String(err)}`,
              }
            : m
        )
      );
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleConfirmResolve = (ok: boolean) => {
    setPendingConfirm((cur) => {
      if (!cur) return cur;
      cur.resolve(ok);
      // 解决后任务继续执行，状态从「等待确认」恢复为「运行中」
      // （否则徽章卡在等待确认直到任务结束，思考球也不会再出现）
      updateAssistant(cur.messageId, (m) => ({ ...m, status: 'running' }));
      return null;
    });
  };
  const handleConfirmAlways = () => {
    alwaysAllowRiskRef.current = true;
    handleConfirmResolve(true);
  };

  const handleAskResolve = (answer: string) => {
    setPendingAsk((cur) => {
      if (!cur) return cur;
      cur.resolve(answer);
      updateAssistant(cur.messageId, (m) => ({ ...m, status: 'running' }));
      return null;
    });
  };

  return (
    <div className="flex h-full w-full flex-col bg-[#0c0f14] text-[#e6e9ee]">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-[#1d232c] bg-[#0e1218] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.35)]">
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
              <path
                d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"
                fill="#0c0f14"
                stroke="#0c0f14"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-[13px] font-semibold tracking-wide">Edg Agent</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* mode segmented control */}
          <div
            role="group"
            aria-label="切换 Agent 模式"
            className="flex items-center rounded-full border border-[#232b36] bg-[#0f131a] p-0.5 text-[11px]"
          >
            <button
              type="button"
              aria-pressed={agentMode}
              onClick={() => handleAgentModeToggle(true)}
              className={
                agentMode
                  ? 'rounded-full bg-amber-400 px-2.5 py-0.5 font-semibold text-[#0c0f14] transition'
                  : 'rounded-full px-2.5 py-0.5 font-medium text-[#8b94a3] transition hover:text-[#e6e9ee]'
              }
            >
              Agent
            </button>
            <button
              type="button"
              aria-pressed={!agentMode}
              onClick={() => handleAgentModeToggle(false)}
              className={
                !agentMode
                  ? 'rounded-full bg-[#2a3340] px-2.5 py-0.5 font-semibold text-[#e6e9ee] transition'
                  : 'rounded-full px-2.5 py-0.5 font-medium text-[#8b94a3] transition hover:text-[#e6e9ee]'
              }
            >
              聊天
            </button>
          </div>

          <button
            type="button"
            aria-label="设置"
            onClick={() => setShowSettings((s) => !s)}
            className={
              showSettings
                ? 'rounded-md bg-[#232b36] p-1.5 text-amber-400 transition'
                : 'rounded-md p-1.5 text-[#8b94a3] transition hover:bg-[#1a2028] hover:text-[#e6e9ee]'
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[18px] w-[18px]"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>
      </header>

      {showSettings ? (
        <SettingsPanel
          form={settingsForm}
          onChange={setSettingsForm}
          onProviderChange={handleProviderChange}
          onSave={handleSaveSettings}
        />
      ) : (
        <>
          {/* Message list */}
          <div className="relative flex min-h-0 flex-1 flex-col">
          <main className="flex-1 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
                <div className="edg-grid-bg absolute inset-0" aria-hidden="true" />
                <div className="relative text-center">
                  <div className="font-mono text-[11px] tracking-widest text-amber-400/90">
                    $ edg --ready
                    <span className="edg-cursor ml-0.5 inline-block">▍</span>
                  </div>
                  <p className="mt-3 text-sm text-[#aab2bf]">
                    用自然语言指挥当前页面
                  </p>
                  <div className="mt-4 flex flex-col gap-1.5 font-mono text-[11px] text-[#5d6675]">
                    <span>「在搜索框输入 hello 并搜索」</span>
                    <span>「帮我填写这个表单」</span>
                    <span>「把页面滚到底部」</span>
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2.5">
              {messages.map((m) => (
                <Bubble
                  key={m.id}
                  message={m}
                  streaming={isStreaming}
                  pendingConfirm={pendingConfirm?.messageId === m.id ? pendingConfirm : null}
                  pendingAsk={pendingAsk?.messageId === m.id ? pendingAsk : null}
                  onConfirmResolve={handleConfirmResolve}
                  onConfirmAlways={handleConfirmAlways}
                  onAskResolve={handleAskResolve}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </main>
          <FloatingOrb active={agentThinking} />
          </div>

          {/* Input area */}
          <footer className="shrink-0 border-t border-[#1d232c] bg-[#0e1218] p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder={agentMode ? '描述任务…' : '输入消息，Enter 发送'}
                className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-[#2a3340] bg-[#11151c] px-3 py-2 text-sm leading-relaxed text-[#e6e9ee] placeholder:text-[#4d5766] focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/30"
              />
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stopStreaming}
                  className="h-10 shrink-0 rounded-lg border border-red-500/50 bg-red-500/10 px-4 text-sm font-medium text-red-400 transition hover:bg-red-500/20"
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-amber-400 px-4 text-sm font-semibold text-[#0c0f14] transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-[#2a3340] disabled:text-[#5d6675]"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                  发送
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between px-1 font-mono text-[10px] text-[#4d5766]">
              <span>Enter 发送 · Shift+Enter 换行</span>
              {agentMode && <span>step limit {parseMaxSteps(settingsForm.maxSteps)}</span>}
              {agentMode && lastUsage && (
                <span data-testid="token-usage">
                  ↑{fmtTokens(lastUsage.prompt)} ↓{fmtTokens(lastUsage.completion)}
                </span>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

/** 底部悬浮思考球：出现播进入动画；思考结束后延迟 1s 再播退出动画。 */
function FloatingOrb({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<'off' | 'enter' | 'on' | 'hold' | 'exit'>('off');

  useEffect(() => {
    if (active) {
      // 退出/保持中重新激活：退出中→重新进入；保持中→直接回到显示
      setPhase((p) => (p === 'exit' || p === 'off' ? 'enter' : p === 'hold' ? 'on' : p));
    } else {
      setPhase((p) => (p === 'off' ? p : 'hold'));
    }
  }, [active]);

  useEffect(() => {
    if (phase === 'enter') {
      const t = setTimeout(() => setPhase('on'), 380);
      return () => clearTimeout(t);
    }
    if (phase === 'hold') {
      const t = setTimeout(() => setPhase('exit'), 1000);
      return () => clearTimeout(t);
    }
    if (phase === 'exit') {
      const t = setTimeout(() => setPhase('off'), 320);
      return () => clearTimeout(t);
    }
  }, [phase]);

  if (phase === 'off') return null;
  const animCls = phase === 'enter' ? 'edg-orb-enter' : phase === 'exit' ? 'edg-orb-exit' : '';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div
        data-phase={phase}
        className={`rounded-full border border-[#232b36] bg-[#12161d]/90 p-2 shadow-[0_4px_20px_rgba(0,0,0,0.45)] ${animCls}`}
      >
        <ThinkingOrb size={64} />
      </div>
    </div>
  );
}

type BubbleProps = {
  message: ChatMessage;
  streaming: boolean;
  pendingConfirm: ConfirmState | null;
  pendingAsk: AskState | null;
  onConfirmResolve: (ok: boolean) => void;
  onConfirmAlways: () => void;
  onAskResolve: (answer: string) => void;
};

function Bubble({ message, streaming, pendingConfirm, pendingAsk, onConfirmResolve, onConfirmAlways, onAskResolve }: BubbleProps) {
  const isUser = message.role === 'user';
  const isAgent = message.kind === 'agent';

  if (isAgent) {
    return <AgentBubble message={message} pendingConfirm={pendingConfirm} pendingAsk={pendingAsk} onConfirmResolve={onConfirmResolve} onConfirmAlways={onConfirmAlways} onAskResolve={onAskResolve} />;
  }

  const showCursor =
    !isUser &&
    streaming &&
    !message.content.startsWith('错误：') &&
    message.content !== '请先在右上角设置中配置 API Key';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          isUser
            ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-amber-400 px-3 py-2 text-sm font-medium text-[#0c0f14]'
            : 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-[#232b36] bg-[#161b23] px-3 py-2 text-sm text-[#e6e9ee]'
        }
      >
        {message.content}
        {showCursor && <span className="edg-cursor ml-0.5 inline-block text-amber-400">▍</span>}
      </div>
    </div>
  );
}

function AgentBubble({
  message,
  pendingConfirm,
  pendingAsk,
  onConfirmResolve,
  onConfirmAlways,
  onAskResolve,
}: {
  message: ChatMessage;
  pendingConfirm: ConfirmState | null;
  pendingAsk: AskState | null;
  onConfirmResolve: (ok: boolean) => void;
  onConfirmAlways: () => void;
  onAskResolve: (answer: string) => void;
}) {
  const steps = message.steps ?? [];
  const status = message.status ?? 'done';

  return (
    <div className="flex justify-start">
      <div className="max-w-[94%] flex-1 rounded-xl rounded-bl-md border border-[#232b36] bg-[#12161d] px-3 py-2.5 text-sm text-[#e6e9ee]">
        <div className="mb-2 flex items-center justify-between border-b border-[#1d232c] pb-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#5d6675]">
            agent run
          </span>
          <StatusBadge status={status} />
        </div>

        {steps.length > 0 && (
          <ol className="mb-2 flex flex-col gap-1">
            {steps.map((step, idx) => (
              <li
                key={idx}
                className="edg-step flex items-baseline gap-2 text-xs leading-relaxed"
                style={{ animationDelay: `${Math.min(idx, 12) * 35}ms` }}
              >
                <span className="w-5 shrink-0 text-right font-mono text-[#4d5766]">{idx + 1}.</span>
                <span className="shrink-0 rounded border border-[#2f3a47] bg-[#181e27] px-1.5 py-px font-mono text-[11px] font-medium text-amber-300/90">
                  {step.tool}
                </span>
                <span className="text-[#aab2bf]">{summarizeArgs(step.args, step.tool)}</span>
                <span className={step.ok ? 'font-semibold text-[#34d399]' : 'font-semibold text-[#f87171]'}>
                  {step.ok ? '✓' : '✗'}
                </span>
                <span className="truncate text-[#5d6675]" title={step.info}>
                  {truncate(step.info, 80)}
                </span>
              </li>
            ))}
          </ol>
        )}

        {(status !== 'running') && (
          <div className="flex items-center gap-2">
            {status === 'done' && message.content && (
              <div className="whitespace-pre-wrap break-words text-sm text-[#d6dbe3]">{message.content}</div>
            )}
            {status === 'failed' && message.content && (
              <div className="whitespace-pre-wrap break-words text-sm text-[#f87171]">{message.content}</div>
            )}
            {status === 'stopped' && (
              <div className="text-xs text-[#8b94a3]">已停止</div>
            )}
            {status === 'waiting' && (
              <div className="text-xs text-amber-300">等待你的操作…</div>
            )}
          </div>
        )}
        {pendingConfirm && (
          <ConfirmCard
            reason={pendingConfirm.reason}
            actionJson={pendingConfirm.actionJson}
            onAllow={() => onConfirmResolve(true)}
            onAllowAlways={onConfirmAlways}
            onDeny={() => onConfirmResolve(false)}
          />
        )}

        {pendingAsk && (
          <AskCard
            question={pendingAsk.question}
            options={pendingAsk.options}
            onSubmit={(answer) => onAskResolve(answer)}
          />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: NonNullable<ChatMessage['status']> }) {
  const map: Record<string, { label: string; cls: string; pulse: boolean }> = {
    running: { label: '运行中', cls: 'bg-[#12233a] text-[#7ab3f5]', pulse: true },
    waiting: { label: '等待确认', cls: 'bg-[#2a2110] text-[#fbbf24]', pulse: true },
    done: { label: '完成', cls: 'bg-[#0f2a1e] text-[#34d399]', pulse: false },
    failed: { label: '失败', cls: 'bg-[#2d1414] text-[#f87171]', pulse: false },
    stopped: { label: '已停止', cls: 'bg-[#1d232c] text-[#8b94a3]', pulse: false },
  };
  const v = map[status] ?? map.done;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${v.cls}`}>
      <span className={`edg-status-dot ${v.pulse ? 'edg-status-dot--pulse' : ''}`} aria-hidden="true" />
      {v.label}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin text-[#7ab3f5]"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ConfirmCard({
  reason,
  actionJson,
  onAllow,
  onAllowAlways,
  onDeny,
}: {
  reason: string;
  actionJson: string;
  onAllow: () => void;
  onAllowAlways: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-amber-500/40 bg-[#1c1608] p-3 text-xs text-amber-200/90">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-300">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        需要确认
      </div>
      <div className="mb-2 leading-relaxed">{reason}</div>
      <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-amber-500/20 bg-[#0c0f14] p-2 font-mono text-[11px] text-amber-100/80">
        {actionJson}
      </pre>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDeny}
          className="rounded-md border border-[#3a4452] px-3 py-1 text-xs font-medium text-[#aab2bf] transition hover:bg-[#1d232c]"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={onAllowAlways}
          className="rounded-md border border-amber-500/50 px-3 py-1 text-xs font-medium text-amber-300 transition hover:bg-amber-500/10"
        >
          本次会话始终允许
        </button>
        <button
          type="button"
          onClick={onAllow}
          className="rounded-md bg-red-500 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-400"
        >
          允许
        </button>
      </div>
    </div>
  );
}

function AskCard({ question, options, onSubmit }: { question: string; options?: string[]; onSubmit: (answer: string) => void }) {
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  // 选择类问题：选项以按钮组呈现，选中后点确认提交
  if (options && options.length > 0) {
    return (
      <div className="mt-2 rounded-lg border border-[#1e3a5f] bg-[#0d1622] p-3 text-xs text-[#a8c6e8]">
        <div className="mb-2 leading-relaxed">{question}</div>
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const active = picked === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setPicked(opt)}
                className={
                  active
                    ? 'rounded-md border border-[#6ea8fe] bg-[#1d3a5f] px-2.5 py-1 text-xs font-medium text-[#cfe3ff]'
                    : 'rounded-md border border-[#2a4a73] bg-[#0c0f14] px-2.5 py-1 text-xs text-[#a8c6e8] transition hover:border-[#4a7ab5]'
                }
              >
                {opt}
              </button>
            );
          })}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!picked}
            onClick={() => {
              if (picked) onSubmit(picked);
            }}
            className="rounded-md bg-[#2f6fd0] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#3a7de0] disabled:cursor-not-allowed disabled:bg-[#1d3252] disabled:text-[#4d6c94]"
          >
            确认
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-[#1e3a5f] bg-[#0d1622] p-3 text-xs text-[#a8c6e8]">
      <div className="mb-2 leading-relaxed">{question}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onSubmit(value.trim());
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
          }}
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-[#2a4a73] bg-[#0c0f14] px-2 py-1 text-xs text-[#d6e4f5] placeholder:text-[#3d5878] focus:border-[#4a7ab5] focus:outline-none"
          placeholder="输入回答"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-md bg-[#2f6fd0] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#3a7de0] disabled:cursor-not-allowed disabled:bg-[#1d3252] disabled:text-[#4d6c94]"
        >
          回答
        </button>
      </form>
    </div>
  );
}

type SettingsPanelProps = {
  form: SettingsForm;
  onChange: (next: SettingsForm) => void;
  onProviderChange: (provider: LLMProvider) => void;
  onSave: () => void;
};

const FIELD_CLS =
  'rounded-md border border-[#2a3340] bg-[#0f131a] px-2.5 py-1.5 text-sm text-[#e6e9ee] placeholder:text-[#4d5766] focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/25';
const LABEL_CLS =
  'font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[#5d6675]';

function SettingsPanel({ form, onChange, onProviderChange, onSave }: SettingsPanelProps) {
  const presetEntries = Object.entries(PROVIDER_PRESETS) as Array<[LLMProvider, { label: string }]>;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400/90">
            llm connection
          </h2>
          <div className="mt-3 flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLS}>Provider</span>
              <select
                value={form.provider}
                onChange={(e) => onProviderChange(e.target.value as LLMProvider)}
                className={FIELD_CLS}
              >
                {presetEntries.map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLS}>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
                autoComplete="off"
                className={FIELD_CLS}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLS}>Base URL</span>
              <input
                type="text"
                value={form.baseUrl}
                onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
                className={FIELD_CLS}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLS}>Model</span>
              <input
                type="text"
                value={form.model}
                onChange={(e) => onChange({ ...form, model: e.target.value })}
                className={FIELD_CLS}
              />
            </label>
          </div>
        </div>

        <div className="border-t border-[#1d232c] pt-4">
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400/90">
            agent
          </h2>
          <div className="mt-3 flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLS}>最大步骤数</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={form.maxSteps}
                onChange={(e) => onChange({ ...form, maxSteps: e.target.value })}
                className={FIELD_CLS}
              />
              <span className="text-[11px] leading-relaxed text-[#5d6675]">
                Agent 单次任务最多执行的步骤数，1–100，默认 {DEFAULT_MAX_STEPS}。任务复杂时调大，失控时调小。
              </span>
            </label>
          </div>
        </div>

        <button
          type="button"
          onClick={onSave}
          className="mt-1 self-end rounded-lg bg-amber-400 px-5 py-2 text-sm font-semibold text-[#0c0f14] transition hover:bg-amber-300"
        >
          保存
        </button>
      </div>
    </main>
  );
}

export default App;
