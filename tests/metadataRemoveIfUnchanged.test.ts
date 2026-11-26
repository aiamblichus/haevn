import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";

beforeEach(async () => {
  await getDB().chatMetadata.clear();
});

describe("removeIfUnchanged (HVN-163, gauge m6)", () => {
  it("deletes the record it was given when nothing has changed since", async () => {
    await MetadataRepository.set("c", { title: "Old", source: "manual" });
    const read = await MetadataRepository.get("c");
    if (!read) throw new Error("no record");

    expect(await MetadataRepository.removeIfUnchanged("c", read)).toBe(true);
    expect(await MetadataRepository.get("c")).toBeNull();
  });

  it("keeps a record that was saved again after it was read", async () => {
    await MetadataRepository.set("c", { title: "Old", source: "manual" });
    const read = await MetadataRepository.get("c");
    if (!read) throw new Error("no record");
    // An edit in the archive between the check and the delete
    await getDB().chatMetadata.update("c", {
      description: "Written by hand",
      updatedAt: read.updatedAt + 1,
    });

    expect(await MetadataRepository.removeIfUnchanged("c", read)).toBe(false);
    expect(await MetadataRepository.get("c")).toMatchObject({ description: "Written by hand" });
  });

  it("does nothing for a record that is already gone", async () => {
    await MetadataRepository.set("c", { title: "Old", source: "manual" });
    const read = await MetadataRepository.get("c");
    if (!read) throw new Error("no record");
    await MetadataRepository.remove("c");

    expect(await MetadataRepository.removeIfUnchanged("c", read)).toBe(false);
  });
});
