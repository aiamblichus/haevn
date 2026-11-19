import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runProviderHealth } from "../src/background/health/providerHealth";
import { getDB } from "../src/services/db";
import { deps, FakeProbe, idsFor } from "./helpers/healthProbe";
import { mediaWorld, WITH_MEDIA } from "./helpers/mediaSpies";

// DECISION 3 of /project/haevn/decisions/2026-11-19-provider-health-decisions: the check is
// strictly read-only. No save, no queue, no index, no media. These tests show it three ways: the
// transformers fetch and write nothing when told to skip media (and the same spies see them do it
// when not told, so the spies can see); a whole run leaves the archive, OPFS and storage as it
// found them, with an archived chat of the same id sitting there to be overwritten; and the
// health code cannot reach a writer, by its imports.

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const world = mediaWorld();
const touches = () => world.touches();

describe("a whole run leaves the archive as it found it", () => {
  it("writes nothing to the database, OPFS, storage or the network, and keeps an archived chat", async () => {
    const db = getDB();
    // the archive already holds a chat that a sync of the same chat would overwrite
    const archivedId = idsFor("claude")[0];
    const archived = { id: archivedId, source: "claude", title: "ARCHIVED, DO NOT OVERWRITE" };
    await db.chats.put(archived as never);
    world.fs.put("media/some-chat/m1_0.png", "bytes");
    const snapshot = async () =>
      JSON.stringify(await Promise.all(db.tables.map(async (t) => [t.name, await t.toArray()])));
    const dbBefore = await snapshot();
    const filesBefore = world.fs.files();
    world.getDirectory.mockClear();

    const setItems = vi.spyOn(
      (globalThis as unknown as { chrome: { storage: { local: { set: () => Promise<void> } } } })
        .chrome.storage.local,
      "set",
    );

    // every provider's chats carry an image, so a transform that stored media would show
    const probe = new FakeProbe();
    for (const name of Object.keys(WITH_MEDIA)) {
      probe.script(name, (s) => {
        for (const id of idsFor(name)) {
          (s.chats as Record<string, unknown>)[id] = { success: true, data: WITH_MEDIA[name]() };
        }
      });
    }
    const report = await runProviderHealth({}, deps(probe));

    // it ran for real: nine rows, the chats were checked
    expect(report.rows).toHaveLength(9);
    expect(report.rows.filter((r) => r.status === "ok")).toHaveLength(9);
    expect(report.rows.every((r) => r.checked === 2)).toBe(true);

    expect(touches()).toBe(0);
    expect(await snapshot()).toBe(dbBefore);
    expect(await db.chats.get(archivedId)).toEqual(archived);
    expect(world.fs.files()).toEqual(filesBefore);
    expect(setItems).not.toHaveBeenCalled();
  });

  it("does not call the save, the sync or the import services", async () => {
    const { SyncService } = await import("../src/services/syncService");
    const { ImportService } = await import("../src/services/importService");
    const spies = [
      vi.spyOn(SyncService, "saveChat"),
      vi.spyOn(SyncService, "startBulkSyncIndexing"),
      vi.spyOn(SyncService, "finishBulkSyncIndexing"),
      vi.spyOn(ImportService, "saveImportedChat"),
    ];
    await runProviderHealth({}, deps(new FakeProbe()));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the health code cannot reach a writer", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const files = [
    ...readdirSync(join(ROOT, "src/background/health")).map((f) =>
      join(ROOT, "src/background/health", f),
    ),
    join(ROOT, "src/background/handlers/healthHandlers.ts"),
    join(ROOT, "src/providers/shared/chatInvariants.ts"),
  ];
  // The modules that save, queue, index or store media, by what they are called.
  const WRITERS =
    /(syncService|chatRepository|chatPersistence|importService|importBatch|mediaStorage|media_utils|searchService|searchIndex|metadataService|metadataQueue|metadataRepository|services\/db|workerApi|bulkSync\/orchestrator|bulkSync\/stateManager)/;

  it("imports no module that saves, queues, indexes or stores media", () => {
    for (const file of files) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map(
        (m) => m[1],
      );
      for (const spec of imports) expect(spec, `${file} imports ${spec}`).not.toMatch(WRITERS);
    }
  });

  it("transforms only with media skipped", () => {
    const text = readFileSync(join(ROOT, "src/background/health/providerHealth.ts"), "utf8");
    expect(text).toMatch(/transformer\.transform\([^)]*\{\s*media:\s*"skip",?\s*\}/s);
  });
});
