import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportSingleChatFile } from "../src/background/export/singleChatExport";
import type { ExportOptions } from "../src/formatters";

// A chat whose messages are still in its row would export as an empty chat (HVN-31). The export
// refuses it instead, naming the chat, and downloads nothing.

const unmovedRefusal = vi.hoisted(() => vi.fn());
const getChatWithMessages = vi.hoisted(() => vi.fn());
const buildTextExportArtifact = vi.hoisted(() => vi.fn());

vi.mock("../src/services/syncService", () => ({
  SyncService: { unmovedRefusal, getChatWithMessages },
}));
vi.mock("../src/background/export/textExportArtifact", () => ({ buildTextExportArtifact }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const download = vi.fn((_options: unknown, callback: (id: number) => void) => callback(1));

beforeEach(() => {
  unmovedRefusal.mockReset();
  unmovedRefusal.mockResolvedValue(undefined);
  getChatWithMessages.mockReset();
  getChatWithMessages.mockResolvedValue({ id: "old", messages: {} });
  buildTextExportArtifact.mockReset();
  buildTextExportArtifact.mockResolvedValue({
    content: "{}",
    filename: "old.json",
    contentType: "application/json",
  });
  download.mockClear();
  vi.stubGlobal("chrome", { downloads: { download }, runtime: { lastError: null } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the single-chat export of a chat whose messages have not moved (HVN-31)", () => {
  it("refuses, naming the chat, and downloads nothing", async () => {
    unmovedRefusal.mockResolvedValue("Chat old cannot be read yet: its messages have not moved.");

    await expect(exportSingleChatFile("old", {} as ExportOptions)).rejects.toThrow(
      "Chat old cannot be read yet",
    );
    expect(getChatWithMessages).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("exports a chat that has moved, as before", async () => {
    const result = await exportSingleChatFile("old", {} as ExportOptions);

    expect(result).toEqual({ filename: "old.json", downloadId: 1 });
    expect(download).toHaveBeenCalledTimes(1);
  });
});
