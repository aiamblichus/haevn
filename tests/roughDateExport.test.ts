import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { roughDateLabelOf as cliLabelOf } from "../cli/src/utils/roughDate";
import { generateExportContent } from "../src/formatters";
import type { Chat } from "../src/model/haevn_model";
import { formatRoughDate, type RoughDate } from "../src/model/roughDate";
import { transformFragmentToHaevnChat } from "../src/providers/fragment";
import { parsed, withId } from "./helpers/fragmentFile";

// HVN-171: the times of a chat with a rough date are made up for ordering (HVN-163). The Markdown
// export writes its label and no time; the JSON export keeps the times and params.roughDate as data.

const NOW = 1_800_000_000_000;
const BODY =
  '<!-- HAEVN: role="user" -->\nTell me about the keeper.\n\n<!-- HAEVN: role="assistant" -->\nHe kept the light for forty years.\n';

/** A fragment, made by the real transformer, from its frontmatter lines. */
async function fragment(frontmatter: string): Promise<Chat> {
  return transformFragmentToHaevnChat(await parsed(withId(frontmatter, BODY)), NOW);
}

/** The YAML frontmatter of a Markdown export, read back. */
function frontmatterOf(markdown: string): Record<string, unknown> {
  return parse(markdown.slice(4, markdown.indexOf("\n---\n", 4))) as Record<string, unknown>;
}

describe("Markdown export of a chat with a rough date (HVN-171)", () => {
  it("writes its label as date, and no created_at or modified_at", async () => {
    const md = await generateExportContent(await fragment("date: ~2024-03"), { format: "markdown" });
    expect(frontmatterOf(md).date).toBe("c. Mar 2024");
    expect(md).not.toContain("created_at");
    expect(md).not.toContain("modified_at");
  });

  it.each([
    ["2024", "2024"],
    ["~2024-03", "c. Mar 2024"],
    ["2024-03..", "Mar 2024 or later"],
    ["2023-11..2024-02", "Nov 2023 to Feb 2024"],
  ])("writes the label the archive shows for %s", async (written, label) => {
    const md = await generateExportContent(await fragment(`date: ${written}`), {
      format: "markdown",
    });
    expect(frontmatterOf(md).date).toBe(label);
  });

  it("writes no time anywhere in the export, the messages included", async () => {
    const md = await generateExportContent(await fragment("date: ~2024-03"), { format: "markdown" });
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the archive's sync time, which is a real time, with the metadata", async () => {
    const md = await generateExportContent(await fragment("date: ~2024-03"), {
      format: "markdown",
      includeMetadata: true,
    });
    expect(frontmatterOf(md)).toHaveProperty("last_synced_timestamp");
    expect(frontmatterOf(md)).not.toHaveProperty("created_at");
  });

  it("an undated chat has no date line, as a fragment with no date has none", async () => {
    const md = await generateExportContent(await fragment(""), { format: "markdown" });
    expect(frontmatterOf(md)).not.toHaveProperty("date");
    expect(md).not.toContain("created_at");
    expect(md).not.toContain("modified_at");
  });
});

describe("JSON export of a chat with a rough date (HVN-171)", () => {
  it("keeps params.roughDate and the stored times as data", async () => {
    const chat = await fragment("date: ~2024-03");
    const json = JSON.parse(await generateExportContent(chat, { format: "json" })) as Chat;
    expect(json.params.roughDate).toEqual(chat.params.roughDate);
    expect(json.timestamp).toBe(chat.timestamp);
    expect(json.providerLastModifiedTimestamp).toBe(chat.providerLastModifiedTimestamp);
    for (const [id, message] of Object.entries(chat.messages)) {
      expect(json.messages[id].timestamp).toBe(message.timestamp);
    }
  });
});

describe("a chat with no rough date is unchanged (HVN-171)", () => {
  // Captured from the export before HVN-171, for an exact-date fragment: created_at and modified_at
  // are its own times, and the Markdown is what it was.
  const GOLDEN =
    "---\ntitle: The keeper\nsource: fragment\nconversation_id: fragment:7b0e6c1e-2f4a-4c58-9d0b-3a1f5e8c9a12\ncreated_at: 2024-03-15T12:00:00.000Z\nmodified_at: 2024-03-15T12:00:00.000Z\nmodels_used:\n  - claude-3-opus\nlast_synced_timestamp: 2027-01-15T08:00:00.000Z\ntotal_messages: 2\nbranch: current\n---\n\n<!-- HAEVN: role=\"user\" -->\nTell me about the keeper.\n\n\n<!-- HAEVN: role=\"assistant\" -->\nHe kept the light for forty years.\n\n\n";

  it("exports an exact-date fragment byte for byte as it did before", async () => {
    const chat = await fragment(
      "date: 2024-03-15T12:00:00Z\nmodel: claude-3-opus\ntitle: The keeper\ntags: [poem]",
    );
    const md = await generateExportContent(chat, {
      format: "markdown",
      includeMetadata: true,
      includeTimestamps: true,
    });
    expect(md).toBe(GOLDEN);
  });
});

describe("the CLI's rough-date labels agree with the extension's (HVN-171)", () => {
  const CASES: Array<[string, RoughDate]> = [
    [
      "a year",
      {
        text: "2024",
        precision: "year",
        approximate: false,
        from: Date.UTC(2024, 0, 1),
        to: Date.UTC(2025, 0, 1),
      },
    ],
    [
      "an approximate month",
      {
        text: "~2024-03",
        precision: "month",
        approximate: true,
        from: Date.UTC(2024, 2, 1),
        to: Date.UTC(2024, 3, 1),
      },
    ],
    [
      "a day",
      {
        text: "2024-03-15",
        precision: "day",
        approximate: false,
        from: Date.UTC(2024, 2, 15),
        to: Date.UTC(2024, 2, 16),
      },
    ],
    [
      "a range",
      {
        text: "2023-11..2024-02",
        precision: "range",
        approximate: false,
        from: Date.UTC(2023, 10, 1),
        to: Date.UTC(2024, 2, 1),
      },
    ],
    [
      "a not-before date",
      {
        text: "2024-03..",
        precision: "after",
        approximate: false,
        from: Date.UTC(2024, 2, 1),
        to: null,
      },
    ],
    ["no date", { text: "", precision: "unknown", approximate: false, from: 0, to: 0 }],
  ];

  it.each(CASES)("labels %s as the extension does", (_, rough) => {
    expect(cliLabelOf({ params: { roughDate: rough } })).toBe(formatRoughDate(rough));
  });

  it("has no label for a chat without a rough date", () => {
    expect(cliLabelOf({ params: {} })).toBeUndefined();
  });
});
