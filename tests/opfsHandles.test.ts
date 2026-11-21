import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMediaStorageService } from "../src/services/mediaStorage";
import { log } from "../src/utils/logger";
import { deleteDirectory, removeDirectory, writeFile } from "../src/utils/opfs";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-90: a handle that is opened is closed or aborted on every way out, and a failed delete says so.

let fs: FakeOpfs;

beforeEach(() => {
  fs = new FakeOpfs();
  fs.install();
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;

describe("writeFile with a sync access handle", () => {
  it("closes the handle after a good write", async () => {
    await writeFile("media/c/a.png", bytes, true);
    expect(fs.counts).toMatchObject({ syncOpened: 1, syncClosed: 1 });
    expect(fs.size("media/c/a.png")).toBe(5);
  });

  it("closes the handle when the write throws, and still writes the file the async way", async () => {
    fs.failures.syncWriteThrows = true;
    await writeFile("media/c/a.png", bytes, true);
    expect(fs.counts).toMatchObject({ syncOpened: 1, syncClosed: 1 });
    expect(fs.counts.writableClosed).toBe(1);
    expect(fs.size("media/c/a.png")).toBe(5);
  });

  it("treats a short write as a failure: closes the handle and writes the whole file the async way", async () => {
    fs.failures.syncWriteShort = true;
    await writeFile("media/c/a.png", bytes, true);
    expect(fs.counts).toMatchObject({ syncOpened: 1, syncClosed: 1 });
    expect(fs.counts.writableClosed).toBe(1);
    expect(fs.size("media/c/a.png")).toBe(5);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Sync write failed"),
      expect.objectContaining({ message: expect.stringContaining("Short write") }),
    );
  });
});

describe("choosing the sync handle", () => {
  it("does not try it where the handle has none (the service worker), and says nothing", async () => {
    // the service worker looks like a worker: it has importScripts
    vi.stubGlobal("self", { importScripts: () => {} });
    fs.failures.noSyncHandle = true;
    await writeFile("media/c/a.png", bytes);
    expect(fs.counts.syncOpened).toBe(0);
    expect(fs.counts.writableClosed).toBe(1);
    expect(fs.size("media/c/a.png")).toBe(5);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses it wherever the handle offers it (a dedicated worker)", async () => {
    await writeFile("media/c/a.png", bytes);
    expect(fs.counts).toMatchObject({ syncOpened: 1, syncClosed: 1, writableClosed: 0 });
    expect(fs.size("media/c/a.png")).toBe(5);
  });
});

describe("writeFile on the async path", () => {
  it("aborts the writable when the write fails, and says why", async () => {
    fs.failures.noSyncHandle = true;
    fs.failures.writableWriteThrows = true;
    await expect(writeFile("media/c/a.png", bytes)).rejects.toThrow();
    expect(fs.counts.writableAborted).toBe(1);
    expect(fs.counts.writableClosed).toBe(0);
  });
});

describe("removing a directory", () => {
  it("answers false for a directory that is not there, and throws for one it cannot remove", async () => {
    expect(await removeDirectory("media/none")).toBe(false);
    fs.put("media/c/a.png");
    fs.failures.removeEntryThrows = new Set(["c"]);
    await expect(removeDirectory("media/c")).rejects.toThrow(/locked/);
    expect(fs.has("media/c/a.png")).toBe(true);
  });

  it("refuses a directory that is not empty when it is not asked to remove what is inside", async () => {
    fs.put("media/c/a.png");
    await expect(removeDirectory("media/c", { recursive: false })).rejects.toThrow();
    expect(fs.has("media/c/a.png")).toBe(true);
  });

  it("keeps deleteDirectory answering false for any failure, as its callers expect", async () => {
    fs.put("media/c/a.png");
    fs.failures.removeEntryThrows = new Set(["c"]);
    expect(await deleteDirectory("media/c")).toBe(false);
  });
});

describe("deleting the media of a chat", () => {
  it("removes the folder", async () => {
    fs.put("media/chat-1/a.png");
    expect(await getMediaStorageService().deleteChatDir("chat-1")).toBe(true);
    expect(fs.has("media/chat-1")).toBe(false);
  });

  it("says a failed delete at warn level, with the chat id, and leaves the folder for the sweep", async () => {
    fs.put("media/chat-1/a.png");
    fs.failures.removeEntryThrows = new Set(["chat-1"]);
    expect(await getMediaStorageService().deleteChatDir("chat-1")).toBe(false);
    expect(fs.has("media/chat-1/a.png")).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("chat chat-1"),
      expect.anything(),
    );
  });
});
