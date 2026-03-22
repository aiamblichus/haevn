/**
 * Chrome Storage Adapter
 *
 * Production implementation of StorageAdapter that wraps chrome.storage.local
 */

import type { StorageAdapter } from "./storageAdapter";

export class ChromeStorageAdapter implements StorageAdapter {
  async get<T>(key: string): Promise<T | null> {
    const result = await chrome.storage.local.get(key);
    return (result[key] as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }

  async clear(): Promise<void> {
    await chrome.storage.local.clear();
  }

  async getAll(): Promise<Record<string, unknown>> {
    const result = await chrome.storage.local.get(null);
    return result;
  }
}
