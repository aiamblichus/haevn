import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuardedTransform } from "./helpers/guardedTransform";
import { makeRoom } from "./helpers/openrouterExport";

// No input may make the transform run forever: a hand-edited or damaged file must give a chat or
// an error. Each case runs in a child process with a time limit, so a loop fails the test.
let guarded: ReturnType<typeof createGuardedTransform>;
beforeAll(() => {
  guarded = createGuardedTransform(10_000);
});
afterAll(() => guarded.dispose());

function twoTurnRoom() {
  return makeRoom({
    title: "Malformed",
    start: 1_800_700_000,
    characters: { "char-a": "vendor/model-a" },
    turns: [
      { user: "One.", replies: [{ character: "char-a", text: "Reply one." }] },
      { user: "Two.", replies: [{ character: "char-a", text: "Reply two." }] },
    ],
  });
}

const sortedKeys = (room: ReturnType<typeof twoTurnRoom>) =>
  Object.entries(room.messages ?? {})
    .sort(([, a], [, b]) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .map(([key]) => key);

describe("a malformed OpenRouter room still finishes", () => {
  it("gives a chat for a room whose messages are fine (the control)", () => {
    const result = guarded.run(twoTurnRoom());
    expect(result.hung).toBe(false);
    expect(result.chat?.messages).toHaveLength(4);
  });

  it("finishes when two messages carry the same id field", () => {
    const room = twoTurnRoom();
    const keys = sortedKeys(room);
    // The third message claims the id of the first.
    (room.messages ?? {})[keys[2]].id = keys[0];

    const result = guarded.run(room);

    expect(result.hung).toBe(false);
    // Every entry of the map is a message of the chat, known by its key.
    expect(result.chat?.messages.map((m) => m.id).sort()).toEqual([...keys].sort());
    expect(result.chat?.id).toBe(keys[0]);
  });

  it("finishes when a message is its own parent, and does not make it a child of itself", () => {
    const room = twoTurnRoom();
    const keys = sortedKeys(room);
    (room.messages ?? {})[keys[1]].parentMessageId = keys[1];

    const result = guarded.run(room);

    expect(result.hung).toBe(false);
    expect(result.chat?.messages).toHaveLength(4);
    const own = result.chat?.messages.find((m) => m.id === keys[1]);
    expect(own?.parentId).not.toBe(keys[1]);
    expect(own?.childrenIds).not.toContain(keys[1]);
  });

  it("finishes when two messages are each other's parent", () => {
    const room = twoTurnRoom();
    const keys = sortedKeys(room);
    const messages = room.messages ?? {};
    messages[keys[0]].parentMessageId = keys[1];
    messages[keys[1]].parentMessageId = keys[0];

    const result = guarded.run(room);

    expect(result.hung).toBe(false);
    expect(result.chat?.messages).toHaveLength(4);
  });
});
