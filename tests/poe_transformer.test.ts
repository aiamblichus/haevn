import { afterEach, describe, expect, it, vi } from "vitest";
import { BinaryContent, UserPromptPart } from "../src/model/haevn_model";
import type {
  Attachment,
  Message,
  MessageAuthor,
  PoeConversationData,
} from "../src/providers/poe/model";
import { transformPoeToHaevn } from "../src/providers/poe/transformer";
import * as mediaUtils from "../src/utils/media_utils";

// Messages in the shape Poe's payload has now (HVN-112): a user turn carries `authorUser` and
// `bot: null`, a bot turn `authorUser: null` and a `bot`. There is no `author` field. Every text
// here is synthetic.

const SYNTHETIC_USER: MessageAuthor = {
  uid: 1001,
  id: "user-1001",
  fullName: "Synthetic User",
  handle: "synthetic-user",
};

const SYNTHETIC_BOT = {
  botId: 456,
  id: "bot-456",
  displayName: "TestBot",
  deletionState: "not_deleted",
  picture: null,
  smallPicture: null,
};

interface TurnOptions {
  attachments?: Attachment[];
  state?: string;
  messageStateText?: string | null;
}

function baseMessage(
  text: string,
  creationTime: number,
  options: TurnOptions,
  authorUser: MessageAuthor | null,
  bot: Message["bot"],
): Message {
  return {
    id: `msg-${creationTime}`,
    messageId: creationTime,
    messageCode: `code-${creationTime}`,
    authorUser,
    bot,
    text,
    contentType: "text_markdown",
    sourceType: "chat_input",
    state: options.state ?? "complete",
    creationTime,
    isEdited: false,
    isDeleted: false,
    isChatAnnouncement: false,
    hasCitations: false,
    attachments: options.attachments ?? [],
    referencedMessageV2: null,
    usersCanEdit: [],
    messageStateText: options.messageStateText ?? null,
    parameters: null,
    command: null,
  };
}

/** A user turn: `authorUser` set, `bot` null. */
function userTurn(text: string, creationTime: number, options: TurnOptions = {}): Message {
  return baseMessage(text, creationTime, options, SYNTHETIC_USER, null);
}

/** A bot turn: `authorUser` null, `bot` set. */
function botTurn(text: string, creationTime: number, options: TurnOptions = {}): Message {
  return baseMessage(text, creationTime, options, null, SYNTHETIC_BOT);
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

function poeData(
  chatCode: string,
  messages: Message[],
  extra: Partial<PoeConversationData> = {},
): PoeConversationData {
  return {
    chatId: "Q2hhdDoxMjM=",
    chatCode,
    title: "Synthetic Poe Chat",
    botName: "TesterBot",
    extractedAt: "2024-05-10T10:00:00.000Z",
    messages,
    ...extra,
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

    const data = poeData("poe-1", [userTurn("Hello", msg1Time), botTurn("Hi!", msg2Time)], {
      title: "Poe Chat",
      botName: "Claude-in-Poe",
    });

    const chats = await transformPoeToHaevn(data);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    // Should be msg2Time in milliseconds
    expect(chat.providerLastModifiedTimestamp).toBe(Math.floor(msg2Time / 1000));
  });

  it("extracts system prompt when available", async () => {
    const data = poeData("poe-1", [userTurn("Hello", 1714557480000000)], {
      title: "Poe Chat",
      botName: "Claude-in-Poe",
      systemPrompt: "You are a helpful assistant.",
    });

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
    const data = poeData(
      "poe-1",
      [
        userTurn("Look at this image", msgTime, {
          attachments: [createAttachment(imageUrl, "image/png", "image.png")],
        }),
      ],
      { title: "Poe Image Chat", botName: "Claude-in-Poe" },
    );

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
    const data = poeData(
      "poe-linear-test",
      [
        userTurn("Hello", 1715335800000000),
        botTurn("Hi there!", 1715335860000000),
        userTurn("New topic", 1715335920000000),
        botTurn("Okay, what about it?", 1715335980000000),
      ],
      { title: "Poe Linear Chat", botName: "TesterBot" },
    );

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

  it("reads each turn's author from authorUser and bot: the user's turn is a request, the bot's a response", async () => {
    const data = poeData("poe-roles", [
      userTurn("Synthetic question", 1715335800000000),
      botTurn("Synthetic answer", 1715335860000000),
    ]);

    const [chat] = await transformPoeToHaevn(data);
    const all = Object.values(chat.messages);
    const question = all.find((m) => !m.parentId);
    expect(question).toBeDefined();
    expect(question?.message[0].kind).toBe("request");
    if (question?.message[0].kind === "request") {
      expect(question.message[0].parts[0]).toMatchObject({ content: "Synthetic question" });
    }

    const answer = all.find((m) => m.parentId === question?.id);
    expect(answer?.message[0].kind).toBe("response");
    if (answer?.message[0].kind === "response") {
      expect(answer.message[0].parts).toEqual([
        expect.objectContaining({ part_kind: "text", content: "Synthetic answer" }),
      ]);
    }
  });

  it("handles chat breaks as multiple roots", async () => {
    const data = poeData("poe-break-test", [
      userTurn("Hello", 1715335800000000),
      botTurn("Hi there!", 1715335860000000),
      // Context-clear marker: a user turn with no text and no attachment
      userTurn("", 1715335920000000),
      userTurn("New topic", 1715335980000000),
      botTurn("Okay, what about it?", 1715336040000000),
    ], { title: "Poe Chat with Break", botName: "TesterBot" });

    const chats = await transformPoeToHaevn(data);

    // Single chat
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    expect(chat.id).toBe("poe-break-test");

    // 4 real messages (the marker is filtered out)
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

  it("does not render a context-clear marker as an empty prompt", async () => {
    const data = poeData("poe-marker", [
      userTurn("Question", 1715335800000000),
      botTurn("Answer", 1715335860000000),
      userTurn("", 1715335920000000),
    ]);

    const [chat] = await transformPoeToHaevn(data);
    const all = Object.values(chat.messages);
    expect(all).toHaveLength(2);
    for (const m of all) {
      if (m.message[0].kind === "request") {
        expect(m.message[0].parts[0]).not.toMatchObject({ content: "" });
      }
    }
  });

  it("keeps a bot turn with no text as a failed reply, not as a chat break", async () => {
    const data = poeData("poe-failed", [
      userTurn("Question", 1715335800000000),
      botTurn("", 1715335860000000, {
        state: "error_insufficient_fund",
        messageStateText: "Synthetic reason: the account has no credit left.",
      }),
      userTurn("Follow-up", 1715335920000000),
    ]);

    const [chat] = await transformPoeToHaevn(data);
    const all = Object.values(chat.messages);
    // Still one chain: the failed reply is not a break
    expect(all.filter((m) => !m.parentId)).toHaveLength(1);
    expect(all).toHaveLength(3);
  });

  it("keeps the reason of a failed reply as a text part", async () => {
    const reason = "Synthetic reason: the account has no credit left.";
    const data = poeData("poe-failed-part", [
      userTurn("Question", 1715335800000000),
      botTurn("", 1715335860000000, {
        state: "error_insufficient_fund",
        messageStateText: reason,
      }),
    ]);

    const [chat] = await transformPoeToHaevn(data);
    const reply = Object.values(chat.messages).find((m) => m.message[0].kind === "response");
    expect(reply?.message[0].kind).toBe("response");
    if (reply?.message[0].kind === "response") {
      expect(reply.message[0].parts).toEqual([
        expect.objectContaining({ part_kind: "text", content: reason }),
      ]);
    }
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

    const data = poeData(
      "poe-video-test",
      [
        botTurn("Here is the video you requested.", 1715428740000000, {
          attachments: [createAttachment(videoUrl, "video/mp4")],
        }),
      ],
      { title: "Poe Chat with Video", botName: "VideoBot" },
    );

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
