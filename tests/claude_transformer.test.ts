import { describe, expect, it } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import type { ChatTranscript } from "../src/providers/claude/model";
import { convertClaudeTranscriptToHaevn } from "../src/providers/claude/transformer";

describe("claude_transformer", () => {
  it("should convert a claude transcript to the haevn format", async () => {
    const transcript: ChatTranscript = {
      uuid: "f75ac9be-f5d9-427e-87c8-6abd82a9ef10",
      name: "Sample Claude Chat",
      updated_at: "2024-01-01T12:00:00Z",
      current_leaf_message_uuid: "msg-2",
      chat_messages: [
        {
          uuid: "msg-1",
          text: "Hello",
          sender: "human",
          created_at: "2024-01-01T11:59:00Z",
          updated_at: "2024-01-01T11:59:00Z",
          attachments: [
            {
              file_name: "test.png",
              file_size: 100,
              file_type: "image/png",
              extracted_content: "fake content",
            },
          ],
        },
        {
          uuid: "msg-2",
          text: "Hi!",
          sender: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          updated_at: "2024-01-01T12:00:00Z",
          attachments: [],
        },
      ],
    } as unknown as ChatTranscript;

    const haevnChat: Chat = await convertClaudeTranscriptToHaevn(transcript);

    // Check top-level properties
    expect(haevnChat.id).toBe(transcript.uuid);
    expect(haevnChat.title).toBe(transcript.name);
    expect(haevnChat.source).toBe("claude");
    expect(haevnChat.currentId).toBe(transcript.current_leaf_message_uuid);
    expect(Object.keys(haevnChat.messages).length).toBe(transcript.chat_messages.length);

    // Check parent-child relationship
    const firstMessageId = transcript.chat_messages[0].uuid;
    const secondMessageId = transcript.chat_messages[1].uuid;
    const firstMessage = haevnChat.messages[firstMessageId];
    const secondMessage = haevnChat.messages[secondMessageId];

    expect(firstMessage).toBeDefined();
    expect(secondMessage).toBeDefined();
    expect(secondMessage.parentId).toBe(firstMessageId);
    expect(firstMessage.childrenIds).toContain(secondMessageId);

    // Provider last modified timestamp should be set from updated_at
    expect(haevnChat.providerLastModifiedTimestamp).toBe(new Date(transcript.updated_at).getTime());
  });
});
