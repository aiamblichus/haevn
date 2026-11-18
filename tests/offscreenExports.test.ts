import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The offscreen document answers OPFS requests with the export-staging functions; they are
// tested on their own (exportStaging.test.ts), so here they are spies.
const staging = vi.hoisted(() => ({
  deleteExportDirectory: vi.fn(),
  sweepStaleExports: vi.fn(),
}));
vi.mock("../src/services/exportStaging", () => staging);

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;
let listener: Listener;

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (fn: Listener) => {
          listener = fn;
        },
      },
      sendMessage: async () => undefined,
      getURL: (path: string) => path,
    },
  });
  await import("../src/offscreen/offscreen");
});

beforeEach(() => {
  staging.deleteExportDirectory.mockReset();
  staging.sweepStaleExports.mockReset();
});

/** Sends the offscreen document a message, and resolves with what it answers. */
function ask(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const answersLater = listener(message, {}, resolve);
    // A handler that answers later says so by returning true; one that does not never answers.
    if (!answersLater) resolve("no answer");
  });
}

describe("the offscreen document's export requests (HVN-62)", () => {
  it("deleteExport deletes that export's directory", async () => {
    staging.deleteExportDirectory.mockResolvedValue(true);

    expect(await ask({ type: "deleteExport", exportId: "e1" })).toEqual({ success: true });
    expect(staging.deleteExportDirectory).toHaveBeenCalledWith("e1");
  });

  it("deleteExport answers with the error when the id is refused", async () => {
    staging.deleteExportDirectory.mockRejectedValue(new Error("Invalid export id"));

    expect(await ask({ type: "deleteExport", exportId: "" })).toEqual({
      success: false,
      error: "Invalid export id",
    });
  });

  it("sweepExports sweeps with the id it must keep, and answers with the ids it deleted", async () => {
    staging.sweepStaleExports.mockResolvedValue(["old"]);

    expect(await ask({ type: "sweepExports", keepExportId: "running" })).toEqual({
      success: true,
      result: ["old"],
    });
    expect(staging.sweepStaleExports).toHaveBeenCalledWith({ keepExportId: "running" });
  });
});
