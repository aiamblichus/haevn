import { describe, it, expect } from "vitest";
import { transformOpenWebUIToHaevn } from "../src/providers/openwebui/transformer";
import type { OpenWebUIRawExtraction } from "../src/providers/openwebui/model";

describe("OpenWebUI Transformer", () => {
  it("should extract system prompt from chat.chat.params.system", () => {
    const raw: OpenWebUIRawExtraction = {
      chat: {
        id: "test-id",
        user_id: "user-id",
        title: "Test Chat",
        updated_at: 1700000000,
        created_at: 1700000000,
        archived: false,
        chat: {
          params: {
            system: "System prompt from params",
          },
          history: {
            messages: {
              "msg-1": {
                role: "user",
                content: "Hello",
                timestamp: 1700000000,
              },
            },
            currentId: "msg-1",
          },
        },
        system: "System prompt from params", // Extractor ensures this is here
      },
      folderSystems: ["Folder prompt"],
    };

    const transformed = transformOpenWebUIToHaevn(raw);
    expect(transformed.system).toContain("Folder prompt");
    expect(transformed.system).toContain("System prompt from params");
  });

  it("should handle role: 'system' messages in history", () => {
    const raw: OpenWebUIRawExtraction = {
      chat: {
        id: "test-id",
        user_id: "user-id",
        title: "Test Chat",
        updated_at: 1700000000,
        created_at: 1700000000,
        archived: false,
        chat: {
          history: {
            messages: {
              "msg-0": {
                role: "system",
                content: "In-history system message",
                timestamp: 1699999999,
              },
              "msg-1": {
                role: "user",
                content: "Hello",
                timestamp: 1700000000,
                parentId: "msg-0",
              },
            },
            currentId: "msg-1",
          },
        },
      },
    };

    const transformed = transformOpenWebUIToHaevn(raw);
    const msgs = Object.values(transformed.messages);
    const systemMsg = msgs.find(m => m.id === "msg-0");
    
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.message[0].kind).toBe("request");
    expect(systemMsg?.message[0].parts[0].part_kind).toBe("system-prompt");
    expect(systemMsg?.message[0].parts[0].content).toBe("In-history system message");
  });
});
