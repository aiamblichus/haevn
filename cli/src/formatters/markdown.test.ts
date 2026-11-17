import { describe, expect, it } from "vitest";
import { buildChat } from "../testing/fixtures";
import { formatBranchAsMarkdown } from "./markdown";

// a1 carries thinking that runs past the 100-character preview, and a2 is a tool call with no text.
const THINKING = `Let me think. ${"a".repeat(200)} THE_END`;

const chat = buildChat(
  [
    { id: "u1", parentId: null, role: "user", text: "hello" },
    { id: "a1", parentId: "u1", role: "assistant", text: "answer", thinking: THINKING },
    { id: "u2", parentId: "a1", role: "user", text: "more" },
    { id: "a2", parentId: "u2", role: "assistant", text: "" },
    { id: "a3", parentId: "a2", role: "assistant", text: "last" },
  ],
  { title: "Fixture chat" },
);
const path = ["u1", "a1", "u2", "a2", "a3"];

describe("formatBranchAsMarkdown", () => {
  it("renders a heading per message that has text, under the title and a metadata line", () => {
    const out = formatBranchAsMarkdown(chat, path);

    expect(out).toContain("# Fixture chat");
    expect(out).toContain("Chat ID: `chat-1`");
    // a2 has no text, so it gets no heading.
    expect(out.match(/^## .+$/gm)).toEqual(["## User", "## Assistant", "## User", "## Assistant"]);
    expect(out).toContain("_5 messages_");
  });

  it("shows thinking as a short preview by default, and in full with includeThinking", () => {
    const preview = formatBranchAsMarkdown(chat, path);
    expect(preview).toContain("[thinking: Let me think.");
    expect(preview).not.toContain("THE_END");

    const full = formatBranchAsMarkdown(chat, path, { includeThinking: true });
    expect(full).toContain("<thinking>");
    expect(full).toContain("THE_END");
    expect(full).toContain("answer");
  });

  it("keeps the last N messages with a note on the rest, and lets head win over tail", () => {
    const tail = formatBranchAsMarkdown(chat, path, { tail: 3 });
    expect(tail).toContain("_…2 earlier messages omitted");
    expect(tail).toContain("more");
    expect(tail).not.toContain("hello");

    const both = formatBranchAsMarkdown(chat, path, { head: 2, tail: 3 });
    expect(both).toContain("hello");
    expect(both).not.toContain("more");
    expect(both).toContain("_…3 later messages omitted");
    expect(both).not.toContain("earlier messages omitted");
  });
});
