import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/model/haevn_model";
import type { OpenRouterRoom } from "../src/providers/openrouter/model";
import { getDB } from "../src/services/db";
import { makeExport, makeRoom } from "./helpers/openrouterExport";

// The real import worker, saving into fake-indexeddb: what an import of an OpenRouter export
// leaves in the archive, and what a second import of the same file does to it.
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Posted = { type: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
const workerSelf: WorkerGlobal = { postMessage: (message) => posted.push(message) };

beforeAll(async () => {
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/import/import.worker");
});

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.chatMessages.clear(), db.chatMetadata.clear()]);
});

async function runImport(content: string, overwriteExisting: boolean): Promise<Posted[]> {
  posted = [];
  const data = new TextEncoder().encode(content).buffer;
  await workerSelf.onmessage?.({
    data: {
      type: "start",
      importType: "openrouter_json",
      overwriteExisting,
      fileData: { name: "chats.json", type: "application/json", size: data.byteLength, data },
      requestId: "r1",
    },
  });
  return posted;
}

/** A room of two turns, and `more` further turns. The same start gives the same message ids. */
function room(title: string, start: number, answer: string, more = 0): OpenRouterRoom {
  const turns = [
    {
      user: "A question.",
      replies: [{ character: "char-a", text: answer, reasoning: "Thinking." }],
    },
    { user: "A follow-up.", replies: [{ character: "char-a", text: `${answer} More.` }] },
  ];
  for (let i = 0; i < more; i++) {
    turns.push({ user: `Turn ${i + 3}.`, replies: [{ character: "char-a", text: "Later." }] });
  }
  return makeRoom({ title, start, characters: { "char-a": "vendor/model-a" }, turns });
}

function textsOf(messages: ChatMessage[]) {
  return messages
    .flatMap((m) =>
      m.message.flatMap((x) => x.parts.map((p) => (p as { content?: unknown }).content)),
    )
    .filter((c): c is string => typeof c === "string");
}

describe("importing an OpenRouter export", () => {
  const rooms = [
    room("One", 1_800_000_000, "Answer one."),
    room("Two", 1_800_100_000, "Answer two."),
  ];

  it("saves one chat per room, with its messages", async () => {
    const events = await runImport(JSON.stringify(makeExport(rooms)), true);

    expect(events.filter((e) => e.type === "saved")).toHaveLength(2);
    expect(events.filter((e) => e.type === "postProcess")).toHaveLength(2);
    expect(events.some((e) => e.type === "failed")).toBe(false);
    // The job counts the file's chats, not the file.
    const last = events.filter((e) => e.type === "progress").at(-1);
    expect(last).toMatchObject({ processed: 2, total: 2, phase: "chats" });

    const chats = await getDB().chats.toArray();
    expect(chats.map((c) => [c.title, c.source]).sort()).toEqual([
      ["One", "openrouter"],
      ["Two", "openrouter"],
    ]);
    expect(await getDB().chatMessages.count()).toBe(8);
  });

  it("replaces the earlier copy of each chat when the same export comes again", async () => {
    await runImport(JSON.stringify(makeExport(rooms)), true);
    const first = await getDB().chats.toArray();

    const events = await runImport(JSON.stringify(makeExport(rooms)), true);

    const second = await getDB().chats.toArray();
    expect(second).toHaveLength(2);
    expect(second.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    expect(await getDB().chatMessages.count()).toBe(8);
    expect(events.filter((e) => e.type === "saved")).toHaveLength(2);
    expect(events.filter((e) => e.type === "postProcess").every((e) => e.isNewChat === false)).toBe(
      true,
    );
  });

  it("holds the second import's content when the room was renamed and has grown", async () => {
    await runImport(JSON.stringify(makeExport(rooms)), true);
    const [chatOne] = (await getDB().chats.toArray()).filter((c) => c.title === "One");

    // The same room later: renamed, its first answer rewritten, and one more turn.
    const later = room("One, renamed", 1_800_000_000, "Rewritten answer.", 1);
    await runImport(JSON.stringify(makeExport([later, rooms[1]])), true);

    const chats = await getDB().chats.toArray();
    expect(chats).toHaveLength(2);
    expect(chats.find((c) => c.id === chatOne.id)?.title).toBe("One, renamed");
    const messages = await getDB()
      .chatMessages.where("chatId")
      .equals(chatOne.id as string)
      .toArray();
    expect(messages).toHaveLength(6);
    expect(textsOf(messages)).toContain("Rewritten answer.");
    expect(textsOf(messages)).not.toContain("Answer one.");
  });

  it("leaves the archive as it was when overwriting is off", async () => {
    await runImport(JSON.stringify(makeExport(rooms)), true);

    const events = await runImport(
      JSON.stringify(makeExport([room("Changed", 1_800_000_000, "Changed answer.")])),
      false,
    );

    expect(events.filter((e) => e.type === "skipped")).toHaveLength(1);
    expect(events.some((e) => e.type === "saved")).toBe(false);
    const chats = await getDB().chats.toArray();
    expect(chats.map((c) => c.title).sort()).toEqual(["One", "Two"]);
  });

  it("saves nothing for a file that is not an OpenRouter export", async () => {
    const events = await runImport(JSON.stringify({ version: "1", rooms: [] }), true);

    expect(events.some((e) => e.type === "saved")).toBe(false);
    expect(await getDB().chats.count()).toBe(0);
    expect(events.map((e) => e.type)).toContain("error");
  });
});
