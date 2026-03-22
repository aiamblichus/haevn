/**
 * Storage Module
 *
 * Provides an abstraction layer over browser storage for testability
 */

export { ChromeStorageAdapter } from "./chromeStorageAdapter";
export { MemoryStorageAdapter } from "./memoryStorageAdapter";
export type { StorageAdapter } from "./storageAdapter";
export {
  getStorageAdapter,
  resetStorageAdapter,
  setStorageAdapter,
} from "./storageAdapter";
