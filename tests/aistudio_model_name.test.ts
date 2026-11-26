import { afterEach, describe, expect, it } from "vitest";
import { extractAIStudioModelName } from "../src/providers/aistudio/extractor";
import type { AIStudioConversationData } from "../src/providers/aistudio/model";
import { transformAIStudioToHaevn } from "../src/providers/aistudio/transformer";

// HVN-168. The repository has no DOM environment, so `document` is stubbed with the one query the
// extractor makes: a map from a selector to the text of the element the page holds there. The
// selectors are the two in `SELECTORS.modelNames`; that they match the live page is proven only by
// a run against it.

const CURRENT = 'ms-model-selector [data-test-id="model-name"]';
const OLDER = 'ms-model-selector-v3 [data-test-id="model-name"]';

function stubPage(spans: Record<string, string>): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector in spans ? { textContent: spans[selector] } : null,
    },
  });
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

const conversation: AIStudioConversationData = {
  platform: "aistudio",
  url: "https://aistudio.google.com/prompts/abc",
  conversationId: "abc",
  title: "A chat",
  messages: [],
  extractedAt: "2026-11-26T12:00:00.000Z",
};

describe("aistudio model name (HVN-168)", () => {
  it("reads the model from the current picker, trimmed", () => {
    stubPage({ [CURRENT]: "  Gemini 2.5 Pro  " });

    expect(extractAIStudioModelName()).toBe("Gemini 2.5 Pro");
  });

  it("reads the model from the older picker when the current one is absent", () => {
    stubPage({ [OLDER]: "Gemini 2.0 Flash" });

    expect(extractAIStudioModelName()).toBe("Gemini 2.0 Flash");
  });

  it("prefers the current picker when both hold a name", () => {
    stubPage({ [CURRENT]: "Gemini 2.5 Pro", [OLDER]: "Gemini 2.0 Flash" });

    expect(extractAIStudioModelName()).toBe("Gemini 2.5 Pro");
  });

  it("skips a current picker whose text is blank and reads the older one", () => {
    stubPage({ [CURRENT]: "   ", [OLDER]: "Gemini 2.0 Flash" });

    expect(extractAIStudioModelName()).toBe("Gemini 2.0 Flash");
  });

  it.each([
    ["both spans are empty", { [CURRENT]: "", [OLDER]: "  " }],
    ["neither span is on the page", {}],
  ])("names no model when %s, and the chat is named Gemini", async (_, spans) => {
    stubPage(spans);

    const modelName = extractAIStudioModelName();
    expect(modelName).toBeUndefined();

    const chat = await transformAIStudioToHaevn({ ...conversation, modelName });
    expect(chat.models).toEqual(["Gemini"]);
  });
});
