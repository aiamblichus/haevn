import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-90: restoring media from an export writes each file through a stream. When the stream fails
// part-way it is aborted, so it neither stays open nor leaves the file half-written and locked.

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
  readEntryText: vi.fn(async () => JSON.stringify(zip.manifest)),
}));
vi.mock("../src/services/chatPersistence", () => ({ saveChat: vi.fn() }));
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

beforeEach(() => {
  fs = new FakeOpfs();
  fs.install();
  posted = [];
});

async function importExport(): Promise<void> {
  await workerSelf.onmessage?.({
    data: {
      type: "start",
      importType: "haevn_export_zip",
      overwriteExisting: true,
      fileData: { name: "e.zip", type: "", size: 2, data: new ArrayBuffer(2) },
      requestId: "r1",
    },
  });
}

function exportWith(entry: Record<string, unknown>): void {
  zip.manifest = {
    total_chats: 0,
    chats: [],
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
