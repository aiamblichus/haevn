import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";
import { SyncService } from "../src/services/syncService";

function buildMinimalChat(overrides: Partial<Chat> = {}): Chat {
  const request: ModelRequest = {
    kind: "request",
    parts: [
      {
        part_kind: "user-prompt",
        content: "Hello",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
    ],
  };

  const response: ModelResponse = {
    kind: "response",
    parts: [
      {
        part_kind: "text",
        content: "Hi! How can I help?",
      },
    ],
    timestamp: "2024-01-01T00:00:00.000Z",
  };

  const msg: ChatMessage = {
    id: "m1",
    childrenIds: [],
    message: [request, response],
    model: "test-model",
    done: true,
    chatId: "chat-1",
    timestamp: 1704067200000, // 2024-01-01T00:00:00Z
  };

  const base: Chat = {
    id: "chat-1",
    source: "test",
    sourceId: "src-1",
    title: "Test Chat",
    models: ["test-model"],
    system: undefined,
    params: {},
    currentId: "m1",
    messages: { m1: msg },
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "new",
    lastSyncAttemptMessage: undefined,
    ...overrides,
  };

  return base;
}

describe("SyncService.generateChatChecksum", () => {
  it("produces the same checksum for identical content", async () => {
    const chat1 = buildMinimalChat();
    const chat2 = buildMinimalChat({
      syncStatus: "error",
      lastSyncedTimestamp: 123,
    });

    const sum1 = await SyncService.generateChatChecksum(chat1);
    const sum2 = await SyncService.generateChatChecksum(chat2);
    expect(sum1).toBe(sum2);
  });

  it("produces different checksums when content changes", async () => {
    const chat1 = buildMinimalChat();
    const chat2 = buildMinimalChat({ title: "Another Title" });

    const sum1 = await SyncService.generateChatChecksum(chat1);
    const sum2 = await SyncService.generateChatChecksum(chat2);
    expect(sum1).not.toBe(sum2);
  });
});
