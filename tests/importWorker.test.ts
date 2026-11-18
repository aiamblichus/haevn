import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { parseClaudeCodeJsonl } from "../src/providers/claudecode/importer";
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

describe("a second import start while a job runs or is paused (HVN-55)", () => {
  const REFUSED = "An import is already running in the worker.";

  function startMessage(
    requestId: string,
    importType = "claudecode_jsonl",
  ): Record<string, unknown> {
    return {
      type: "start",
      importType,
      overwriteExisting: true,
      fileData: { name: "s.jsonl", type: "", size: 2, data: new TextEncoder().encode("{}").buffer },
      requestId,
    };
  }

  function send(message: Record<string, unknown>): Promise<void> {
    if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
    return workerSelf.onmessage({ data: message });
  }

  /** Holds the first job inside its first save until the returned function is called. */
  function holdFirstSave(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    saveChat.mockImplementationOnce(async (chat: Chat) => {
      await gate;
      return { chatId: chat.id, source: chat.source };
    });
    return release;
  }

  it("refuses it, and the running job finishes on its own", async () => {
    carried.chat = chatCarryingMetadata("h1");
    vi.mocked(parseClaudeCodeJsonl).mockClear();
    const release = holdFirstSave();

    const first = send(startMessage("r1"));
    await vi.waitFor(() => expect(saveChat).toHaveBeenCalledTimes(1));
    posted = [];

    await send(startMessage("r2"));

    expect(posted).toEqual([{ type: "error", error: REFUSED, requestId: "r2" }]);
    expect(vi.mocked(parseClaudeCodeJsonl)).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "complete", requestId: "r1", saved: 1 }),
    );
  });

  it("refuses it while the running job is paused, and the job still cancels", async () => {
    carried.chat = chatCarryingMetadata("h2");
    const release = holdFirstSave();
    const first = send(startMessage("r1"));
    await vi.waitFor(() => expect(saveChat).toHaveBeenCalledTimes(1));

    posted = [];
    await send({ type: "pause", requestId: "p1" });
    expect(posted).toEqual([{ type: "paused", requestId: "p1" }]);

    posted = [];
    await send(startMessage("r2"));
    expect(posted).toEqual([{ type: "error", error: REFUSED, requestId: "r2" }]);

    await send({ type: "cancel", requestId: "c1" });
    release();
    await first;
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled", requestId: "r1" }));
  });

  it("accepts a start once the job has completed", async () => {
    carried.chat = chatCarryingMetadata("h3");
    await runImport(true);
    posted = [];

    carried.chat = chatCarryingMetadata("h4");
    await send(startMessage("r2"));

    expect(posted.some((m) => m.type === "error")).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("accepts a start once the job has failed", async () => {
    await send(startMessage("r1", "not_a_source"));
    expect(posted).toContainEqual(expect.objectContaining({ type: "error", requestId: "r1" }));

    posted = [];
    carried.chat = chatCarryingMetadata("h5");
    await send(startMessage("r2"));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("refuses a start during a cancel's wind-down, and the cancelled job still reports cancelled", async () => {
    carried.chat = chatCarryingMetadata("h8");
    vi.mocked(parseClaudeCodeJsonl).mockClear();
    const release = holdFirstSave();
    const first = send(startMessage("r1"));
    await vi.waitFor(() => expect(saveChat).toHaveBeenCalledTimes(1));

    // The cancel sets the status, but the job still owns workerState until it has finished.
    await send({ type: "cancel" });
    posted = [];
    await send(startMessage("r2"));

    expect(posted).toEqual([{ type: "error", error: REFUSED, requestId: "r2" }]);
    expect(vi.mocked(parseClaudeCodeJsonl)).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled", requestId: "r1" }));
    expect(posted.some((m) => m.type === "complete")).toBe(false);
  });

  it("accepts a start once the job has been cancelled", async () => {
    carried.chat = chatCarryingMetadata("h6");
    const release = holdFirstSave();
    const first = send(startMessage("r1"));
    await vi.waitFor(() => expect(saveChat).toHaveBeenCalledTimes(1));

    await send({ type: "cancel" });
    release();
    await first;
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled", requestId: "r1" }));

    posted = [];
    carried.chat = chatCarryingMetadata("h7");
    await send(startMessage("r2"));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });
});
