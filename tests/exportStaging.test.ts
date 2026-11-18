import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExportZipPath,
  deleteExportDirectory,
  STALE_EXPORT_MAX_AGE_MS,
  sweepStaleExports,
} from "../src/services/exportStaging";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// OPFS as a map from file path to its modification time, plus the directories that hold no file.
// A path is a directory when another path or directory starts with `path/`.
const opfs = vi.hoisted(() => ({
  files: new Map<string, number>(),
  emptyDirs: new Set<string>(),
  /** Paths whose deletion fails, as a directory with a file held open does. */
  locked: new Set<string>(),
}));
vi.mock("../src/utils/opfs", () => {
  const under = (dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    return [...opfs.files.keys(), ...opfs.emptyDirs]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  };
  return {
    ensureDirectory: async () => undefined,
    listFiles: async (dir: string) => under(dir).filter((rest) => !rest.includes("/")),
    listDirectories: async (dir: string) => [
      ...new Set(
        under(dir)
          .filter((rest) => rest.includes("/") || opfs.emptyDirs.has(dir ? `${dir}/${rest}` : rest))
          .map((rest) => rest.split("/")[0]),
      ),
    ],
    getFileMetadata: async (path: string) =>
      opfs.files.has(path) ? { size: 1, lastModified: opfs.files.get(path) as number } : null,
    deleteDirectory: async (dir: string) => {
      if (opfs.locked.has(dir)) return false;
      const prefix = `${dir}/`;
      const gone = [...opfs.files.keys(), ...opfs.emptyDirs].filter(
        (path) => path === dir || path.startsWith(prefix),
      );
      for (const path of gone) {
        opfs.files.delete(path);
        opfs.emptyDirs.delete(path);
      }
      return gone.length > 0;
    },
  };
});

const NOW = Date.UTC(2026, 10, 18, 12);
const HOUR = 60 * 60 * 1000;
const DAY = STALE_EXPORT_MAX_AGE_MS;

/** A finished export: staging with a chat and a media file, and the ZIP, all written at `at`. */
function seedExport(exportId: string, at: number): void {
  opfs.files.set(`exports/${exportId}/staging/chats/c1.json`, at);
  opfs.files.set(`exports/${exportId}/staging/media/c1/0.png`, at);
  opfs.files.set(`exports/${exportId}/staging/manifest.json`, at);
  opfs.files.set(buildExportZipPath(exportId), at);
}

function exportIds(): string[] {
  return [
    ...new Set(
      [...opfs.files.keys(), ...opfs.emptyDirs]
        .filter((path) => path.startsWith("exports/"))
        .map((path) => path.split("/")[1]),
    ),
  ].sort();
}

beforeEach(() => {
  opfs.files.clear();
  opfs.emptyDirs.clear();
  opfs.locked.clear();
});

describe("deleteExportDirectory (HVN-62)", () => {
  it("deletes the staging tree and the ZIP of that export, and nothing of another", async () => {
    seedExport("e1", NOW);
    seedExport("e10", NOW);
    opfs.files.set("media/chat1/a.png", NOW);

    expect(await deleteExportDirectory("e1")).toBe(true);

    expect(exportIds()).toEqual(["e10"]);
    expect(opfs.files.has("media/chat1/a.png")).toBe(true);
  });

  it("is false for an export that is already gone", async () => {
    expect(await deleteExportDirectory("e1")).toBe(false);
  });

  it("is false, and leaves the files, when one is held open by a job still writing", async () => {
    seedExport("e1", NOW);
    opfs.locked.add("exports/e1");

    expect(await deleteExportDirectory("e1")).toBe(false);
    expect(exportIds()).toEqual(["e1"]);
  });

  it.each(["", ".", "..", "a/b", "../media", "a\\b"])("refuses the id %j", async (exportId) => {
    seedExport("e1", NOW);
    opfs.files.set("media/chat1/a.png", NOW);

    await expect(deleteExportDirectory(exportId)).rejects.toThrow("Invalid export id");

    expect(exportIds()).toEqual(["e1"]);
    expect(opfs.files.has("media/chat1/a.png")).toBe(true);
  });
});

describe("sweepStaleExports (HVN-62)", () => {
  it("deletes an export no file of which was written for a day, and keeps a fresher one", async () => {
    seedExport("old", NOW - DAY - HOUR);
    seedExport("fresh", NOW - DAY + HOUR);

    const swept = await sweepStaleExports({ now: NOW });

    expect(swept).toEqual(["old"]);
    expect(exportIds()).toEqual(["fresh"]);
  });

  it("keeps an export that is old in most files but written to a minute ago, in any depth", async () => {
    seedExport("busy", NOW - 3 * DAY);
    opfs.files.set("exports/busy/staging/media/c9/7.png", NOW - 60_000);
    seedExport("busy-zip", NOW - 3 * DAY);
    opfs.files.set(buildExportZipPath("busy-zip"), NOW - 60_000);

    expect(await sweepStaleExports({ now: NOW })).toEqual([]);
    expect(exportIds()).toEqual(["busy", "busy-zip"]);
  });

  it("never deletes the export a job owns, however old", async () => {
    seedExport("running", NOW - 5 * DAY);
    seedExport("orphan", NOW - 5 * DAY);

    const swept = await sweepStaleExports({ keepExportId: "running", now: NOW });

    expect(swept).toEqual(["orphan"]);
    expect(exportIds()).toEqual(["running"]);
  });

  it("deletes a directory with no file in it", async () => {
    opfs.emptyDirs.add("exports/hollow/staging/chats");

    expect(await sweepStaleExports({ now: NOW })).toEqual(["hollow"]);
    expect(exportIds()).toEqual([]);
  });

  it("leaves every other directory of OPFS alone", async () => {
    seedExport("old", NOW - 5 * DAY);
    opfs.files.set("media/chat1/a.png", NOW - 5 * DAY);
    opfs.files.set("import-staging/1-x.zip", NOW - 5 * DAY);

    await sweepStaleExports({ now: NOW });

    expect(opfs.files.has("media/chat1/a.png")).toBe(true);
    expect(opfs.files.has("import-staging/1-x.zip")).toBe(true);
  });

  it("does not report an export it could not delete, and goes on to the next", async () => {
    seedExport("held", NOW - 5 * DAY);
    seedExport("orphan", NOW - 5 * DAY);
    opfs.locked.add("exports/held");

    expect(await sweepStaleExports({ now: NOW })).toEqual(["orphan"]);
    expect(exportIds()).toEqual(["held"]);
  });

  it("does nothing when there is no exports directory", async () => {
    expect(await sweepStaleExports({ now: NOW })).toEqual([]);
  });
});
