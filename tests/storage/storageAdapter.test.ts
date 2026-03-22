import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memoryStorageAdapter";
import { getStorageAdapter, setStorageAdapter } from "../../src/storage/storageAdapter";

describe("MemoryStorageAdapter", () => {
  let adapter: MemoryStorageAdapter;

  beforeEach(() => {
    adapter = new MemoryStorageAdapter();
  });

  describe("get/set", () => {
    it("should store and retrieve a value", async () => {
      await adapter.set("key1", "value1");
      const result = await adapter.get<string>("key1");
      expect(result).toBe("value1");
    });

    it("should return null for non-existent key", async () => {
      const result = await adapter.get<string>("nonexistent");
      expect(result).toBeNull();
    });

    it("should handle complex objects", async () => {
      const obj = { foo: "bar", nested: { baz: 123 } };
      await adapter.set("obj", obj);
      const result = await adapter.get<typeof obj>("obj");
      expect(result).toEqual(obj);
    });

    it("should overwrite existing values", async () => {
      await adapter.set("key1", "value1");
      await adapter.set("key1", "value2");
      const result = await adapter.get<string>("key1");
      expect(result).toBe("value2");
    });
  });

  describe("remove", () => {
    it("should remove a key", async () => {
      await adapter.set("key1", "value1");
      await adapter.remove("key1");
      const result = await adapter.get<string>("key1");
      expect(result).toBeNull();
    });

    it("should not throw when removing non-existent key", async () => {
      await expect(adapter.remove("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("clear", () => {
    it("should clear all keys", async () => {
      await adapter.set("key1", "value1");
      await adapter.set("key2", "value2");
      await adapter.set("key3", "value3");
      await adapter.clear();

      expect(await adapter.get<string>("key1")).toBeNull();
      expect(await adapter.get<string>("key2")).toBeNull();
      expect(await adapter.get<string>("key3")).toBeNull();
    });
  });

  describe("getAll", () => {
    it("should return all stored data", async () => {
      await adapter.set("key1", "value1");
      await adapter.set("key2", { foo: "bar" });
      await adapter.set("key3", 123);

      const all = await adapter.getAll();
      expect(all).toEqual({
        key1: "value1",
        key2: { foo: "bar" },
        key3: 123,
      });
    });

    it("should return empty object when storage is empty", async () => {
      const all = await adapter.getAll();
      expect(all).toEqual({});
    });
  });
});

describe("StorageAdapter factory", () => {
  it("should get and set adapter instance", () => {
    const adapter = new MemoryStorageAdapter();
    setStorageAdapter(adapter);
    expect(getStorageAdapter()).toBe(adapter);
  });

  it("should throw if adapter not initialized", () => {
    // Reset to null (this won't affect other tests due to beforeEach in setup.ts)
    setStorageAdapter(null as any);
    expect(() => getStorageAdapter()).toThrow("StorageAdapter not initialized");
  });
});
