import { describe, expect, it } from "vitest";
import { rewriteChatMediaRefs } from "../src/background/import/rewriteMediaRefs";
import type { Chat, ChatMessage, ModelMessage } from "../src/model/haevn_model";

function chatWith(messageId: string, model: ModelMessage): Chat {
  const message: ChatMessage = {
    id: messageId,
    childrenIds: [],
    message: [model],
    model: "",
    done: true,
    timestamp: 0,
    chatId: "chat-1",
  };
  return {
    id: "chat-1",
    source: "test",
    sourceId: "chat-1",
    title: "t",
    models: [],
    params: {},
    currentId: messageId,
    messages: { [messageId]: message },
    tags: [],
    timestamp: 0,
    lastSyncedTimestamp: 0,
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
  };
}

function mediaMap(paths: Record<number, string>) {
  return new Map([
    ["chat-1", new Map([["m1", new Map(Object.entries(paths).map(([k, v]) => [Number(k), v]))]])],
  ]);
}

describe("rewriteChatMediaRefs", () => {
  it("points a request's attachments at the restored files, counting only non-text content", () => {
    const chat = chatWith("m1", {
      kind: "request",
      parts: [
        {
          part_kind: "user-prompt",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: [
            "look at these",
            { kind: "image-url", url: "https://example.com/a.png" },
            { kind: "binary", data: "AAAA", media_type: "application/pdf" },
            { kind: "document-url", url: "https://example.com/b" },
          ],
        },
      ],
    });

    rewriteChatMediaRefs(
      chat,
      mediaMap({ 0: "media/chat-1/m1_0.png", 1: "media/chat-1/m1_1.pdf" }),
    );

    const [request] = chat.messages.m1.message;
    if (request.kind !== "request" || request.parts[0].part_kind !== "user-prompt") {
      throw new Error("unexpected shape");
    }
    expect(request.parts[0].content).toEqual([
      "look at these",
      {
        kind: "binary",
        data: "media/chat-1/m1_0.png",
        media_type: "image/jpeg",
        identifier: "media/chat-1/m1_0.png",
      },
      {
        kind: "binary",
        data: "media/chat-1/m1_1.pdf",
        media_type: "application/pdf",
        identifier: "media/chat-1/m1_1.pdf",
      },
      // no path restored for the third attachment: left as it was
      { kind: "document-url", url: "https://example.com/b" },
    ]);
  });

  it("rewrites a response's media parts and leaves text and thinking alone", () => {
    const chat = chatWith("m1", {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [
        { part_kind: "text", content: "here you go" },
        { part_kind: "image-response", content: { kind: "image-url", url: "https://e.com/x" } },
        { part_kind: "thinking", content: "hmm" },
        {
          part_kind: "document-response",
          content: { kind: "binary", data: "AAAA", media_type: "text/csv" },
        },
        { part_kind: "audio-response", content: { kind: "audio-url", url: "https://e.com/y" } },
      ],
    });

    rewriteChatMediaRefs(
      chat,
      mediaMap({
        0: "media/chat-1/m1_0.png",
        1: "media/chat-1/m1_1.csv",
        2: "media/chat-1/m1_2.bin",
      }),
    );

    const [response] = chat.messages.m1.message;
    expect(response.parts).toEqual([
      { part_kind: "text", content: "here you go" },
      {
        part_kind: "image-response",
        content: {
          kind: "binary",
          data: "media/chat-1/m1_0.png",
          media_type: "image/jpeg",
          identifier: "media/chat-1/m1_0.png",
        },
      },
      { part_kind: "thinking", content: "hmm" },
      {
        part_kind: "document-response",
        content: {
          kind: "binary",
          data: "media/chat-1/m1_1.csv",
          media_type: "text/csv",
          identifier: "media/chat-1/m1_1.csv",
        },
      },
      {
        part_kind: "audio-response",
        content: {
          kind: "binary",
          data: "media/chat-1/m1_2.bin",
          media_type: "application/octet-stream",
          identifier: "media/chat-1/m1_2.bin",
        },
      },
    ]);
  });

  it("does nothing for a chat with no restored media", () => {
    const chat = chatWith("m1", {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [
        { part_kind: "image-response", content: { kind: "image-url", url: "https://e.com/x" } },
      ],
    });
    const before = JSON.stringify(chat);

    rewriteChatMediaRefs(chat, new Map());

    expect(JSON.stringify(chat)).toBe(before);
  });
});
