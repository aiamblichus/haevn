import "fake-indexeddb/auto";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { beforeEach, vi } from "vitest";
import { MemoryStorageAdapter, setStorageAdapter } from "../src/storage";

// Ensure a window-like global for any code that checks for it
if (typeof globalThis !== "undefined") {
  (globalThis as any).window = globalThis;
}

// The search index keeps its files in OPFS, which Node has not: the tests ask for the memory host
// (HVN-87). The flag is read from `globalThis`, so a test that reloads the module keeps it.
(globalThis as any)[Symbol.for("haevn.search.useMemoryHost")] = true;

// Mock chrome API
const chromeMock = {
  storage: {
    local: {
      get: async (key: string | string[]) => ({}),
      set: async (items: any) => {},
      remove: async (keys: string | string[]) => {},
      clear: async () => {},
    },
  },
  runtime: {
    sendMessage: async (message: any) => {},
    lastError: null,
  },
  alarms: {
    create: () => {},
    clear: () => {},
  },
};

// Use vi.stubGlobal for better integration with Vitest
vi.stubGlobal("chrome", chromeMock);
vi.stubGlobal("indexedDB", indexedDB);
vi.stubGlobal("IDBKeyRange", IDBKeyRange);

// Explicitly set Dexie dependencies for test environment
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

// Initialize storage adapter with in-memory implementation for tests
beforeEach(() => {
  setStorageAdapter(new MemoryStorageAdapter());
});
