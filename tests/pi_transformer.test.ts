import { describe, expect, it } from "vitest";
import { parsePiJsonl } from "../src/providers/pi/importer";
import { transformPiToHaevnChat } from "../src/providers/pi/transformer";

describe("pi_transformer", () => {
  it("should preserve user/assistant/tool flow and include thinking/tool events", async () => {
    const jsonl = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session-123",
        timestamp: "2026-03-23T10:00:00.000Z",
        cwd: "/tmp/project",
      }),
      JSON.stringify({
        type: "model_change",
        id: "mc-1",
        timestamp: "2026-03-23T10:00:01.000Z",
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "message",
        id: "u-1",
        timestamp: "2026-03-23T10:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please list staged files" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a-1",
        timestamp: "2026-03-23T10:00:03.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "thinking", thinking: "I should inspect git state first." },
            { type: "text", text: "I will check staged files." },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "git diff --cached --stat" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "t-1",
        timestamp: "2026-03-23T10:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "1 file changed, 2 insertions(+)" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a-2",
        timestamp: "2026-03-23T10:00:05.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Staged files listed." }],
        },
      }),
    ].join("\n");

    const extraction = await parsePiJsonl(jsonl);
    const chat = transformPiToHaevnChat(extraction);

    expect(chat.id).toBe("pi-session-123");
    expect(chat.source).toBe("pi");
    expect(chat.title).toBe("Please list staged files");
    expect(Object.keys(chat.messages).length).toBe(4);

    const allParts = Object.values(chat.messages).flatMap((msg) =>
      msg.message.flatMap((modelMsg) => modelMsg.parts),
    );

    expect(allParts.some((part) => part.part_kind === "thinking")).toBe(true);
    expect(allParts.some((part) => part.part_kind === "tool-call")).toBe(true);
    expect(allParts.some((part) => part.part_kind === "tool-return")).toBe(true);
  });
});
