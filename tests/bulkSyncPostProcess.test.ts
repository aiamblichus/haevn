import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { handleWorkerMessage } from "../src/background/bulkSync/workerHandler";
import type { BulkSyncWorkerResponse } from "../src/types/workerMessages";
import { ensureSafeMessage } from "../src/utils/messageSafety";

// The bulk sync worker saves a chat and posts a postProcess message for the service worker. A chat
// with inline media can be past Chrome's 64 MB message limit, and offscreen then drops the message
// (HVN-121), so the message must carry a summary of the chat, not the chat. The transform and the
// save are not under test here: the transform hands the worker a chat, and the save is a stub.
const { saveChat, transformed } = vi.hoisted(() => ({
  saveChat: vi.fn(),
  transformed: { chats: [] as Chat[] },
}));

vi.mock("../src/services/chatPersistence", () => ({ saveChat }));
vi.mock("../src/background/utils/platformTransform", () => ({
  transformRawDataToHaevn: vi.fn(async () => transformed.chats),
}));
vi.mock("../src/providers/index", () => ({ registerAllProviders: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The handler's collaborators: the calls it makes are what the test checks.
const { addOrUpdateChatInIndex, setSyncStatus, updateProviderStats, generateThumbnails, send } =
  vi.hoisted(() => ({
    addOrUpdateChatInIndex: vi.fn(async () => undefined),
    setSyncStatus: vi.fn(async () => undefined),
    updateProviderStats: vi.fn(async () => undefined),
    generateThumbnails: vi.fn(async () => undefined),
    send: vi.fn(),
  }));

vi.mock("../src/services/syncService", () => ({ SyncService: { addOrUpdateChatInIndex } }));
vi.mock("../src/services/cacheService", () => ({
  CacheService: { setSyncStatus, updateProviderStats },
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: generateThumbnails,
}));
vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: send }));

type Posted = { type: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
const workerSelf: WorkerGlobal = { postMessage: (message) => posted.push(message) };

// Tens of MB of inline media, as a base64 string in a message's content.
const INLINE_MEDIA_CHARS = 40 * 1024 * 1024;

function chatWithInlineMedia(id: string): Chat {
  return {
    id,
    source: "chatgpt",
    sourceId: `provider-${id}`,
    title: "A chat with a picture",
    models: ["gpt-4o"],
    params: {},
    currentId: "m1",
    messages: {
      m1: {
        id: "m1",
        childrenIds: [],
        model: "gpt-4o",
        done: true,
        chatId: id,
        message: [
          {
            kind: "request",
            parts: [
              {
                part_kind: "user-prompt",
                timestamp: "2026-11-21T10:00:00Z",
                content: [
                  {
                    kind: "binary",
                    data: "A".repeat(INLINE_MEDIA_CHARS),
                    media_type: "image/png",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    tags: [],
    timestamp: 1_700_000_000_000,
    lastSyncedTimestamp: 1_700_000_100_000,
    checksum: "checksum",
    syncStatus: "synced",
    deleted: 0,
  };
}

// Runs one sync task through the worker and returns what it posted.
async function syncOne(chat: Chat): Promise<Posted[]> {
  transformed.chats = [chat];
  posted = [];
  await workerSelf.onmessage?.({
    data: {
      type: "sync",
      requestId: "r1",
      data: { chatId: chat.id, platformName: "chatgpt", hostname: "chatgpt.com", rawData: {} },
    },
  });
  return posted;
}

// The worker assigns its message handler when it loads, so it loads once, after the stub.
beforeAll(async () => {
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/bulkSync/bulkSync.worker");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the bulk sync worker posts a summary of a saved chat, not the chat (HVN-121)", () => {
  it("posts a postProcess message under 1 MB for tens of MB of inline media", async () => {
    const messages = await syncOne(chatWithInlineMedia("big-1"));

    const post = messages.find((m) => m.type === "postProcess");
    expect(post).toBeDefined();
    const bytes = new TextEncoder().encode(JSON.stringify(post)).byteLength;
    expect(bytes).toBeLessThan(1024 * 1024);
    // The offscreen document forwards a message only when it passes this check.
    expect(ensureSafeMessage(post).safe).toBe(true);
  });
});

describe("the service worker post-processes the summary the same way (HVN-121)", () => {
  it("makes the same five calls for the message the worker posts", async () => {
    const messages = await syncOne(chatWithInlineMedia("big-2"));
    const post = messages.find((m) => m.type === "postProcess");

    await handleWorkerMessage(post as unknown as BulkSyncWorkerResponse);

    expect(addOrUpdateChatInIndex).toHaveBeenCalledTimes(1);
    expect(addOrUpdateChatInIndex).toHaveBeenCalledWith("big-2");
    expect(setSyncStatus).toHaveBeenCalledTimes(1);
    expect(setSyncStatus).toHaveBeenCalledWith("chatgpt", "provider-big-2", true, "big-2");
    expect(updateProviderStats).toHaveBeenCalledTimes(1);
    expect(updateProviderStats).toHaveBeenCalledWith("chatgpt", 1);
    expect(generateThumbnails).toHaveBeenCalledTimes(1);
    expect(generateThumbnails).toHaveBeenCalledWith("big-2");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      action: "chatSynced",
      meta: {
        id: "big-2",
        source: "chatgpt",
        title: "A chat with a picture",
        lastSyncedTimestamp: 1_700_000_100_000,
        syncStatus: "synced",
        providerLastModifiedTimestamp: undefined,
        lastSyncAttemptMessage: undefined,
      },
    });
  });
});
