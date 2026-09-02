import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, LLMProvider, LLMSettings } from '../../lib/types';
import { PROVIDER_PRESETS, streamChat, type OutgoingMessage } from '../../lib/llm';
import { getSettings, saveSettings } from '../../lib/storage';
import { runAgentTask, type AgentStep } from '../../lib/agent/loop';

type SettingsForm = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
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
};

const AGENT_MODE_KEY = 'agent_mode';

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
  });
  const [hydrated, setHydrated] = useState(false);
  const [agentMode, setAgentMode] = useState(true);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskState | null>(null);

  const abortRef = useRef<AbortController | null>(null);
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
    };
    await saveSettings(payload);
    setShowSettings(false);
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const updateAssistant = (id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
  };

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

      try {
        const result = await runAgentTask(trimmed, settings, {
          signal: controller.signal,
          onStep: (step: AgentStep) => {
            updateAssistant(assistantId, (m) => ({
              ...m,
              steps: [...(m.steps ?? []), step],
            }));
          },
          onConfirmRequired: (req) =>
            new Promise<boolean>((resolve) => {
              setPendingConfirm({
                messageId: assistantId,
                resolve,
                reason: req.reason,
                actionJson: req.actionJson,
              });
              updateAssistant(assistantId, (m) => ({ ...m, status: 'waiting' }));
            }),
          onAskUser: (question) =>
            new Promise<string>((resolve) => {
              setPendingAsk({
                messageId: assistantId,
                resolve,
                question,
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
      return null;
    });
  };

  const handleAskResolve = (answer: string) => {
    setPendingAsk((cur) => {
      if (!cur) return cur;
      cur.resolve(answer);
      return null;
    });
  };

  return (
    <div className="flex h-full w-full flex-col bg-white text-gray-900">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight">Edg Agent</h1>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50">
            <input
              type="checkbox"
              checked={agentMode}
              onChange={(e) => handleAgentModeToggle(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-gray-900"
              aria-label="切换 Agent 模式"
            />
            <span className="font-medium">Agent</span>
          </label>
        </div>
        <button
          type="button"
          aria-label="设置"
          onClick={() => setShowSettings((s) => !s)}
          className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
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
          <main className="flex-1 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
                开始对话吧，向 Edg Agent 提问。
              </div>
            )}
            <div className="flex flex-col gap-2">
              {messages.map((m) => (
                <Bubble
                  key={m.id}
                  message={m}
                  streaming={isStreaming}
                  pendingConfirm={pendingConfirm?.messageId === m.id ? pendingConfirm : null}
                  pendingAsk={pendingAsk?.messageId === m.id ? pendingAsk : null}
                  onConfirmResolve={handleConfirmResolve}
                  onAskResolve={handleAskResolve}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </main>

          {/* Input area */}
          <footer className="shrink-0 border-t border-gray-200 p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="输入消息，回车发送，Shift+Enter 换行"
                className="min-h-[40px] max-h-32 flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-relaxed text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-300"
              />
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stopStreaming}
                  className="h-10 shrink-0 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-100"
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="h-10 shrink-0 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  发送
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

type BubbleProps = {
  message: ChatMessage;
  streaming: boolean;
  pendingConfirm: ConfirmState | null;
  pendingAsk: AskState | null;
  onConfirmResolve: (ok: boolean) => void;
  onAskResolve: (answer: string) => void;
};

function Bubble({ message, streaming, pendingConfirm, pendingAsk, onConfirmResolve, onAskResolve }: BubbleProps) {
  const isUser = message.role === 'user';
  const isAgent = message.kind === 'agent';

  if (isAgent) {
    return <AgentBubble message={message} pendingConfirm={pendingConfirm} pendingAsk={pendingAsk} onConfirmResolve={onConfirmResolve} onAskResolve={onAskResolve} />;
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
            ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gray-900 px-3 py-2 text-sm text-white'
            : 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-gray-100 px-3 py-2 text-sm text-gray-900'
        }
      >
        {message.content}
        {showCursor && <span className="ml-0.5 inline-block animate-pulse text-gray-500">▍</span>}
      </div>
    </div>
  );
}

function AgentBubble({
  message,
  pendingConfirm,
  pendingAsk,
  onConfirmResolve,
  onAskResolve,
}: {
  message: ChatMessage;
  pendingConfirm: ConfirmState | null;
  pendingAsk: AskState | null;
  onConfirmResolve: (ok: boolean) => void;
  onAskResolve: (answer: string) => void;
}) {
  const steps = message.steps ?? [];
  const status = message.status ?? 'done';

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900">
        {steps.length > 0 && (
          <ol className="mb-2 flex flex-col gap-1">
            {steps.map((step, idx) => (
              <li key={idx} className="flex items-start gap-2 text-xs leading-relaxed">
                <span className="font-mono text-gray-400">{idx + 1}.</span>
                <span className="font-medium text-gray-800">{step.tool}</span>
                <span className="text-gray-600">{summarizeArgs(step.args, step.tool)}</span>
                <span className={step.ok ? 'text-green-600' : 'text-red-600'}>
                  {step.ok ? '✓' : '✗'}
                </span>
                <span className="truncate text-gray-400" title={step.info}>
                  {truncate(step.info, 80)}
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="flex items-center gap-2 border-t border-gray-200 pt-1.5">
          <StatusBadge status={status} />
          {status === 'done' && message.content && (
            <div className="whitespace-pre-wrap break-words text-sm text-gray-800">{message.content}</div>
          )}
          {status === 'failed' && message.content && (
            <div className="whitespace-pre-wrap break-words text-sm text-red-700">{message.content}</div>
          )}
          {status === 'stopped' && (
            <div className="text-xs text-gray-500">已停止</div>
          )}
          {status === 'running' && (
            <div className="flex items-center gap-1.5 text-xs text-blue-700">
              <Spinner />
              <span>运行中…</span>
            </div>
          )}
          {status === 'waiting' && (
            <div className="text-xs text-yellow-700">等待确认…</div>
          )}
        </div>

        {pendingConfirm && (
          <ConfirmCard
            reason={pendingConfirm.reason}
            actionJson={pendingConfirm.actionJson}
            onAllow={() => onConfirmResolve(true)}
            onDeny={() => onConfirmResolve(false)}
          />
        )}

        {pendingAsk && (
          <AskCard
            question={pendingAsk.question}
            onSubmit={(answer) => onAskResolve(answer)}
          />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: NonNullable<ChatMessage['status']> }) {
  const map: Record<string, { label: string; cls: string }> = {
    running: { label: '运行中', cls: 'bg-blue-100 text-blue-700' },
    waiting: { label: '等待确认', cls: 'bg-yellow-100 text-yellow-800' },
    done: { label: '完成', cls: 'bg-green-100 text-green-700' },
    failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
    stopped: { label: '已停止', cls: 'bg-gray-200 text-gray-700' },
  };
  const v = map[status] ?? map.done;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${v.cls}`}>{v.label}</span>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin text-blue-600"
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
  onDeny,
}: {
  reason: string;
  actionJson: string;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-900">
      <div className="mb-1 font-semibold">⚠️ 需要确认</div>
      <div className="mb-2 leading-relaxed">{reason}</div>
      <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-yellow-100 p-2 font-mono text-[11px] text-yellow-900">
        {actionJson}
      </pre>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDeny}
          className="rounded-md bg-gray-200 px-3 py-1 text-xs font-medium text-gray-800 transition hover:bg-gray-300"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={onAllow}
          className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-red-700"
        >
          允许
        </button>
      </div>
    </div>
  );
}

function AskCard({ question, onSubmit }: { question: string; onSubmit: (answer: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="mt-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs text-blue-900">
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
          className="min-w-0 flex-1 rounded-md border border-blue-300 bg-white px-2 py-1 text-xs text-blue-900 focus:border-blue-400 focus:outline-none"
          placeholder="输入回答"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
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

function SettingsPanel({ form, onChange, onProviderChange, onSave }: SettingsPanelProps) {
  const presetEntries = Object.entries(PROVIDER_PRESETS) as Array<[LLMProvider, { label: string }]>;

  return (
    <main className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-700">LLM 设置</h2>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          <span>Provider</span>
          <select
            value={form.provider}
            onChange={(e) => onProviderChange(e.target.value as LLMProvider)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none"
          >
            {presetEntries.map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          <span>API Key</span>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
            autoComplete="off"
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          <span>Base URL</span>
          <input
            type="text"
            value={form.baseUrl}
            onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          <span>Model</span>
          <input
            type="text"
            value={form.model}
            onChange={(e) => onChange({ ...form, model: e.target.value })}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-gray-400 focus:outline-none"
          />
        </label>

        <button
          type="button"
          onClick={onSave}
          className="mt-2 self-end rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800"
        >
          保存
        </button>
      </div>
    </main>
  );
}

export default App;
