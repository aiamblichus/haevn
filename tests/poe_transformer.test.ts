import { afterEach, describe, expect, it, vi } from "vitest";
import { BinaryContent, UserPromptPart } from "../src/model/haevn_model";
import type { PoeConversationData, Message, Attachment } from "../src/providers/poe/model";
import { transformPoeToHaevn } from "../src/providers/poe/transformer";
import * as mediaUtils from "../src/utils/media_utils";

// Helper to create a minimal Message object for testing
function createMessage(overrides: Partial<Message> & { text: string; author: string; creationTime: number }): Message {
  return {
    id: `msg-${overrides.creationTime}`,
    messageId: overrides.creationTime,
    messageCode: `code-${overrides.creationTime}`,
    author: overrides.author,
    bot: overrides.author !== "human" ? {
      botId: 456,
      id: "bot-456",
      displayName: "TestBot",
      deletionState: "not_deleted",
      picture: null,
      smallPicture: null,
    } : null,
    text: overrides.text,
    contentType: "text_markdown",
    sourceType: "chat_input",
    state: "complete",
    creationTime: overrides.creationTime,
    isEdited: false,
    isDeleted: false,
    isChatAnnouncement: false,
    hasCitations: false,
    attachments: overrides.attachments || [],
    referencedMessageV2: null,
    usersCanEdit: [],
    messageStateText: null,
    parameters: null,
    command: null,
  };
}

// Helper to create an attachment
function createAttachment(url: string, mimeType: string, name?: string): Attachment {
  return {
    id: `att-${Date.now()}`,
    attachmentId: Date.now(),
    name: name || "file",
    url,
    isInline: false,
    file: {
      id: `file-${Date.now()}`,
      mimeType,
      size: 1000,
      url,
      thumbnailUrl: null,
    },
  };
}

describe("poe_transformer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets providerLastModifiedTimestamp from last message", async () => {
    // creationTime is in microseconds
    const msg1Time = 1714557480000000; // 2024-05-01T09:58:00.000Z in microseconds
    const msg2Time = 1714557540000000; // 2024-05-01T09:59:00.000Z in microseconds

    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-1",
      title: "Poe Chat",
      botName: "Claude-in-Poe",
      extractedAt: "2024-05-01T10:00:00.000Z",
      messages: [
        createMessage({ text: "Hello", author: "human", creationTime: msg1Time }),
        createMessage({ text: "Hi!", author: "bot", creationTime: msg2Time }),
      ],
    };

    const chats = await transformPoeToHaevn(data);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    // Should be msg2Time in milliseconds
    expect(chat.providerLastModifiedTimestamp).toBe(Math.floor(msg2Time / 1000));
  });

  it("extracts system prompt when available", async () => {
    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-1",
      title: "Poe Chat",
      botName: "Claude-in-Poe",
      systemPrompt: "You are a helpful assistant.",
      extractedAt: "2024-05-01T10:00:00.000Z",
      messages: [
        createMessage({ text: "Hello", author: "human", creationTime: 1714557480000000 }),
      ],
    };

    const chats = await transformPoeToHaevn(data);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    expect(chat.system).toBe("You are a helpful assistant.");
  });

  it("downloads and embeds images as binary content", async () => {
    const imageUrl = "https://example.com/image.png";
    const mockImageData = "fake-image-data";
    const mockImageBuffer = Buffer.from(mockImageData);

    vi.spyOn(mediaUtils, "processExternalAssets").mockImplementation(async (assets) => {
      return assets.map((asset) => {
        if (asset.type?.startsWith("image/")) {
          return {
            kind: "binary",
            data: mockImageBuffer.toString("base64"),
            media_type: asset.type,
          } as BinaryContent;
        }
        if (asset.type?.startsWith("video/")) {
          return {
            kind: "video-url",
            url: asset.url,
          };
        }
        return {
          kind: "document-url",
          url: asset.url,
        };
      }) as any;
    });

    const msgTime = 1714557480000000;
    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-1",
      title: "Poe Image Chat",
      botName: "Claude-in-Poe",
      extractedAt: "2024-05-01T10:00:00.000Z",
      messages: [
        createMessage({
          text: "Look at this image",
          author: "human",
          creationTime: msgTime,
          attachments: [createAttachment(imageUrl, "image/png", "image.png")],
        }),
      ],
    };

    const chats = await transformPoeToHaevn(data);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    const firstMessage = Object.values(chat.messages)[0];
    const request = firstMessage.message[0];
    expect(request.kind).toBe("request");
    if (request.kind === "request") {
      const userPrompt = request.parts[0] as UserPromptPart;
      const contentArray = userPrompt.content as any[];
      const imagePart = contentArray.find(
        (c) => typeof c === "object" && c.kind === "binary",
      ) as unknown as BinaryContent;
      expect(imagePart).toBeDefined();
      expect(imagePart.media_type).toBe("image/png");
      expect(imagePart.data).toBe(mockImageBuffer.toString("base64"));
    }
  });

  it("creates linear message history", async () => {
    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-linear-test",
      title: "Poe Linear Chat",
      botName: "TesterBot",
      extractedAt: "2024-05-10T10:00:00.000Z",
      messages: [
        createMessage({ text: "Hello", author: "human", creationTime: 1715335800000000 }),
        createMessage({ text: "Hi there!", author: "bot", creationTime: 1715335860000000 }),
        createMessage({ text: "New topic", author: "human", creationTime: 1715335920000000 }),
        createMessage({ text: "Okay, what about it?", author: "bot", creationTime: 1715335980000000 }),
      ],
    };

    const chats = await transformPoeToHaevn(data);

    // Single chat
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    expect(chat.id).toBe("poe-linear-test");
    expect(chat.title).toBe("Poe Linear Chat");

    // All 4 messages
    expect(Object.values(chat.messages)).toHaveLength(4);

    // Only one root (first message has no parent)
    const allMessages = Object.values(chat.messages);
    const roots = allMessages.filter((m) => !m.parentId);
    expect(roots).toHaveLength(1);

    // Verify linear chain
    const root = roots[0];
    expect(root.childrenIds).toHaveLength(1);
  });

  it("handles chat breaks as multiple roots", async () => {
    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-break-test",
      title: "Poe Chat with Break",
      botName: "TesterBot",
      extractedAt: "2024-05-10T10:00:00.000Z",
      messages: [
        createMessage({ text: "Hello", author: "human", creationTime: 1715335800000000 }),
        createMessage({ text: "Hi there!", author: "bot", creationTime: 1715335860000000 }),
        // Chat break - this becomes a marker for new root
        createMessage({ text: "", author: "chat_break", creationTime: 1715335920000000 }),
        createMessage({ text: "New topic", author: "human", creationTime: 1715335980000000 }),
        createMessage({ text: "Okay, what about it?", author: "bot", creationTime: 1715336040000000 }),
      ],
    };

    const chats = await transformPoeToHaevn(data);

    // Single chat
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    expect(chat.id).toBe("poe-break-test");

    // 4 real messages (chat_break filtered out)
    expect(Object.values(chat.messages)).toHaveLength(4);

    // Two roots (messages without parentId)
    const allMessages = Object.values(chat.messages);
    const roots = allMessages.filter((m) => !m.parentId);
    expect(roots).toHaveLength(2);

    // First root chain: "Hello" -> "Hi there!"
    const root1 = roots.find((r) => {
      const msg = r.message[0] as any;
      return msg.parts?.[0]?.content === "Hello";
    });
    expect(root1).toBeDefined();
    expect(root1?.childrenIds).toHaveLength(1);

    // Second root chain: "New topic" -> "Okay, what about it?"
    const root2 = roots.find((r) => {
      const msg = r.message[0] as any;
      return msg.parts?.[0]?.content === "New topic";
    });
    expect(root2).toBeDefined();
    expect(root2?.childrenIds).toHaveLength(1);
  });

  it("extracts video attachments as video-url", async () => {
    const videoUrl = "https://pfst.cf2.poecdn.net/base/video/some-video.mp4";

    // Mock processExternalAssets to avoid actual network requests
    vi.spyOn(mediaUtils, "processExternalAssets").mockImplementation(async (assets) => {
      return assets.map((asset) => {
        if (asset.type?.startsWith("video/")) {
          return {
            kind: "video-url",
            url: asset.url,
          };
        }
        return {
          kind: "document-url",
          url: asset.url,
        };
      }) as any;
    });

    const data: PoeConversationData = {
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-video-test",
      title: "Poe Chat with Video",
      botName: "VideoBot",
      extractedAt: "2024-05-11T12:00:00.000Z",
      messages: [
        createMessage({
          text: "Here is the video you requested.",
          author: "bot",
          creationTime: 1715428740000000,
          attachments: [createAttachment(videoUrl, "video/mp4")],
        }),
      ],
    };

    const chats = await transformPoeToHaevn(data);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    const firstMessage = Object.values(chat.messages)[0];
    const response = firstMessage.message[0];

    expect(response.kind).toBe("response");
    if (response.kind === "response") {
      const videoPart = response.parts.find((p) => p.part_kind === "video-response");
      expect(videoPart).toBeDefined();
      if (videoPart && videoPart.part_kind === "video-response") {
        const videoContent = videoPart.content;
        expect(videoContent.kind).toBe("video-url");
        if (videoContent.kind === "video-url") {
          expect(videoContent.url).toBe(videoUrl);
        }
      }
    }
  });
});
