import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";

// HVN-159: a chat whose media could not be stored is saved with links, and the sync says so: the
// bulk-sync worker in its progress report, a popup sync in the log. The transform is stubbed to
// hand back a chat whose parts carry the mark; what is under test is what each caller does with it.

const { transform, saveChat, log } = vi.hoisted(() => ({
  transform: vi.fn(),
  saveChat: vi.fn(async () => undefined),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/utils/logger", () => ({ log }));

vi.mock("../src/background/utils/platformTransform", () => ({
  transformRawDataToHaevn: transform,
}));
vi.mock("../src/services/chatPersistence", () => ({ saveChat }));
vi.mock("../src/services/syncService", () => ({
  SyncService: {
    getChat: vi.fn(async () => null),
    saveChat: vi.fn(async () => undefined),
  },
}));
vi.mock("../src/services/cacheService", () => ({
  CacheService: {
    setSyncStatus: vi.fn(async () => undefined),
    updateProviderStats: vi.fn(async () => undefined),
  },
}));
vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: vi.fn() }));

const mark = (unstored: string) => ({ vendor_metadata: { unstored } });

/** A chat with two parts that are links because a download failed, and one link on purpose. */
function chatWithUnstored(id: string): Chat {
  return {
    id,
    source: "gemini",
    sourceId: id,
    title: "t",
    messages: {
      m1: {
        message: [
          {
            kind: "request",
            parts: [
              {
                part_kind: "user-prompt",
                content: [
                  { kind: "image-url", url: "https://a.test/1", ...mark("http_403") },
                  { kind: "image-url", url: "https://b.test/on-purpose" },
                ],
              },
            ],
          },
        ],
      },
      m2: {
        message: [
          {
            kind: "response",
            parts: [
              {
                part_kind: "image-response",
                content: { kind: "image-url", url: "https://a.test/2", ...mark("timeout") },
              },
            ],
          },
        ],
      },
    },
  } as unknown as Chat;
}

beforeEach(() => {
  vi.resetModules();
  transform.mockReset();
  saveChat.mockClear();
  for (const fn of Object.values(log)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const warned = () => log.warn.mock.calls.map((call) => call.join(" "));

describe("the bulk-sync worker's report", () => {
  async function runTask(chats: Chat[]) {
    const postMessage = vi.fn();
    const self = { postMessage, onmessage: null as unknown };
    vi.stubGlobal("self", self);
    transform.mockResolvedValue(chats);
    await import("../src/background/bulkSync/bulkSync.worker");
    await (self.onmessage as (e: unknown) => Promise<void>)({
      data: {
        type: "sync",
        data: {
          chatId: "c1",
          platformName: "gemini",
          hostname: "gemini.google.com",
          rawData: {},
          runId: "1:0",
        },
      },
    });
    return postMessage;
  }

  it("carries the number of files not stored, and logs the chat's id, count and codes", async () => {
    const postMessage = await runTask([chatWithUnstored("chat-1")]);

    const progress = postMessage.mock.calls.map(([m]) => m).find((m) => m.type === "progress");
    expect(progress).toMatchObject({ success: true, savedIds: ["chat-1"], unstoredMedia: 2 });
    const lines = warned().filter((line) => line.includes("chat-1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 media file(s) not stored");
    expect(lines[0]).toContain("http_403, timeout");
    expect(lines[0]).not.toContain("a.test");
  });

  it("adds the chats of one task, and logs nothing for a chat with every file stored", async () => {
    const clean = { ...chatWithUnstored("chat-2"), messages: {} } as Chat;
    const postMessage = await runTask([chatWithUnstored("chat-1"), clean]);

    const progress = postMessage.mock.calls.map(([m]) => m).find((m) => m.type === "progress");
    expect(progress).toMatchObject({ savedIds: ["chat-1", "chat-2"], unstoredMedia: 2 });
    expect(warned().filter((line) => line.includes("chat-2"))).toEqual([]);
  });
});

describe("a popup sync", () => {
  it("logs the same line for a chat it saved with links", async () => {
    transform.mockResolvedValue([chatWithUnstored("chat-1")]);
    const { transformAndSaveChat } = await import("../src/background/utils/chatSyncUtils");

    await transformAndSaveChat({} as never, "gemini", "gemini.google.com");

    const lines = warned().filter((line) => line.includes("chat-1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 media file(s) not stored");
    expect(lines[0]).toContain("http_403, timeout");
  });
});
