import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";

// The import worker saves chats through `ChatPersistence` and posts what it did; the parsers
// are not under test here, so a Claude Code import hands it a chat that carries metadata.
const { saveChat, carried } = vi.hoisted(() => ({
  saveChat: vi.fn(),
  carried: { chat: undefined as unknown as Chat },
}));

vi.mock("../src/services/chatPersistence", () => ({ saveChat }));
vi.mock("../src/providers/claudecode/importer", () => ({
  parseClaudeCodeJsonl: vi.fn(async () => ({})),
}));
vi.mock("../src/providers/claudecode/transformer", () => ({
  transformToHaevnChat: vi.fn(() => carried.chat),
}));
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

// Imported once, so that the worker and the test share one database object: a spy on it then
// reaches the worker's own calls.
beforeAll(async () => {
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/import/import.worker");
});

async function runImport(overwriteExisting: boolean): Promise<void> {
  posted = [];
  await workerSelf.onmessage?.({
    data: {
      type: "start",
      importType: "claudecode_jsonl",
      overwriteExisting,
      fileData: { name: "s.jsonl", type: "", size: 2, data: new TextEncoder().encode("{}").buffer },
      requestId: "r1",
    },
  });
}

function chatCarryingMetadata(id: string): Chat {
  return {
    id,
    source: "claudecode",
    haevnMetadata: { title: "Carried title", keywords: ["k"] },
  } as unknown as Chat;
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.chatMetadata.clear()]);
  saveChat.mockReset();
  saveChat.mockImplementation(async (chat: Chat) => ({ chatId: chat.id, source: chat.source }));
});

describe("the import job's worker seeds metadata the way ImportService does (HVN-53)", () => {
  it("writes the carried haevnMetadata as a manual record for a new chat", async () => {
    carried.chat = chatCarryingMetadata("w1");

    await runImport(true);

    expect(posted.some((m) => m.type === "saved")).toBe(true);
    expect(await MetadataRepository.get("w1")).toMatchObject({
      title: "Carried title",
      keywords: ["k"],
      source: "manual",
    });
  });

  it("never replaces a record the archive already has", async () => {
    await MetadataRepository.set("w2", { title: "Mine", source: "manual" });
    carried.chat = chatCarryingMetadata("w2");

    await runImport(true);

    expect(await MetadataRepository.get("w2")).toMatchObject({ title: "Mine" });
  });

  it("does not seed a chat that was already in the archive and is overwritten", async () => {
    await getDB().chats.put(chatCarryingMetadata("w3"));
    carried.chat = chatCarryingMetadata("w3");

    await runImport(true);

    expect(posted.some((m) => m.type === "saved")).toBe(true);
    expect(await MetadataRepository.get("w3")).toBeNull();
  });

  it("saves and announces the chat when the seeding fails", async () => {
    carried.chat = chatCarryingMetadata("w4");
    // Reading the existing record is the first thing the seeding does.
    const get = vi.spyOn(getDB().chatMetadata, "get").mockRejectedValue(new Error("db closed"));

    try {
      await runImport(true);
    } finally {
      get.mockRestore();
    }

    expect(posted.map((m) => m.type)).toEqual(expect.arrayContaining(["saved", "postProcess"]));
    expect(posted.some((m) => m.type === "failed")).toBe(false);
  });
});
