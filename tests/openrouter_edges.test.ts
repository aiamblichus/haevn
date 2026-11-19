import { describe, expect, it } from "vitest";
import { transformOpenRouterRoomToHaevnChat } from "../src/providers/openrouter/transformer";
import { makeRoom } from "./helpers/openrouterExport";

// What a real export leaves out or says in another way than the usual one.
function oneTurnRoom() {
  return makeRoom({
    title: "Edge",
    start: 1_800_600_000,
    characters: { "char-a": "vendor/model-a" },
    turns: [{ user: "Hi", replies: [{ character: "char-a", text: "Hello" }] }],
  });
}

function messagesOf(room: ReturnType<typeof oneTurnRoom>) {
  return Object.values(room.messages ?? {}).sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  );
}

describe("OpenRouter rooms with an unusual message", () => {
  it("makes a reply that sorts before its parent a root, not its child", () => {
    const room = oneTurnRoom();
    const [user, reply] = messagesOf(room);
    reply.createdAt = new Date(new Date(user.createdAt ?? "").getTime() - 1000).toISOString();

    const chat = transformOpenRouterRoomToHaevnChat(room);

    // The reply is now the earliest message and the chat's first; the user message follows it.
    expect(chat.id).toBe(reply.id);
    expect(chat.messages[reply.id].parentId).toBeUndefined();
    expect(chat.messages[user.id].parentId).toBe(reply.id);
  });

  it("reads a citation from the text's annotations when the message lists none", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    const data = Object.values(room.items ?? {}).find((i) => i.messageId === reply.id)?.data;
    if (!data?.content) throw new Error("fixture has no content");
    data.content[0].annotations = [
      {
        type: "url_citation",
        url: "https://example.test/a",
        title: "A",
        start_index: 0,
        end_index: 2,
      },
    ];

    const chat = transformOpenRouterRoomToHaevnChat(room);
    expect(chat.messages[reply.id].citations).toEqual(["https://example.test/a"]);
  });

  it("reads a reasoning summary when the item has no reasoning text", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    room.items = {
      ...room.items,
      rs_summary: {
        id: "rs_summary",
        messageId: reply.id,
        data: { type: "reasoning", summary: [{ text: "A summary." }] },
      },
    };
    reply.items = [{ id: "rs_summary", type: "reasoning" }, ...(reply.items ?? [])];

    const response = transformOpenRouterRoomToHaevnChat(room).messages[reply.id].message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    expect(response.parts[0]).toMatchObject({ part_kind: "thinking", content: "A summary." });
  });

  it("names the host that answered from the router's selected endpoint", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.metadata = {
      ...reply.metadata,
      routerMetadata: {
        region: "eu",
        endpoints: {
          available: [
            { provider: "HostA", selected: false },
            { provider: "HostB", selected: true },
          ],
        },
      },
    };

    const response = transformOpenRouterRoomToHaevnChat(room).messages[reply.id].message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    expect(response.vendor_details).toMatchObject({ provider: "HostB", region: "eu" });
  });

  it("takes the model a reply ran on, which may differ from its character's", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.metadata = { ...reply.metadata, variantSlug: "vendor/model-a:variant" };

    const chat = transformOpenRouterRoomToHaevnChat(room);
    expect(chat.messages[reply.id].model).toBe("vendor/model-a:variant");
    expect(chat.models).toEqual(["vendor/model-a:variant", "vendor/model-a"]);
  });

  it("keeps the user message first when it and its reply have the same time, whatever the key order", () => {
    // Three real rooms have a message and its reply at the same millisecond.
    const base = oneTurnRoom();
    const [original, answer] = messagesOf(base);
    // The reply's id sorts before the user message's, so only the kind can keep it second.
    const user = { ...original, id: "z-user" };
    const reply = {
      ...answer,
      id: "a-reply",
      parentMessageId: user.id,
      createdAt: original.createdAt,
    };
    const forward = { ...base, messages: { [user.id]: user, [reply.id]: reply } };
    const reversed = { ...base, messages: { [reply.id]: reply, [user.id]: user } };

    for (const room of [forward, reversed]) {
      const chat = transformOpenRouterRoomToHaevnChat(room);
      expect(chat.id).toBe(user.id);
      expect(chat.messages[user.id].parentId).toBeUndefined();
      expect(chat.messages[reply.id].parentId).toBe(user.id);
      expect(chat.currentId).toBe(reply.id);
    }
  });

  it("orders messages of the same time and kind by id, so the order of the keys does not matter", () => {
    const room = makeRoom({
      title: "Two models",
      start: 1_800_800_000,
      characters: { "char-a": "vendor/model-a", "char-b": "vendor/model-b" },
      turns: [
        {
          user: "Hi",
          replies: [
            { character: "char-a", text: "A." },
            { character: "char-b", text: "B." },
          ],
        },
      ],
    });
    const [user, first, second] = messagesOf(room);
    second.createdAt = first.createdAt;
    const reversed = {
      ...room,
      messages: { [second.id]: second, [first.id]: first, [user.id]: user },
    };

    const a = transformOpenRouterRoomToHaevnChat(room);
    const b = transformOpenRouterRoomToHaevnChat(reversed);
    // The lower id comes first, in either key order.
    const lowerFirst = [first.id, second.id].sort();
    expect(a.messages[user.id].childrenIds).toEqual(lowerFirst);
    expect(b.messages[user.id].childrenIds).toEqual(lowerFirst);
    expect(b.currentId).toBe(a.currentId);
  });

  it("prefers the variant a reply ran on over the model that was requested", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.metadata = {
      ...reply.metadata,
      variantSlug: "vendor/model-a:variant",
      requestedModel: "vendor/model-requested",
    };
    expect(transformOpenRouterRoomToHaevnChat(room).messages[reply.id].model).toBe(
      "vendor/model-a:variant",
    );
  });

  it("falls back to the requested model when the message has no variant", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.metadata = { ...reply.metadata, variantSlug: undefined, requestedModel: "vendor/asked" };
    expect(transformOpenRouterRoomToHaevnChat(room).messages[reply.id].model).toBe("vendor/asked");
  });

  it("reads annotations only when the message lists no citations", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.citations = [
      { type: "url_citation", url_citation: { url: "https://example.test/listed" } },
    ];
    const data = Object.values(room.items ?? {}).find((i) => i.messageId === reply.id)?.data;
    if (!data?.content) throw new Error("fixture has no content");
    data.content[0].annotations = [{ type: "url_citation", url: "https://example.test/annotated" }];

    expect(transformOpenRouterRoomToHaevnChat(room).messages[reply.id].citations).toEqual([
      "https://example.test/listed",
    ]);
  });

  it("marks a reply that was still generating as not done", () => {
    const room = oneTurnRoom();
    const [, reply] = messagesOf(room);
    reply.isGenerating = true;
    expect(transformOpenRouterRoomToHaevnChat(room).messages[reply.id].done).toBe(false);
  });

  it("archives attachments, files and images it has no shape for", () => {
    const room = oneTurnRoom();
    const [user, reply] = messagesOf(room);
    user.attachments = [{ name: "notes.txt" }];
    reply.images = [{ url: "https://example.test/i.png" }];

    expect(transformOpenRouterRoomToHaevnChat(room).params.unmappedMessageData).toEqual({
      [user.id]: { attachments: [{ name: "notes.txt" }] },
      [reply.id]: { images: [{ url: "https://example.test/i.png" }] },
    });
  });
});
