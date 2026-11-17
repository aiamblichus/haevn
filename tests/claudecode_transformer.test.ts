import { describe, expect, it } from "vitest";
import { parseClaudeCodeJsonl } from "../src/providers/claudecode/importer";
import { transformToHaevnChat } from "../src/providers/claudecode/transformer";

const base = {
  sessionId: "session-1",
  cwd: "/tmp/project",
  gitBranch: "main",
  version: "2.1.5",
  userType: "external",
  isSidechain: false,
};

function jsonl(): string {
  return [
    {
      ...base,
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: "2026-03-23T10:00:00.000Z",
      message: { role: "user", content: "Read the readme" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      requestId: "req-1",
      timestamp: "2026-03-23T10:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } }],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      timestamp: "2026-03-23T10:00:02.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "# Title", is_error: false },
          { type: "tool_result", tool_use_id: "toolu_missing", content: "oops", is_error: true },
        ],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

describe("claudecode_transformer", () => {
  it("names a tool result after the tool_use block it answers", async () => {
    const chat = transformToHaevnChat(await parseClaudeCodeJsonl(jsonl()));

    const toolReturns = Object.values(chat.messages)
      .flatMap((msg) => msg.message.flatMap((modelMsg) => modelMsg.parts))
      .filter((part) => part.part_kind === "tool-return");

    expect(toolReturns.map((part) => part.tool_name)).toEqual(["Read", "unknown_tool"]);
    expect(toolReturns.map((part) => part.tool_call_id)).toEqual(["toolu_1", "toolu_missing"]);
    expect(toolReturns[1].metadata).toEqual({ is_error: true });
  });

  it("stamps request parts with the message's ISO timestamp, as the model declares", async () => {
    const chat = transformToHaevnChat(await parseClaudeCodeJsonl(jsonl()));

    const parts = Object.values(chat.messages)
      .flatMap((msg) => msg.message.flatMap((modelMsg) => modelMsg.parts))
      .filter((part) => part.part_kind === "user-prompt" || part.part_kind === "tool-return");

    expect(parts.length).toBe(3);
    for (const part of parts) {
      expect(typeof part.timestamp).toBe("string");
      expect(new Date(part.timestamp).toISOString()).toBe(part.timestamp);
    }
  });

  it("returns a chat whose sync metadata the persistence layer can fill in", async () => {
    const chat = transformToHaevnChat(await parseClaudeCodeJsonl(jsonl()));

    expect(chat.deleted).toBe(0);
    expect(chat.syncStatus).toBe("new");
    expect(chat.checksum).toBe("");
  });
});
