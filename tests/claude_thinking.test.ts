import { describe, expect, it } from "vitest";
import type { ChatTranscript } from "../src/providers/claude/model";
import { convertClaudeTranscriptToHaevn } from "../src/providers/claude/transformer";

// Synthetic payloads in the shape Claude's API returns for hidden thinking (HVN-113):
// `thinking: ""`, `thinking_hidden: true`, and the reasoning only as `summaries`.
const ts = "2026-10-17T10:00:00Z";

const block = (extra: Record<string, unknown>) => ({
  type: "thinking",
  start_timestamp: ts,
  stop_timestamp: ts,
  cut_off: false,
  ...extra,
});

const text = (t: string) => ({
  type: "text",
  text: t,
  start_timestamp: ts,
  stop_timestamp: ts,
  citations: [],
});

async function convertAssistant(content: unknown[]) {
  const transcript = {
    uuid: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic",
    updated_at: ts,
    current_leaf_message_uuid: "a-1",
    chat_messages: [
      {
        uuid: "u-1",
        text: "question",
        sender: "human",
        created_at: ts,
        updated_at: ts,
        attachments: [],
      },
      {
        uuid: "a-1",
        text: "",
        content,
        sender: "assistant",
        created_at: ts,
        updated_at: ts,
        attachments: [],
      },
    ],
  } as unknown as ChatTranscript;
  const chat = await convertClaudeTranscriptToHaevn(transcript);
  const response = chat.messages["a-1"].message.find((m) => m.kind === "response");
  return response && response.kind === "response" ? response.parts : [];
}

describe("claude transformer: thinking blocks", () => {
  it("keeps the summaries of a hidden thinking block, one paragraph each", async () => {
    const parts = await convertAssistant([
      block({
        thinking: "",
        thinking_hidden: true,
        summaries: [{ summary: "Weighing two readings" }, { summary: "Picking the shorter one" }],
      }),
      text("answer"),
    ]);
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking", "text"]);
    expect(parts[0]).toMatchObject({
      part_kind: "thinking",
      content: "Weighing two readings\n\nPicking the shorter one",
    });
  });

  it("prefers the full thinking over the summaries", async () => {
    const parts = await convertAssistant([
      block({ thinking: "the whole reasoning", summaries: [{ summary: "a summary" }] }),
      text("answer"),
    ]);
    expect(parts[0]).toMatchObject({ part_kind: "thinking", content: "the whole reasoning" });
  });

  it("still reads an older block that has no summaries field", async () => {
    const parts = await convertAssistant([block({ thinking: "old reasoning" }), text("answer")]);
    expect(parts[0]).toMatchObject({ part_kind: "thinking", content: "old reasoning" });
  });

  it("drops a block with neither thinking nor summaries, and blank summaries", async () => {
    const parts = await convertAssistant([
      block({ thinking: "", thinking_hidden: true, summaries: [] }),
      block({ thinking: "", thinking_hidden: true, summaries: [{ summary: "  " }] }),
      block({ thinking: "" }),
      text("answer"),
    ]);
    expect(parts.map((p) => p.part_kind)).toEqual(["text"]);
  });
});
