import { describe, expect, it } from "vitest";
import { countOpenRouterRooms, parseOpenRouterExport } from "../src/providers/openrouter/importer";
import { openrouterProvider } from "../src/providers/openrouter/provider";
import {
  transformOpenRouterExportToHaevnChats,
  transformOpenRouterRoomToHaevnChat,
} from "../src/providers/openrouter/transformer";
import { firstMessageId, makeExport, makeRoom } from "./helpers/openrouterExport";

const ONE_MODEL = { "char-a": "vendor/model-a" };

function simpleRoom(title = "Sorting algorithms") {
  return makeRoom({
    title,
    start: 1_800_000_000,
    characters: ONE_MODEL,
    turns: [
      {
        user: "Explain merge sort.",
        replies: [
          {
            character: "char-a",
            text: "Merge sort splits the list, sorts each half and merges them.",
            reasoning: "The user wants a short explanation.",
            encrypted: true,
            metadata: { generationId: "gen-1", provider: "SomeHost", tokensPerSecond: 42.5 },
          },
        ],
      },
      {
        user: "And quicksort?",
        replies: [{ character: "char-a", text: "Quicksort partitions around a pivot." }],
      },
    ],
  });
}

describe("parseOpenRouterExport", () => {
  it("reads the version and the rooms", () => {
    const parsed = parseOpenRouterExport(JSON.stringify(makeExport([simpleRoom()])));
    expect(parsed.version).toBe("orpg.3.0");
    expect(parsed.rooms).toHaveLength(1);
  });

  it.each([
    ["not json", "{nope"],
    ["not an object", "[1, 2]"],
    ["another format", JSON.stringify({ version: "1", rooms: [] })],
    ["no rooms", JSON.stringify({ version: "orpg.3.0" })],
  ])("refuses a file that is %s", (_label, content) => {
    expect(() => parseOpenRouterExport(content)).toThrow(/OpenRouter/);
  });

  it("counts the rooms that have a message, so an empty room is not a chat", () => {
    const empty = { title: "Empty", messages: {}, items: {} };
    const content = JSON.stringify(makeExport([simpleRoom(), empty]));
    expect(countOpenRouterRooms(content)).toBe(1);
    expect(transformOpenRouterExportToHaevnChats(parseOpenRouterExport(content))).toHaveLength(1);
  });
});

describe("the chat id", () => {
  it("is the id of the room's first message, and survives a new title and later messages", () => {
    const grown = makeRoom({
      title: "First title",
      start: 1_800_000_000,
      characters: ONE_MODEL,
      turns: [
        { user: "One.", replies: [{ character: "char-a", text: "Reply one." }] },
        { user: "Two.", replies: [{ character: "char-a", text: "Reply two." }] },
        { user: "Three.", replies: [{ character: "char-a", text: "Reply three." }] },
      ],
    });
    const first = firstMessageId(grown);
    // The same room as it was one turn ago: its last two messages are not there yet.
    const inOrder = Object.entries(grown.messages ?? {}).sort(([, x], [, y]) =>
      (x.createdAt ?? "").localeCompare(y.createdAt ?? ""),
    );
    const earlier = {
      ...grown,
      title: "A different title",
      messages: Object.fromEntries(inOrder.slice(0, 4)),
    };

    const before = transformOpenRouterRoomToHaevnChat(earlier);
    const after = transformOpenRouterRoomToHaevnChat(grown);
    expect(Object.keys(before.messages)).toHaveLength(4);
    expect(Object.keys(after.messages)).toHaveLength(6);
    expect(before.id).toBe(first);
    expect(after.id).toBe(first);
    expect(after.sourceId).toBe(first);
    expect(after.source).toBe("openrouter");
    expect(before.title).not.toBe(after.title);
  });

  it("differs between rooms", () => {
    const a = simpleRoom();
    const b = makeRoom({
      title: "Another",
      start: 1_800_100_000,
      characters: ONE_MODEL,
      turns: [{ user: "Hi", replies: [{ character: "char-a", text: "Hello" }] }],
    });
    expect(transformOpenRouterRoomToHaevnChat(a).id).not.toBe(
      transformOpenRouterRoomToHaevnChat(b).id,
    );
  });
});

describe("the message tree", () => {
  it("chains the turns, which the file does not link, in the order they were written", () => {
    const room = simpleRoom();
    const chat = transformOpenRouterRoomToHaevnChat(room);
    const ordered = Object.values(chat.messages).sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );

    expect(ordered.map((m) => m.message[0].kind)).toEqual([
      "request",
      "response",
      "request",
      "response",
    ]);
    expect(ordered[0].parentId).toBeUndefined();
    expect(ordered.slice(1).map((m) => m.parentId)).toEqual(ordered.slice(0, 3).map((m) => m.id));
    expect(ordered[0].childrenIds).toEqual([ordered[1].id]);
    expect(chat.currentId).toBe(ordered[3].id);
    for (const message of ordered) expect(message.chatId).toBe(chat.id);
  });

  it("makes the replies of two models siblings, and the next turn follows the later reply", () => {
    const room = makeRoom({
      title: "Two models",
      start: 1_800_200_000,
      characters: { "char-a": "vendor/model-a", "char-b": "vendor/model-b" },
      turns: [
        {
          user: "Compare yourselves.",
          replies: [
            { character: "char-a", text: "A answers." },
            { character: "char-b", text: "B answers." },
          ],
        },
        { user: "Thanks both.", replies: [{ character: "char-a", text: "Welcome." }] },
      ],
    });
    const chat = transformOpenRouterRoomToHaevnChat(room);
    const byTime = Object.values(chat.messages).sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
    const [user1, replyA, replyB, user2, last] = byTime;

    expect(user1.childrenIds).toEqual([replyA.id, replyB.id]);
    expect(replyA.parentId).toBe(user1.id);
    expect(replyB.parentId).toBe(user1.id);
    expect(replyA.childrenIds).toEqual([]);
    expect(replyB.childrenIds).toEqual([user2.id]);
    expect(user2.parentId).toBe(replyB.id);
    expect(chat.currentId).toBe(last.id);
    expect(replyA.model).toBe("vendor/model-a");
    expect(replyB.model).toBe("vendor/model-b");
    expect(chat.models.sort()).toEqual(["vendor/model-a", "vendor/model-b"]);
  });

  it("starts a new root when a parent is missing or sorts after its child", () => {
    const room = simpleRoom();
    const [first, reply] = Object.values(room.messages ?? {}).sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
    // A reply that points at a message the room does not hold becomes a root, which is then
    // chained after the turn before it like any user message.
    (reply as { parentMessageId?: string }).parentMessageId = "msg-gone";
    const chat = transformOpenRouterRoomToHaevnChat(room);
    expect(chat.id).toBe(first.id);
    expect(Object.keys(chat.messages)).toHaveLength(4);
    expect(chat.messages[reply.id].parentId).toBe(first.id);
  });
});

describe("what a message holds", () => {
  const chat = transformOpenRouterRoomToHaevnChat(simpleRoom(), "orpg.3.0");
  const byTime = Object.values(chat.messages).sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );

  it("maps the user's text to a user prompt", () => {
    const request = byTime[0].message[0];
    expect(request).toMatchObject({
      kind: "request",
      parts: [{ part_kind: "user-prompt", content: "Explain merge sort." }],
    });
    expect(byTime[0].model).toBe("");
  });

  it("maps readable reasoning to a thinking part before the text, and leaves out encrypted reasoning", () => {
    const response = byTime[1].message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    expect(response.parts.map((p) => p.part_kind)).toEqual(["thinking", "text"]);
    expect(response.parts[0]).toMatchObject({
      part_kind: "thinking",
      content: "The user wants a short explanation.",
    });
    expect(response.parts[1]).toMatchObject({
      part_kind: "text",
      content: "Merge sort splits the list, sorts each half and merges them.",
    });
  });

  it("takes the model from the message, and the cost, tokens and host with it", () => {
    const message = byTime[1];
    const response = message.message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    expect(message.model).toBe("vendor/model-a");
    expect(response.model_name).toBe("vendor/model-a");
    expect(response.usage).toEqual({ total_tokens: 120, cost: 0.0125, tokens_per_second: 42.5 });
    expect(response.vendor_details).toMatchObject({ provider: "SomeHost", generation_id: "gen-1" });
    expect(message.done).toBe(true);
  });

  it("falls back to the character's model when the message names none", () => {
    const room = makeRoom({
      title: "No variant",
      start: 1_800_300_000,
      characters: ONE_MODEL,
      turns: [
        {
          user: "Hi",
          replies: [{ character: "char-a", text: "Hello", metadata: { variantSlug: undefined } }],
        },
      ],
    });
    const reply = Object.values(room.messages ?? {}).find((m) => m.type === "assistant");
    if (reply?.metadata) delete reply.metadata.variantSlug;
    const result = transformOpenRouterRoomToHaevnChat(room);
    expect(Object.values(result.messages).find((m) => m.model)?.model).toBe("vendor/model-a");
  });

  it("keeps a reply with nothing readable as an empty answer", () => {
    const room = makeRoom({
      title: "Only encrypted",
      start: 1_800_400_000,
      characters: ONE_MODEL,
      turns: [{ user: "Hi", replies: [{ character: "char-a", text: "", encrypted: true }] }],
    });
    const result = transformOpenRouterRoomToHaevnChat(room);
    const reply = Object.values(result.messages).find((m) => m.message[0].kind === "response");
    expect(reply?.message[0]).toMatchObject({ parts: [{ part_kind: "text", content: "" }] });
  });

  it("carries the citations of a reply as urls and in the vendor details", () => {
    const room = makeRoom({
      title: "Sources",
      start: 1_800_500_000,
      characters: ONE_MODEL,
      turns: [
        {
          user: "Find a source.",
          replies: [
            {
              character: "char-a",
              text: "See the page.",
              citations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.test/page",
                    title: "A page",
                    content: "An excerpt.",
                    start_index: 4,
                    end_index: 12,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = transformOpenRouterRoomToHaevnChat(room);
    const reply = Object.values(result.messages).find((m) => m.message[0].kind === "response");
    expect(reply?.citations).toEqual(["https://example.test/page"]);
    const response = reply?.message[0];
    if (response?.kind !== "response") throw new Error("expected a response");
    expect(response.vendor_details?.citations).toEqual([
      {
        url: "https://example.test/page",
        title: "A page",
        content: "An excerpt.",
        start_index: 4,
        end_index: 12,
      },
    ]);
  });
});

describe("what a chat holds", () => {
  it("takes its title, models, times and characters from the room", () => {
    const chat = transformOpenRouterRoomToHaevnChat(simpleRoom("Sorting algorithms"), "orpg.3.0");
    expect(chat.title).toBe("Sorting algorithms");
    expect(chat.models).toEqual(["vendor/model-a"]);
    expect(chat.timestamp).toBe(1_800_000_000 * 1000);
    expect(chat.providerLastModifiedTimestamp).toBe((1_800_000_000 + 600 + 60 + 5) * 1000);
    expect(chat.params).toMatchObject({
      exportVersion: "orpg.3.0",
      characters: [
        { id: "char-a", model: "vendor/model-a", samplingParameters: { temperature: 0.7 } },
      ],
    });
    expect(chat.params).not.toHaveProperty("artifacts");
  });

  it("titles an untitled room by its first line", () => {
    const room = { ...simpleRoom(), title: "  " };
    expect(transformOpenRouterRoomToHaevnChat(room).title).toBe("Explain merge sort.");
  });

  it("archives artifacts untouched when a room has any", () => {
    const room = { ...simpleRoom(), artifacts: { art1: { name: "notes" } } };
    expect(transformOpenRouterRoomToHaevnChat(room).params.artifacts).toEqual({
      artifacts: { art1: { name: "notes" } },
    });
  });

  it("is the same chat when transformed twice", () => {
    const room = simpleRoom();
    const a = transformOpenRouterRoomToHaevnChat(room);
    const b = transformOpenRouterRoomToHaevnChat(room);
    expect({ ...a, lastSyncedTimestamp: 0 }).toEqual({ ...b, lastSyncedTimestamp: 0 });
  });

  it("is what the provider's importer and transformer produce", async () => {
    const content = JSON.stringify(makeExport([simpleRoom(), simpleRoom("Second")]));
    expect(openrouterProvider.importer?.canImport(content)).toBe(true);
    expect(openrouterProvider.importer?.canImport("{}")).toBe(false);
    const chats = await openrouterProvider.importer?.importFromBackup(content);
    expect(chats).toHaveLength(2);
    expect(openrouterProvider.importOnly).toBe(true);
  });
});
