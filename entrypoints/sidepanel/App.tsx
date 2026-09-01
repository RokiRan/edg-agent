import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, LLMProvider, LLMSettings } from '../../lib/types';
import { PROVIDER_PRESETS, streamChat, type OutgoingMessage } from '../../lib/llm';
import { getSettings, saveSettings } from '../../lib/storage';

type SettingsForm = {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
};

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

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getSettings();
      if (cancelled) return;
      if (saved) {
        setSettingsForm({
          provider: saved.provider,
          apiKey: saved.apiKey,
          baseUrl: saved.baseUrl,
          model: saved.model,
        });
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isStreaming]);

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
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

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
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: '请先在右上角设置中配置 API Key' }
            : m
        )
      );
      setIsStreaming(false);
      return;
    }

    const history: OutgoingMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    history.push({ role: 'user', content: trimmed });

    const controller = new AbortController();
    abortRef.current = controller;

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-white text-gray-900">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight">Edg Agent</h1>
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
                <Bubble key={m.id} message={m} streaming={isStreaming} />
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

function Bubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const isUser = message.role === 'user';
  const showCursor =
    !isUser && streaming && !message.content.startsWith('错误：') && message.content !== '请先在右上角设置中配置 API Key';

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
