/**
 * 长期记忆存储层。
 *
 * 两类记忆：
 * - facts：用户事实/偏好（全局，所有任务共享）
 * - sites：站点操作技巧（按域名隔离，只在同域名任务的 prompt 里注入）
 *
 * 写入路径只有一个：任务结束后的 LLM 提炼轮（loop.ts），
 * 经 mergeMemory 去重 + 敏感信息过滤 + 容量淘汰后落库。
 * 后端与 storage.ts 同模式：chrome.storage.local 优先，localStorage 兜底（非扩展环境）。
 */

export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: number;
  /** 提炼来源任务的摘要（前 60 字），面板里帮助用户判断"这条是哪次记的" */
  sourceTask?: string;
}

export interface MemoryStore {
  facts: MemoryEntry[];
  sites: Record<string, MemoryEntry[]>;
}

const MEMORY_KEY = 'memory_v1';
const FACTS_CAP = 100;
const SITE_CAP_PER_DOMAIN = 50;
/** 注入 prompt 的字符预算（约 800 token）；超出优先保留新条目 */
const PROMPT_CHAR_BUDGET = 1600;

function emptyStore(): MemoryStore {
  return { facts: [], sites: {} };
}

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

export async function loadMemory(): Promise<MemoryStore> {
  let raw: unknown;
  if (hasChromeStorage()) {
    const items = await new Promise<Record<string, unknown>>((resolve, reject) => {
      chrome.storage.local.get(MEMORY_KEY, (result) => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result ?? {});
      });
    });
    raw = items[MEMORY_KEY];
  } else {
    if (typeof localStorage === 'undefined') return emptyStore();
    const rawStr = localStorage.getItem(MEMORY_KEY);
    if (rawStr === null) return emptyStore();
    try {
      raw = JSON.parse(rawStr);
    } catch {
      return emptyStore();
    }
  }

  if (!raw || typeof raw !== 'object') return emptyStore();
  const store = raw as Partial<MemoryStore>;
  return {
    facts: Array.isArray(store.facts) ? store.facts : [],
    sites: store.sites && typeof store.sites === 'object' ? store.sites : {},
  };
}

export async function saveMemory(store: MemoryStore): Promise<void> {
  if (hasChromeStorage()) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.set({ [MEMORY_KEY]: store }, () => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
    return;
  }
  if (typeof localStorage === 'undefined') {
    throw new Error('无可用的存储后端');
  }
  localStorage.setItem(MEMORY_KEY, JSON.stringify(store));
}

/** 站点记忆按域名隔离：取 hostname 并去掉 www. 前缀。非 http(s) 返回 null。 */
export function domainFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 敏感信息兜底过滤（提炼 prompt 里另有指令约束，这里是第二道闸）：
 * 身份证号、长串银行卡号、显式密码键值。
 */
const SENSITIVE_RES = [
  /\d{17}[\dXx]/,
  /(?<!\d)\d{16,19}(?!\d)/,
  /(密码|password|passwd|pwd)\s*[:：是=]/i,
];

export function isSensitive(text: string): boolean {
  return SENSITIVE_RES.some((re) => re.test(text));
}

function makeEntry(text: string, sourceTask?: string): MemoryEntry {
  return {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: Date.now(),
    sourceTask,
  };
}

export interface MergeInput {
  facts?: string[];
  siteTips?: string[];
}

/**
 * 合并提炼结果入库。去重按规范化文本 exact match（同义冲突以新替旧不做——第一版）。
 * 返回新增条数；facts/siteTips 内非字符串、空串、敏感条目一律丢弃。
 */
export function mergeMemory(
  store: MemoryStore,
  input: MergeInput,
  domain: string | null,
  sourceTask?: string,
): { added: number } {
  let added = 0;
  const clean = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.length <= 200 && !isSensitive(t))
      : [];

  const existingFactTexts = new Set(store.facts.map((e) => normalizeText(e.text)));
  for (const text of clean(input.facts)) {
    if (existingFactTexts.has(normalizeText(text))) continue;
    store.facts.push(makeEntry(text, sourceTask));
    existingFactTexts.add(normalizeText(text));
    added++;
  }

  const tips = clean(input.siteTips);
  if (tips.length > 0 && domain) {
    const list = store.sites[domain] ?? (store.sites[domain] = []);
    const existingTipTexts = new Set(list.map((e) => normalizeText(e.text)));
    for (const text of tips) {
      if (existingTipTexts.has(normalizeText(text))) continue;
      list.push(makeEntry(text, sourceTask));
      existingTipTexts.add(normalizeText(text));
      added++;
    }
  }

  // 容量淘汰最旧
  if (store.facts.length > FACTS_CAP) {
    store.facts.sort((a, b) => b.createdAt - a.createdAt);
    store.facts.length = FACTS_CAP;
    store.facts.sort((a, b) => a.createdAt - b.createdAt);
  }
  for (const d of Object.keys(store.sites)) {
    const list = store.sites[d];
    if (list.length > SITE_CAP_PER_DOMAIN) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      list.length = SITE_CAP_PER_DOMAIN;
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
  }

  return { added };
}

/**
 * 组装注入 system prompt 的记忆段。无记忆返回 null（prompt 不追加）。
 * 预算内优先保留新条目（从尾部往前取）。
 */
export function formatMemoryForPrompt(store: MemoryStore, domain: string | null): string | null {
  const sections: string[] = [];

  const pickWithinBudget = (entries: MemoryEntry[], budget: number): MemoryEntry[] => {
    const picked: MemoryEntry[] = [];
    let used = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const len = entries[i].text.length + 4;
      if (used + len > budget) continue;
      picked.unshift(entries[i]);
      used += len;
    }
    return picked;
  };

  const factBudget = domain ? PROMPT_CHAR_BUDGET / 2 : PROMPT_CHAR_BUDGET;
  const facts = pickWithinBudget(store.facts, factBudget);
  if (facts.length > 0) {
    sections.push(['已知事实（用户告诉过你或之前任务确认的）:', ...facts.map((e) => `- ${e.text}`)].join('\n'));
  }

  if (domain) {
    const tips = pickWithinBudget(store.sites[domain] ?? [], PROMPT_CHAR_BUDGET - factBudget);
    if (tips.length > 0) {
      sections.push([`本站操作经验（${domain}）:`, ...tips.map((e) => `- ${e.text}`)].join('\n'));
    }
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}
