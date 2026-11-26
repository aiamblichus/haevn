import { describe, expect, it } from "vitest";
import { generateExportContent } from "../src/formatters";
import type { Chat } from "../src/model/haevn_model";
import { transformFragmentToHaevnChat } from "../src/providers/fragment";
import { parseMarkdownContent } from "../src/utils/markdownImporter";
import { parsed, withId } from "./helpers/fragmentFile";

// HVN-175: the Markdown export writes the date of a chat with a rough date as the person wrote it,
// and the Markdown importer reads that date back with the fragment parser. A round trip gives the
// same params.roughDate, and the same made-up times: the middle of the range for the chat, and one
// millisecond on for each turn (the fragment scheme).

const NOW = 1_800_000_000_000;
const BODY =
  '<!-- HAEVN: role="user" -->\nTell me about the keeper.\n\n<!-- HAEVN: role="assistant" -->\nHe kept the light for forty years.\n';

/** A fragment dated `date`, or undated when it is empty, made by the real transformer. */
async function fragment(date: string): Promise<Chat> {
  const dateLine = date ? `\ndate: ${date}` : "";
  return transformFragmentToHaevnChat(
    await parsed(withId(`title: The keeper${dateLine}`, BODY)),
    NOW,
  );
}

/** The chat as the Markdown export writes it, and as the Markdown importer reads it back. */
async function roundTrip(chat: Chat): Promise<Chat> {
  return parseMarkdownContent(await generateExportContent(chat, { format: "markdown" }));
}

function timesOf(chat: Chat): number[] {
  return Object.values(chat.messages).map((message) => message.timestamp ?? -1);
}

describe("a chat with a rough date survives the Markdown export and import (HVN-175)", () => {
  it.each([
    ["2024-03-15", "a day"],
    ["2024", "a year"],
    ["~2024-03", "a month, about then"],
    ["2024-03..", "not before a month"],
    ["2023-11..2024-02", "a range"],
  ])("%s (%s) reads back as the same roughDate", async (date) => {
    const chat = await fragment(date);
    expect(chat.params.roughDate).toBeDefined();
    const back = await roundTrip(chat);
    expect(back.params.roughDate).toEqual(chat.params.roughDate);
  });

  it.each([
    ["2024-03-15", "a day"],
    ["~2024-03", "a month, about then"],
    ["2023-11..2024-02", "a range"],
  ])("%s (%s) gives the chat and its messages the fragment's made-up times", async (date) => {
    const chat = await fragment(date);
    const back = await roundTrip(chat);
    expect(back.timestamp).toBe(chat.timestamp);
    expect(timesOf(back)).toEqual(timesOf(chat));
  });

  it("an undated chat reads back undated, the shape a fragment with no date has", async () => {
    const chat = await fragment("");
    expect(chat.params.roughDate).toMatchObject({ precision: "unknown" });
    const back = await roundTrip(chat);
    expect(back.params.roughDate).toEqual(chat.params.roughDate);
    expect(back.timestamp).toBe(0);
    expect(timesOf(back)).toEqual(timesOf(chat));
  });
});

describe("a Markdown file's dates, as the importer reads them (HVN-175)", () => {
  it("dates a file that has created_at by it, and gives it no roughDate", async () => {
    const back = await parseMarkdownContent(
      `---\ntitle: Dated\ncreated_at: 2024-01-01T10:00:00.000Z\ndate: ~2024-03\n---\n\n<!-- HAEVN: role="user" -->\nHi\n`,
    );
    expect(back.timestamp).toBe(Date.parse("2024-01-01T10:00:00.000Z"));
    expect(back.params).toEqual({});
  });

  it("refuses a date that is none of the fragment forms, such as a label written by hand", async () => {
    await expect(
      parseMarkdownContent(
        `---\ntitle: Labelled\ndate: c. Mar 2024\n---\n\n<!-- HAEVN: role="user" -->\nHi\n`,
      ),
    ).rejects.toThrow("date is none of");
  });
});
