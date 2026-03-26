import { describe, expect, it } from "vitest";
import {
  type ExportOptions,
  generateExportContent,
  generateExportFilename,
} from "../src/formatters";
import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../src/model/haevn_model";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  const req: ModelRequest = {
    kind: "request",
    parts: [
      {
        part_kind: "user-prompt",
        content: "Hello AI",
        timestamp: new Date("2024-01-01T10:00:00Z").toISOString(),
      },
    ],
  };
  const res: ModelResponse = {
    kind: "response",
    parts: [{ part_kind: "text", content: "Hi! How can I help?" }],
    timestamp: new Date("2024-01-01T10:00:05Z").toISOString(),
    model_name: "test-model",
  };
  const msg: ChatMessage = {
    id: "m1",
    childrenIds: [],
    message: [req],
    model: "user",
    done: true,
    chatId: "c1",
    timestamp: Date.now(),
  };
  const msg2: ChatMessage = {
    id: "m2",
    parentId: "m1",
    childrenIds: [],
    message: [res],
    model: "assistant-model",
    done: true,
    chatId: "c1",
    timestamp: Date.now(),
  };
  const base: Chat = {
    id: "c1",
    source: "claude",
    sourceId: "c1",
    title: "Sample Chat: test/<>",
    models: ["test-model"],
    params: {},
    currentId: "m2",
    messages: { m1: msg, m2: msg2 },
    tags: [],
    timestamp: Date.now(),
    files: [],
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: Date.now(),
    checksum: "abc",
    syncStatus: "synced",
  } as Chat;
  return { ...base, ...overrides };
}

describe("formatters", () => {
  it("generates JSON export", async () => {
    const chat = makeChat();
    const content = await generateExportContent(chat, {
      format: "json",
      includeMetadata: true,
      includeTimestamps: true,
    } as ExportOptions);
    expect(content).toContain("Sample Chat");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("c1");
  });

  it("generates Markdown export with YAML frontmatter", async () => {
    const chat = makeChat();
    const content = await generateExportContent(chat, {
      format: "markdown",
      includeMetadata: true,
      includeTimestamps: true,
    });
    expect(content).toMatch(/^---\n[\s\S]+\n---\n\n/);
    expect(content).toMatch(/title:\s+/);
    expect(content).toContain(`source: ${chat.source}`);
    expect(content).toContain(`conversation_id: ${chat.id}`);
    expect(content).toContain("created_at:");
    expect(content).toContain("modified_at:");
    expect(content).toContain('<!-- HAEVN: role="user" -->');
    expect(content).toContain('<!-- HAEVN: role="assistant" -->');
  });

  it("generates export filename with sanitized title and extension", () => {
    const nameJson = generateExportFilename("claude", "A/B<C>?*Title", "json");
    expect(nameJson.endsWith(".json")).toBe(true);
    expect(nameJson).not.toMatch(/[<>:"/\\|?*]/);

    const nameMd = generateExportFilename("gemini", "Hello World", "markdown");
    expect(nameMd.endsWith(".md")).toBe(true);
  });

  it("generates Claude export filename with conversation ID", () => {
    const conversationId = "f75ac9be-f5d9-427e-87c8-6abd82a9ef10";
    const nameJson = generateExportFilename("claude", "Some Title", "json", conversationId);
    expect(nameJson).toBe(`claude_chat_${conversationId}.json`);
    expect(nameJson).not.toContain("Some Title");

    const nameMd = generateExportFilename("claude", "Another Title", "markdown", conversationId);
    expect(nameMd).toBe(`claude_chat_${conversationId}.md`);
  });
});
