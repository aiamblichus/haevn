/**
 * Storage Adapter Interface
 *
 * Abstracts browser storage APIs to enable testing without chrome.storage.
 * Follows the MediaStorageService pattern for consistency.
 *
 * Usage:
 * - Production: Initialize with ChromeStorageAdapter in background/init.ts
 * - Tests: Initialize with MemoryStorageAdapter in test setup
 */

export interface StorageAdapter {
  /**
   * Retrieves a value from storage
   * @returns The value if found, null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Stores a value in storage
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Removes a key from storage
   */
  remove(key: string): Promise<void>;

  /**
   * Clears all storage
   */
  clear(): Promise<void>;

  /**
   * Retrieves all stored data
   * Used primarily for debugging (e.g., haevnDebug.getStorage())
   */
  getAll(): Promise<Record<string, unknown>>;
}

/**
 * Global storage adapter instance
 * Must be initialized via setStorageAdapter() before use
 */
let instance: StorageAdapter | null = null;

/**
 * Gets the current storage adapter
 * @throws Error if adapter hasn't been initialized
 */
export function getStorageAdapter(): StorageAdapter {
  if (!instance) {
    throw new Error(
      "StorageAdapter not initialized. Call setStorageAdapter() in background/init.ts first.",
    );
  }
  return instance;
}

/**
 * Sets the storage adapter implementation
 * Called once at startup (background/init.ts) or in test setup
 */
export function setStorageAdapter(adapter: StorageAdapter): void {
  instance = adapter;
}

/**
 * Resets the storage adapter instance
 * Used primarily in tests to ensure clean state between test runs
 */
export function resetStorageAdapter(): void {
  instance = null;
}
