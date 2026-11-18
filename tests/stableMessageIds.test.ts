import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIStudioConversationData } from "../src/providers/aistudio/model";
import { transformAIStudioToHaevn } from "../src/providers/aistudio/transformer";
import type { GeminiConversationData } from "../src/providers/gemini/model";
import { transformGeminiToHaevn } from "../src/providers/gemini/transformer";
import type { Message, PoeConversationData } from "../src/providers/poe/model";
import { transformPoeToHaevn } from "../src/providers/poe/transformer";
import { stableMessageIds } from "../src/providers/shared/stableIds";
import * as mediaUtils from "../src/utils/media_utils";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-90: a message id names the media files of the message, so the same chat transformed twice
// must come out with the same ids, and so with the same file names.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function poeMessage(id: string, author: string, creationTime: number, text: string): Message {
  return {
    id,
    messageId: creationTime,
    messageCode: `code-${id}`,
    author,
    bot:
      author === "human"
        ? null
        : {
            botId: 1,
            id: "bot",
            displayName: "Bot",
            deletionState: "not_deleted",
            picture: null,
            smallPicture: null,
          },
    text,
    contentType: "text_markdown",
    sourceType: "chat_input",
    state: "complete",
    creationTime,
    isEdited: false,
    isDeleted: false,
    isChatAnnouncement: false,
    hasCitations: false,
    attachments: [],
    referencedMessageV2: null,
    usersCanEdit: [],
    messageStateText: null,
    parameters: null,
    command: null,
  } as Message;
}

function poeChat(messages: Message[]): PoeConversationData {
  return {
    chatId: "Q2hhdDoxMjM=",
    chatCode: "poe-1",
    title: "Poe",
    botName: "Bot",
    extractedAt: "2024-05-01T10:00:00.000Z",
    messages,
  } as PoeConversationData;
}

function orderedIds(chat: { messages: Record<string, { id: string; timestamp: number }> }) {
  return Object.values(chat.messages)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

describe("stableMessageIds", () => {
  it("gives the same ids for the same chat and seeds, in UUID shape", async () => {
    const first = await stableMessageIds("chat", ["a", "b", "c"]);
    const second = await stableMessageIds("chat", ["a", "b", "c"]);
    expect(second).toEqual(first);
    for (const id of first) expect(id).toMatch(UUID_SHAPE);
  });

  it("gives different ids to different seeds and to different chats", async () => {
    const [a, b] = await stableMessageIds("chat", ["a", "b"]);
    const [other] = await stableMessageIds("other-chat", ["a"]);
    expect(new Set([a, b, other]).size).toBe(3);
  });

  it("tells identical seeds apart, and keeps telling them apart the same way", async () => {
    const first = await stableMessageIds("chat", ["same", "same", "same"]);
    expect(new Set(first).size).toBe(3);
    expect(await stableMessageIds("chat", ["same", "same", "same"])).toEqual(first);
  });
});

describe("Poe message ids", () => {
  afterEach(() => vi.restoreAllMocks());

  it("come from the id Poe gives the message: the same on every transform", async () => {
    const make = () =>
      poeChat([
        poeMessage("TWVzc2FnZTox", "human", 1714557480000000, "hello"),
        poeMessage("TWVzc2FnZToy", "bot", 1714557540000000, "hi"),
      ]);
    const first = await transformPoeToHaevn(make());
    const second = await transformPoeToHaevn(make());
    expect(orderedIds(second[0])).toEqual(orderedIds(first[0]));
    expect(second[0].currentId).toBe(first[0].currentId);
    expect(new Set(orderedIds(first[0])).size).toBe(2);
  });

  it("do not depend on the text or on where the message was fetched from", async () => {
    const before = await transformPoeToHaevn(
      poeChat([poeMessage("TWVzc2FnZTox", "human", 1714557480000000, "draft")]),
    );
    const after = await transformPoeToHaevn(
      poeChat([
        poeMessage("TWVzc2FnZTox", "human", 1714557480000000, "edited"),
        poeMessage("TWVzc2FnZToy", "bot", 1714557540000000, "a new reply"),
      ]),
    );
    expect(orderedIds(after[0])).toContain(orderedIds(before[0])[0]);
  });

  it("stay distinct for two identical messages that Poe gave no id", async () => {
    const bare = (time: number) => {
      const msg = poeMessage("", "human", time, "same words");
      msg.messageId = undefined as unknown as number;
      msg.messageCode = "";
      return msg;
    };
    const make = () => poeChat([bare(1714557480000000), bare(1714557480000000)]);
    const first = await transformPoeToHaevn(make());
    const second = await transformPoeToHaevn(make());
    const ids = orderedIds(first[0]);
    expect(new Set(ids).size).toBe(2);
    expect(orderedIds(second[0])).toEqual(ids);
  });

  it("hand the media download the id the message ends up with", async () => {
    const seen: Array<string | undefined> = [];
    vi.spyOn(mediaUtils, "processExternalAssets").mockImplementation(async (assets, options) => {
      seen.push(options.messageId);
      return assets.map((a) => ({ kind: "image-url", url: a.url })) as never;
    });
    const msg = poeMessage("TWVzc2FnZTox", "human", 1714557480000000, "look");
    msg.attachments = [
      {
        id: "att",
        isInline: false,
        url: "https://cdn.example/a.png",
        file: { id: "f", mimeType: "image/png", size: 1, url: "https://cdn.example/a.png" },
      },
    ];
    const chats = await transformPoeToHaevn(poeChat([msg]));
    expect(seen).toEqual([orderedIds(chats[0])[0]]);
  });
});

describe("Gemini message ids", () => {
  afterEach(() => vi.restoreAllMocks());

  const data = (timestamps: [string, string], text: string): GeminiConversationData => ({
    platform: "gemini",
    url: "https://gemini.google.com/app/abc",
    conversationId: "conv-1",
    title: "Gemini",
    messageCount: 3,
    extractedAt: "2024-06-01T10:00:00.000Z",
    messages: [
      {
        index: 1,
        content: "same",
        timestamp: timestamps[0],
        localTime: "",
        role: "user",
        files: [],
      },
      {
        index: 1,
        content: text,
        timestamp: timestamps[1],
        localTime: "",
        role: "assistant",
        files: [],
      },
      {
        index: 2,
        content: "same",
        timestamp: timestamps[0],
        localTime: "",
        role: "user",
        files: [],
      },
    ],
  });

  it("are the same when the same chat is read again, whatever its estimated times and text say", async () => {
    const first = await transformGeminiToHaevn(
      data(["2024-06-01T09:00:00.000Z", "2024-06-01T09:02:00.000Z"], "partial"),
    );
    const again = await transformGeminiToHaevn(
      data(["2024-06-01T09:30:00.000Z", "2024-06-01T09:32:00.000Z"], "the whole answer"),
    );
    expect(Object.keys(again.messages).sort()).toEqual(Object.keys(first.messages).sort());
    expect(again.currentId).toBe(first.currentId);
  });

  it("stay distinct for identical messages at different places", async () => {
    const chat = await transformGeminiToHaevn(
      data(["2024-06-01T09:00:00.000Z", "2024-06-01T09:02:00.000Z"], "x"),
    );
    expect(Object.keys(chat.messages)).toHaveLength(3);
  });

  it("hand the media download the id the message ends up with", async () => {
    const seen: Array<string | undefined> = [];
    vi.spyOn(mediaUtils, "processExternalAssets").mockImplementation(async (assets, options) => {
      seen.push(options.messageId);
      return assets.map((a) => ({ kind: "image-url", url: a.url })) as never;
    });
    const raw = data(["2024-06-01T09:00:00.000Z", "2024-06-01T09:02:00.000Z"], "x");
    raw.messages[1].files = [{ url: "https://lh3.googleusercontent.com/a" }];
    const chat = await transformGeminiToHaevn(raw, 7);
    expect(seen).toEqual([chat.messages[Object.keys(chat.messages)[1]].id]);
    const again = await transformGeminiToHaevn(raw, 7);
    expect(seen[1]).toBe(seen[0]);
    expect(again.currentId).toBe(chat.currentId);
  });
});

describe("AI Studio message ids", () => {
  const data = (stamp: string): AIStudioConversationData => ({
    platform: "aistudio",
    url: "https://aistudio.google.com/prompts/abc",
    conversationId: "ai-1",
    title: "AI Studio",
    messages: [
      { role: "user", content: "same", files: [], timestamp: stamp },
      { role: "assistant", content: "reply", files: [], timestamp: stamp },
      { role: "user", content: "same", files: [], timestamp: stamp },
    ],
    extractedAt: stamp,
  });

  it("are the same when the same chat is read again, and distinct for identical messages", async () => {
    const first = await transformAIStudioToHaevn(data("2024-06-01T09:00:00.000Z"));
    const again = await transformAIStudioToHaevn(data("2024-06-01T09:45:00.000Z"));
    expect(Object.keys(first.messages)).toHaveLength(3);
    expect(Object.keys(again.messages).sort()).toEqual(Object.keys(first.messages).sort());
    expect(again.currentId).toBe(first.currentId);
  });
});

describe("a chat synced twice", () => {
  let fs: FakeOpfs;

  beforeEach(() => {
    fs = new FakeOpfs();
    fs.install();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes its media once, under the same names, for Poe", async () => {
    const make = () => {
      const msg = poeMessage("TWVzc2FnZTox", "bot", 1714557540000000, "pictures");
      const att = (n: number) => ({
        id: `att${n}`,
        isInline: false,
        url: `https://cdn.example/${n}.png`,
        file: { id: `f${n}`, mimeType: "image/png", size: 3, url: `https://cdn.example/${n}.png` },
      });
      msg.attachments = [att(1), att(2)];
      return poeChat([msg]);
    };
    await transformPoeToHaevn(make());
    const first = fs.files("media");
    expect(first).toHaveLength(2);
    await transformPoeToHaevn(make());
    expect(fs.files("media")).toEqual(first);
  });

  it("writes its media once, under the same names, for AI Studio", async () => {
    const make = (stamp: string): AIStudioConversationData => ({
      platform: "aistudio",
      url: "https://aistudio.google.com/prompts/abc",
      conversationId: "ai-1",
      title: "AI Studio",
      extractedAt: stamp,
      messages: [
        {
          role: "assistant",
          content: "picture",
          files: [{ url: "https://cdn.example/x.png", type: "image/png" }],
          timestamp: stamp,
        },
      ],
    });
    await transformAIStudioToHaevn(make("2024-06-01T09:00:00.000Z"));
    const first = fs.files("media");
    expect(first).toHaveLength(1);
    await transformAIStudioToHaevn(make("2024-06-01T19:00:00.000Z"));
    expect(fs.files("media")).toEqual(first);
  });
});
