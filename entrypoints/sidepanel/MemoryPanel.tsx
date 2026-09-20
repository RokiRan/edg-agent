import { useEffect, useState } from 'react';
import {
  loadMemory,
  saveMemory,
  type MemoryEntry,
  type MemoryStore,
} from '../../lib/memory';

const FIELD_CLS =
  'rounded-md border border-[#2a3340] bg-[#0f131a] px-2.5 py-1.5 text-sm text-[#e6e9ee] placeholder:text-[#4d5766] focus:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/25';
const LABEL_CLS =
  'font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[#5d6675]';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 记忆管理面板：查看/编辑/删除/清空长期记忆。
 * 记忆由任务结束后的提炼轮自动写入（见 lib/agent/loop.ts distillMemory），
 * 这里提供人工兜底——自动记错的条目可改可删。
 */
export function MemoryPanel() {
  const [store, setStore] = useState<MemoryStore | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    loadMemory().then(setStore).catch(() => setStore({ facts: [], sites: {} }));
  }, []);

  if (!store) return null;

  const persist = async (next: MemoryStore) => {
    setStore(next);
    try {
      await saveMemory(next);
    } catch {
      // 保存失败时界面已先更新；下次打开会回读真实值
    }
  };

  const updateEntry = (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const map = (list: MemoryEntry[]) => list.map((e) => (e.id === id ? { ...e, text: trimmed } : e));
    void persist({
      facts: map(store.facts),
      sites: Object.fromEntries(Object.entries(store.sites).map(([d, list]) => [d, map(list)])),
    });
    setEditingId(null);
  };

  const removeEntry = (id: string) => {
    const filter = (list: MemoryEntry[]) => list.filter((e) => e.id !== id);
    void persist({
      facts: filter(store.facts),
      sites: Object.fromEntries(Object.entries(store.sites).map(([d, list]) => [d, filter(list)])),
    });
  };

  const clearAll = () => {
    if (!window.confirm('确定清空全部记忆吗？此操作不可恢复。')) return;
    void persist({ facts: [], sites: {} });
  };

  const renderEntry = (entry: MemoryEntry) => (
    <li key={entry.id} className="rounded-md border border-[#1d232c] bg-[#0f131a] px-2.5 py-2">
      {editingId === entry.id ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={2}
            className={`${FIELD_CLS} resize-y`}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="rounded px-2 py-1 text-[11px] text-[#8b94a3] transition hover:text-[#e6e9ee]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => updateEntry(entry.id, editText)}
              disabled={!editText.trim()}
              className="rounded bg-amber-400 px-2 py-1 text-[11px] font-semibold text-[#0c0f14] transition hover:bg-amber-300 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-[#e6e9ee]">
              {entry.text}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-[#5d6675]">
              {fmtTime(entry.createdAt)}
              {entry.sourceTask ? ` · 来自: ${entry.sourceTask}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              aria-label="编辑"
              onClick={() => {
                setEditingId(entry.id);
                setEditText(entry.text);
              }}
              className="rounded px-1.5 py-0.5 text-[11px] text-[#8b94a3] transition hover:bg-[#1a2028] hover:text-amber-400"
            >
              编辑
            </button>
            <button
              type="button"
              aria-label="删除"
              onClick={() => removeEntry(entry.id)}
              className="rounded px-1.5 py-0.5 text-[11px] text-[#8b94a3] transition hover:bg-[#1a2028] hover:text-red-400"
            >
              删除
            </button>
          </div>
        </div>
      )}
    </li>
  );

  const siteDomains = Object.keys(store.sites).filter((d) => store.sites[d].length > 0);
  const empty = store.facts.length === 0 && siteDomains.length === 0;

  return (
    <div className="border-t border-[#1d232c] pt-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400/90">
          记忆
        </h2>
        {!empty && (
          <button
            type="button"
            onClick={clearAll}
            className="rounded px-2 py-0.5 text-[11px] text-[#8b94a3] transition hover:text-red-400"
          >
            清空全部
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[#5d6675]">
        任务完成后自动提炼可复用信息（用户事实全局生效，站点经验按域名隔离）。记错的条目可编辑或删除。
      </p>

      {empty ? (
        <p className="mt-3 text-[12px] text-[#5d6675]">暂无记忆。完成几次带页面操作的任务后会自动积累。</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {store.facts.length > 0 && (
            <div>
              <span className={LABEL_CLS}>已知事实（全局）</span>
              <ul className="mt-2 flex flex-col gap-1.5">{store.facts.map(renderEntry)}</ul>
            </div>
          )}
          {siteDomains.map((domain) => (
            <div key={domain}>
              <span className={LABEL_CLS}>站点经验（{domain}）</span>
              <ul className="mt-2 flex flex-col gap-1.5">{store.sites[domain].map(renderEntry)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
