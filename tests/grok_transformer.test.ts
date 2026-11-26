import { describe, expect, it } from "vitest";
import type { ChatMessage, ModelResponse } from "../src/model/haevn_model";
import type { GrokRawExtraction, GrokResponse } from "../src/providers/grok/model";
import { convertGrokToHaevn } from "../src/providers/grok/transformer";

// HVN-168: a Grok chat's models were `["Grok"]` and its user messages carried "Grok" as their model.

function response(
  id: string,
  sender: "human" | "assistant",
  parent: string | undefined,
  extra: Partial<GrokResponse> = {},
): GrokResponse {
  return {
    responseId: id,
    message: `words ${id}`,
    sender,
    createTime: "2026-01-01T10:00:00.000Z",
    parentResponseId: parent,
    partial: false,
    fileAttachmentsMetadata: [],
    metadata: {},
    model: "",
    ...extra,
  } as unknown as GrokResponse;
}

async function convert(responses: GrokResponse[]) {
  const extraction: GrokRawExtraction = {
    conversation: {
      conversationId: "grok-1",
      title: "A chat",
      starred: false,
      createTime: "2026-01-01T10:00:00.000Z",
      modifyTime: "2026-01-01T10:05:00.000Z",
      systemPromptName: "",
      temporary: false,
      mediaTypes: [],
      workspaces: [],
      taskResult: {},
    },
    responseNodes: responses.map((r) => ({
      responseId: r.responseId,
      sender: r.sender,
      parentResponseId: r.parentResponseId,
    })),
    responses,
  };
  return convertGrokToHaevn(extraction);
}

function responseOf(message: ChatMessage): ModelResponse {
  return message.message.find((m) => m.kind === "response") as ModelResponse;
}

describe("the models a Grok chat names (HVN-168)", () => {
  it("lists the distinct models its answers name, and gives the user's messages none", async () => {
    const chat = await convert([
      response("u1", "human", undefined, { model: "grok-4" }),
      response("a1", "assistant", "u1", { model: "grok-4" }),
      response("u2", "human", "a1"),
      response("a2", "assistant", "u2", { model: "grok-3" }),
      response("u3", "human", "a2"),
      response("a3", "assistant", "u3", { model: "grok-4" }),
    ]);

    expect(chat.models).toEqual(["grok-4", "grok-3"]);
    expect(chat.messages.a1.model).toBe("grok-4");
    expect(chat.messages.u1.model).toBe("");
    expect(chat.messages.u2.model).toBe("");
  });

  it("reads the model from the metadata when the response has none of its own", async () => {
    const chat = await convert([
      response("u1", "human", undefined),
      response("a1", "assistant", "u1", {
        metadata: { requestModelDetails: { modelId: "grok-4" } },
      }),
      response("u2", "human", "a1"),
      response("a2", "assistant", "u2", { requestMetadata: { model: " grok-3 " } }),
    ]);

    expect(chat.models).toEqual(["grok-4", "grok-3"]);
  });

  it("names the provider only when no answer names a model, and shows it as the answer's name", async () => {
    const chat = await convert([
      response("u1", "human", undefined),
      response("a1", "assistant", "u1"),
    ]);

    expect(chat.models).toEqual(["Grok"]);
    expect(chat.messages.a1.model).toBe("");
    expect(responseOf(chat.messages.a1).model_name).toBe("Grok");
  });
});
