import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "../src/providers/codex/importer";
import { transformCodexToHaevnChat } from "../src/providers/codex/transformer";

describe("codex_transformer", () => {
  it("should preserve developer/system and tool events while skipping reasoning blocks", async () => {
    const jsonl = [
      JSON.stringify({
        timestamp: "2026-03-23T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-123",
          timestamp: "2026-03-23T09:59:59.000Z",
          cwd: "/tmp/project",
          cli_version: "0.116.0",
          base_instructions: { text: "Base system instructions" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Developer rules" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          content: "Thinking about the problem",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: '{"cmd":"echo hi"}',
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "hi",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T10:00:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ].join("\n");

    const extraction = await parseCodexJsonl(jsonl);
    const chat = transformCodexToHaevnChat(extraction);

    expect(chat.id).toBe("session-123");
    expect(chat.source).toBe("codex");
    expect(chat.title).toBe("Hello");
    expect(Object.keys(chat.messages).length).toBeGreaterThanOrEqual(5);

    const allParts = Object.values(chat.messages).flatMap((msg) =>
      msg.message.flatMap((modelMsg) => modelMsg.parts),
    );

    expect(allParts.some((part) => part.part_kind === "system-prompt")).toBe(true);
    expect(allParts.some((part) => part.part_kind === "thinking")).toBe(false);
    expect(allParts.some((part) => part.part_kind === "tool-call")).toBe(true);
    expect(allParts.some((part) => part.part_kind === "tool-return")).toBe(true);
  });
});
