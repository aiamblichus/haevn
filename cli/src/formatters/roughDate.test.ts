import { describe, expect, it } from "vitest";
import { buildChat } from "../testing/fixtures";
import type { Chat } from "../types/chat";
import { formatTimestamp } from "../utils/output";
import { formatBranchAsJson, formatChatAsJson } from "./json";
import { formatBranchAsMarkdown } from "./markdown";

// HVN-171: the bridge gives a chat with a rough date its label as `dateLabel` (HVN-163 made its
// stored times up). `get` and `branches` show the label where a time would be, and give no time for
// its messages. A chat without `dateLabel` is shown as it always was.

const MID = Date.UTC(2024, 2, 15, 12);
const PATH = ["u1", "a1"];

/** A two-turn chat at the given time. Message i is at timestamp + i ms, as a fragment's are. */
function chatAt(timestamp: number, dateLabel?: string): Chat {
  const chat = buildChat([
    { id: "u1", parentId: null, role: "user", text: "hello" },
    { id: "a1", parentId: "u1", role: "assistant", text: "hi there" },
  ]);
  chat.timestamp = timestamp;
  chat.messages.u1.timestamp = timestamp;
  chat.messages.a1.timestamp = timestamp + 1;
  if (dateLabel !== undefined) chat.dateLabel = dateLabel;
  return chat;
}

describe("the Markdown header of a chat with a rough date", () => {
  it("shows its label in place of a time", () => {
    const out = formatBranchAsMarkdown(chatAt(MID, "c. Mar 2024"), PATH);
    expect(out).toContain("> Chat ID: `chat-1` | Platform: claude | c. Mar 2024\n");
  });

  it("says undated in place of unknown", () => {
    const out = formatBranchAsMarkdown(chatAt(0, "undated"), PATH);
    expect(out).toContain("> Chat ID: `chat-1` | Platform: claude | undated\n");
    expect(out).not.toContain("unknown");
  });

  it("has no clock time in the header or the messages", () => {
    const out = formatBranchAsMarkdown(chatAt(MID, "c. Mar 2024"), PATH);
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("falls back to the stored time when the bridge gave no label (an older extension)", () => {
    const out = formatBranchAsMarkdown(chatAt(MID), PATH);
    expect(out).toContain(`> Chat ID: \`chat-1\` | Platform: claude | ${formatTimestamp(MID)}\n`);
  });
});

describe("the Markdown header of a chat without a rough date", () => {
  it("still shows its time, formatted as before", () => {
    const out = formatBranchAsMarkdown(chatAt(MID), PATH);
    expect(out).toContain(`> Chat ID: \`chat-1\` | Platform: claude | ${formatTimestamp(MID)}\n`);
  });
});

describe("the JSON of a chat with a rough date", () => {
  it("gives dateLabel in place of timestamp, on the chat and on each message", () => {
    const out = JSON.parse(
      JSON.stringify(formatBranchAsJson(chatAt(MID, "c. Mar 2024"), PATH)),
    ) as Record<string, unknown>;
    expect(out.dateLabel).toBe("c. Mar 2024");
    expect(out).not.toHaveProperty("timestamp");
    const branch = out.branch as { messages: Array<Record<string, unknown>> };
    for (const message of branch.messages) expect(message).not.toHaveProperty("timestamp");
  });

  it("does the same for the whole chat", () => {
    const out = JSON.parse(JSON.stringify(formatChatAsJson(chatAt(MID, "c. Mar 2024")))) as {
      dateLabel?: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(out.dateLabel).toBe("c. Mar 2024");
    expect(out).not.toHaveProperty("timestamp");
    for (const message of out.messages) expect(message).not.toHaveProperty("timestamp");
  });
});

describe("the JSON of a chat without a rough date", () => {
  it("keeps the timestamp on the chat and on each message, and no dateLabel", () => {
    const out = JSON.parse(JSON.stringify(formatBranchAsJson(chatAt(MID), PATH))) as {
      timestamp: number;
      branch: { messages: Array<{ timestamp: number }> };
    };
    expect(out.timestamp).toBe(MID);
    expect(out.branch.messages.map((message) => message.timestamp)).toEqual([MID, MID + 1]);
    expect(out).not.toHaveProperty("dateLabel");
  });
});
