import { describe, expect, it } from "vitest";
import type { Chat } from "../types/chat";
import { formatChatListText, parseMetadataKeys, parseOffset } from "./list";

describe("haevn list --offset (HVN-14)", () => {
  it("is 0 when the flag is absent or empty", () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("")).toBe(0);
  });

  it("reads a whole number, 0 or more", () => {
    expect(parseOffset("0")).toBe(0);
    expect(parseOffset("40")).toBe(40);
  });

  it.each(["-1", "1.5", "abc", "10x"])("refuses %s, which is not a whole number", (input) => {
    expect(() => parseOffset(input)).toThrow("--offset must be a whole number, 0 or more");
  });
});

describe("haevn list --include-metadata (HVN-11)", () => {
  it("asks for nothing when the flag is absent or blank", () => {
    expect(parseMetadataKeys(undefined)).toEqual([]);
    expect(parseMetadataKeys(" , ")).toEqual([]);
  });

  it("expands all to the four keys, in their declared order", () => {
    expect(parseMetadataKeys("all")).toEqual(["description", "synopsis", "categories", "keywords"]);
  });

  it("reads keys in any case and spacing, and returns each once in declared order", () => {
    expect(parseMetadataKeys(" Keywords , description, keywords")).toEqual([
      "description",
      "keywords",
    ]);
  });

  it("refuses an unknown key and names the valid options", () => {
    expect(() => parseMetadataKeys("description,summary")).toThrow(
      "Unknown --include-metadata key: summary. " +
        "Valid options: description, synopsis, categories, keywords, all.",
    );
  });
});

describe("haevn list text output with metadata (HVN-11)", () => {
  const chat: Partial<Chat> & { metaTitle: string; metadata: Record<string, unknown> } = {
    id: "chat-1",
    title: "Platform title",
    metaTitle: "Chosen title",
    source: "claude",
    lastSyncedTimestamp: Date.now(),
    metadata: {
      description: "About it",
      synopsis: "A longer account",
      categories: ["Work", "Code"],
      keywords: ["rust"],
    },
  };

  it("shows only the metadata keys that were asked for", () => {
    const out = formatChatListText([chat], 1, { includeMetadata: ["categories"] });

    expect(out).toContain("categories:");
    expect(out).toContain("Work, Code");
    expect(out).not.toContain("desc:");
    expect(out).not.toContain("synopsis:");
    expect(out).not.toContain("keywords:");
  });

  it("shows the metadata title in place of the platform title", () => {
    const out = formatChatListText([chat], 1, {});

    expect(out).toContain("Chosen title");
    expect(out).not.toContain("Platform title");
  });
});
