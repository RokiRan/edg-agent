import type { LLMSettings } from './types';

const STORAGE_KEY = 'llm_settings';

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

export async function getSettings(): Promise<LLMSettings | null> {
  if (hasChromeStorage()) {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      chrome.storage.local.get(STORAGE_KEY, (items) => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(items ?? {});
      });
    });
    const value = result[STORAGE_KEY];
    if (value === undefined || value === null) return null;
    return value as LLMSettings;
  }

  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LLMSettings;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: LLMSettings): Promise<void> {
  if (hasChromeStorage()) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: settings }, () => {
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}