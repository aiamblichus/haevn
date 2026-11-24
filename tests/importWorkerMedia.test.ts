import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDB } from "../src/services/db";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-90: restoring media from an export writes each file through a stream. When the stream fails
// part-way it is aborted, so it neither stays open nor leaves the file half-written and locked.
// HVN-132: a chat the import does not save keeps its media.

const { zip } = vi.hoisted(() => ({
  zip: {
    manifest: {} as Record<string, unknown>,
    entries: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../src/utils/zipReader", () => ({
  createZipReader: vi.fn(() => ({
    getEntries: async () => zip.entries,
    close: async () => {},
  })),
  readEntryText: vi.fn(async (entry: { text?: string }) =>
    entry.text !== undefined ? entry.text : JSON.stringify(zip.manifest),
  ),
}));
const { saveChat } = vi.hoisted(() => ({ saveChat: vi.fn() }));
vi.mock("../src/services/chatPersistence", () => ({ saveChat }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Posted = { type: string; [key: string]: unknown };
let posted: Posted[] = [];
const workerSelf: {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
} = { postMessage: (message) => posted.push(message) };

beforeAll(async () => {
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/import/import.worker");
});

let fs: FakeOpfs;

beforeEach(async () => {
  fs = new FakeOpfs();
  fs.install();
  posted = [];
  await getDB().chats.clear();
  saveChat.mockReset();
  saveChat.mockImplementation(async (chat: { id: string; source: string }) => ({
    chatId: chat.id,
    source: chat.source,
  }));
});

async function importExport(overwriteExisting = true): Promise<void> {
  await workerSelf.onmessage?.({
    data: {
      type: "start",
      importType: "haevn_export_zip",
      overwriteExisting,
      fileData: { name: "e.zip", type: "", size: 2, data: new ArrayBuffer(2) },
      requestId: "r1",
    },
  });
}

const chatJson = JSON.stringify({
  id: "c1",
  title: "A chat",
  source: "test",
  currentId: "m1",
  messages: { m1: { id: "m1", message: [] } },
});

function exportWith(entry: Record<string, unknown>): void {
  zip.manifest = {
    total_chats: 1,
    chats: [{ id: "c1", file: "chats/c1.json" }],
    media: [
      {
        path: "media/c1/m1_0.png",
        chatId: "c1",
        messageId: "m1",
        partIndex: 0,
        mediaType: "image/png",
        size: 4,
      },
    ],
  };
  zip.entries = [
    { filename: "manifest.json", directory: false },
    { filename: "chats/c1.json", directory: false, text: chatJson },
    { filename: "media/c1/m1_0.png", directory: false, ...entry },
  ];
}

describe("restoring media from an export", () => {
  it("aborts the stream of a file that fails part-way, and goes on", async () => {
    exportWith({
      getData: async (writable: { write: (chunk: unknown) => Promise<void> }) => {
        await writable.write(new Uint8Array([1, 2]));
        throw new Error("corrupt entry");
      },
    });

    await importExport();

    expect(fs.counts.writableAborted).toBe(1);
    expect(fs.counts.writableClosed).toBe(0);
    expect(posted.some((m) => m.type === "failed")).toBe(false);
  });

  it("does not abort a stream the entry closed itself", async () => {
    exportWith({
      getData: async (writable: {
        write: (chunk: unknown) => Promise<void>;
        close: () => Promise<void>;
      }) => {
        await writable.write(new Uint8Array([1, 2, 3, 4]));
        await writable.close();
      },
    });

    await importExport();

    expect(fs.counts.writableAborted).toBe(0);
    expect(fs.counts.writableClosed).toBe(1);
    expect(fs.size("media/c1/m1_0.png")).toBe(4);
  });
});

describe("media of a chat the import skips (HVN-132)", () => {
  const archiveBytes = new Uint8Array([9, 9, 9, 9]);
  const writeArchiveBytes = async (writable: {
    write: (chunk: unknown) => Promise<void>;
    close: () => Promise<void>;
  }) => {
    await writable.write(archiveBytes);
    await writable.close();
  };

  it("leaves the bytes of an existing chat's media alone when overwrite is off", async () => {
    await getDB().chats.put({ id: "c1", source: "test" } as never);
    fs.put("media/c1/m1_0.png", new Uint8Array([1, 2]));
    exportWith({ getData: writeArchiveBytes });

    await importExport(false);

    expect(posted.some((m) => m.type === "skipped" && m.chatId === "c1")).toBe(true);
    expect(saveChat).not.toHaveBeenCalled();
    expect(fs.text("media/c1/m1_0.png")).toBe("\u0001\u0002");
  });

  it("writes the media of a chat it saves", async () => {
    exportWith({ getData: writeArchiveBytes });

    await importExport(false);

    expect(posted.some((m) => m.type === "saved" && m.chatId === "c1")).toBe(true);
    expect(fs.size("media/c1/m1_0.png")).toBe(4);
  });

  it("replaces the media of an existing chat it overwrites", async () => {
    await getDB().chats.put({ id: "c1", source: "test" } as never);
    fs.put("media/c1/m1_0.png", new Uint8Array([1, 2]));
    exportWith({ getData: writeArchiveBytes });

    await importExport(true);

    expect(posted.some((m) => m.type === "saved" && m.chatId === "c1")).toBe(true);
    expect(fs.size("media/c1/m1_0.png")).toBe(4);
  });
});
