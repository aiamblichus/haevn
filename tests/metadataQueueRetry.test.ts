import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleResetAllFailedEmbeddings,
  handleResetAllFailedMetadata,
  handleSetMetadataAIConfig,
  handleSetStarmapConfig,
} from "../src/background/handlers/metadataHandlers";
import type { Chat } from "../src/model/haevn_model";
import type { StoredChatMessage } from "../src/services/db";
import { getDB } from "../src/services/db";
import {
  buildChatCompletionBody,
  EMBEDDING_PROCESS_ALARM,
  generateForChat,
  METADATA_PROCESS_ALARM,
  resetAllFailed,
  resetAllFailedEmbeddings,
  stripReasoningBlocks,
} from "../src/services/metadataService";
import {
  getMetadataAIConfig,
  setMetadataAIConfig,
  setStarmapConfig,
} from "../src/services/settingsService";
import { log } from "../src/utils/logger";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const META_URL = "https://meta.test/v1";
const EMBED_URL = "https://embed.test/v1";

type SetMetadataRequest = Parameters<typeof handleSetMetadataAIConfig>[0];
type SetStarmapRequest = Parameters<typeof handleSetStarmapConfig>[0];
type ResetMetadataRequest = Parameters<typeof handleResetAllFailedMetadata>[0];
type ResetEmbeddingRequest = Parameters<typeof handleResetAllFailedEmbeddings>[0];

interface HandlerReply {
  success: boolean;
  error?: string;
  data?: { reset: number };
}

/** Save metadata settings through the handler the options page uses. */
async function setMetadataConfig(config: Record<string, unknown>): Promise<HandlerReply> {
  const sendResponse = vi.fn();
  await handleSetMetadataAIConfig(
    { action: "setMetadataAIConfig", config } as SetMetadataRequest,
    sendResponse,
  );
  return sendResponse.mock.calls[0]?.[0] as HandlerReply;
}

/** Save Starmap settings through the handler the options page uses. */
async function setStarmap(config: Record<string, unknown>): Promise<HandlerReply> {
  const sendResponse = vi.fn();
  await handleSetStarmapConfig(
    { action: "setStarmapConfig", config } as SetStarmapRequest,
    sendResponse,
  );
  return sendResponse.mock.calls[0]?.[0] as HandlerReply;
}

async function retryMetadata(): Promise<HandlerReply> {
  const sendResponse = vi.fn();
  await handleResetAllFailedMetadata(
    { action: "resetAllFailedMetadata" } as ResetMetadataRequest,
    sendResponse,
  );
  return sendResponse.mock.calls[0]?.[0] as HandlerReply;
}

async function retryEmbeddings(): Promise<HandlerReply> {
  const sendResponse = vi.fn();
  await handleResetAllFailedEmbeddings(
    { action: "resetAllFailedEmbeddings" } as ResetEmbeddingRequest,
    sendResponse,
  );
  return sendResponse.mock.calls[0]?.[0] as HandlerReply;
}

async function metadataStatus(chatId: string): Promise<string | undefined> {
  return (await getDB().metadataQueue.get(chatId))?.status;
}

async function embeddingStatus(chatId: string): Promise<string | undefined> {
  return (await getDB().embeddingQueue.get(chatId))?.status;
}

/** Puts a failed item back to failed, for the next save in the same test. */
async function markMetadataFailed(chatId: string): Promise<void> {
  await getDB().metadataQueue.update(chatId, { status: "failed", retries: 3 });
}

async function markEmbeddingFailed(chatId: string): Promise<void> {
  await getDB().embeddingQueue.update(chatId, { status: "failed", retries: 3 });
}

function buildChat(id: string): Chat {
  return {
    id,
    source: "test",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["test-model"],
    system: undefined,
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "synced",
    lastSyncAttemptMessage: undefined,
  };
}

/** One chat with one user message, enough for the metadata prompt. */
async function seedChat(chatId: string): Promise<void> {
  const db = getDB();
  await db.chats.put(buildChat(chatId));
  await db.chatMessages.put({
    id: "m1",
    chatId,
    childrenIds: [],
    message: [{ kind: "request", parts: [{ part_kind: "user-prompt", content: "What is tea?" }] }],
    model: "test-model",
    done: true,
    timestamp: 1704067200000,
  } as unknown as StoredChatMessage);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const db = getDB();
  await Promise.all([
    db.metadataQueue.clear(),
    db.embeddingQueue.clear(),
    db.chats.clear(),
    db.chatMessages.clear(),
    db.chatMetadata.clear(),
  ]);
  await db.metadataQueue.bulkPut([
    {
      chatId: "failed-a",
      status: "failed",
      retries: 3,
      addedAt: 1000,
      lastAttemptAt: 1500,
      error: "LLM response contained no content",
    },
    { chatId: "failed-b", status: "failed", retries: 3, addedAt: 1100, error: "LLM API error 500" },
    // A pending item that has failed once already: its retries and error are not for reset.
    { chatId: "pending-c", status: "pending", retries: 1, addedAt: 2000, error: "an earlier error" },
    { chatId: "processing-d", status: "processing", retries: 2, addedAt: 3000, lastAttemptAt: 3500 },
  ]);
  await db.embeddingQueue.bulkPut([
    { chatId: "failed-e", status: "failed", retries: 3, addedAt: 1000, error: "embedding error" },
    { chatId: "pending-f", status: "pending", retries: 0, addedAt: 2000 },
    { chatId: "processing-g", status: "processing", retries: 1, addedAt: 3000, lastAttemptAt: 3500 },
  ]);
  await setMetadataAIConfig({
    enabled: true,
    url: META_URL,
    model: "meta-a",
    categories: [],
    extraRequestParams: {},
    indexMissing: false,
  });
  await setStarmapConfig({
    enabled: true,
    embeddingsEnabled: true,
    embeddingUrl: EMBED_URL,
    embeddingModel: "embed-a",
    autoEmbedOnMetadataChange: true,
    umapSeed: 42,
  });
});

afterEach(() => {
  // Restores the fetch and alarm spies; the chrome stub from tests/setup.ts stays in place.
  vi.restoreAllMocks();
});

describe("Retry failed: the metadata queue (HVN-118)", () => {
  it("resetAllFailed turns failed items pending and leaves pending and processing items alone", async () => {
    const db = getDB();
    const pendingBefore = await db.metadataQueue.get("pending-c");
    const processingBefore = await db.metadataQueue.get("processing-d");
    const create = vi.spyOn(chrome.alarms, "create");

    const count = await resetAllFailed();

    expect(count).toBe(2);
    for (const chatId of ["failed-a", "failed-b"]) {
      const item = await db.metadataQueue.get(chatId);
      expect(item).toMatchObject({ status: "pending", retries: 0 });
      expect(item?.error).toBeUndefined();
      expect(item?.addedAt).toBeGreaterThan(1000);
    }
    expect(await db.metadataQueue.get("pending-c")).toEqual(pendingBefore);
    expect(await db.metadataQueue.get("processing-d")).toEqual(processingBefore);
    expect(await db.metadataQueue.where("status").equals("failed").count()).toBe(0);
    expect(create).toHaveBeenCalledWith(METADATA_PROCESS_ALARM, expect.anything());
  });

  it("the Retry message reports how many it reset, and zero once none are failed", async () => {
    expect(await retryMetadata()).toEqual({ success: true, data: { reset: 2 } });
    expect(await retryMetadata()).toEqual({ success: true, data: { reset: 0 } });
  });
});

describe("Retry failed: the embedding queue (HVN-118)", () => {
  it("resetAllFailedEmbeddings turns failed items pending and leaves pending and processing items alone", async () => {
    const db = getDB();
    const pendingBefore = await db.embeddingQueue.get("pending-f");
    const processingBefore = await db.embeddingQueue.get("processing-g");
    const create = vi.spyOn(chrome.alarms, "create");

    const count = await resetAllFailedEmbeddings();

    expect(count).toBe(1);
    const item = await db.embeddingQueue.get("failed-e");
    expect(item).toMatchObject({ status: "pending", retries: 0 });
    expect(item?.error).toBeUndefined();
    expect(await db.embeddingQueue.get("pending-f")).toEqual(pendingBefore);
    expect(await db.embeddingQueue.get("processing-g")).toEqual(processingBefore);
    expect(create).toHaveBeenCalledWith(EMBEDDING_PROCESS_ALARM, expect.anything());
  });

  it("the Retry message reports how many embedding items it reset", async () => {
    expect(await retryEmbeddings()).toEqual({ success: true, data: { reset: 1 } });
    expect(await retryEmbeddings()).toEqual({ success: true, data: { reset: 0 } });
  });
});

describe("a config save resets failed items only on an actual change (HVN-118)", () => {
  it("a metadata model change resets the failed items; saves that change nothing do not", async () => {
    expect(await setMetadataConfig({ model: "meta-a" })).toMatchObject({ success: true });
    expect(await setMetadataConfig({ url: `${META_URL}/` })).toMatchObject({ success: true });
    expect(await setMetadataConfig({ autoGenerate: true })).toMatchObject({ success: true });
    expect(await metadataStatus("failed-a")).toBe("failed");
    expect(await metadataStatus("failed-b")).toBe("failed");

    expect(await setMetadataConfig({ model: "meta-b" })).toMatchObject({ success: true });

    expect(await metadataStatus("failed-a")).toBe("pending");
    expect(await metadataStatus("failed-b")).toBe("pending");
    expect(await metadataStatus("pending-c")).toBe("pending");
    expect(await metadataStatus("processing-d")).toBe("processing");
  });

  it("a metadata URL change resets the failed items", async () => {
    expect(await setMetadataConfig({ url: "https://other.test/v1" })).toMatchObject({
      success: true,
    });
    expect(await metadataStatus("failed-a")).toBe("pending");
  });

  it("a change to the extra request parameters resets; the same keys in another order do not", async () => {
    await setMetadataConfig({ extraRequestParams: { reasoning_effort: "low", max_tokens: 4000 } });
    expect(await metadataStatus("failed-a")).toBe("pending");

    await markMetadataFailed("failed-a");
    await setMetadataConfig({ extraRequestParams: { max_tokens: 4000, reasoning_effort: "low" } });
    expect(await metadataStatus("failed-a")).toBe("failed");

    await setMetadataConfig({ extraRequestParams: { reasoning_effort: "high", max_tokens: 4000 } });
    expect(await metadataStatus("failed-a")).toBe("pending");
  });

  it("extra request parameters that are not a JSON object are refused and nothing is saved", async () => {
    for (const bad of [["not", "an", "object"], "low", null]) {
      const reply = await setMetadataConfig({ extraRequestParams: bad });
      expect(reply.success).toBe(false);
      expect(reply.error).toBe("Extra request parameters must be a JSON object");
    }
    expect((await getMetadataAIConfig()).extraRequestParams).toEqual({});
    expect(await metadataStatus("failed-a")).toBe("failed");
  });

  it("an embedding model change resets the failed embedding items; other Starmap saves do not", async () => {
    expect(await setStarmap({ umapSeed: 7 })).toMatchObject({ success: true });
    expect(await setStarmap({ embeddingUrl: `${EMBED_URL}/` })).toMatchObject({ success: true });
    expect(await embeddingStatus("failed-e")).toBe("failed");

    expect(await setStarmap({ embeddingModel: "embed-b" })).toMatchObject({ success: true });

    expect(await embeddingStatus("failed-e")).toBe("pending");
    expect(await embeddingStatus("pending-f")).toBe("pending");
    expect(await embeddingStatus("processing-g")).toBe("processing");
  });

  it("an embedding URL change resets the failed embedding items", async () => {
    expect(await setStarmap({ embeddingUrl: "https://embed-other.test/v1" })).toMatchObject({
      success: true,
    });
    expect(await embeddingStatus("failed-e")).toBe("pending");

    await markEmbeddingFailed("failed-e");
    expect(await setStarmap({ embeddingUrl: "https://embed-other.test/v1/" })).toMatchObject({
      success: true,
    });
    expect(await embeddingStatus("failed-e")).toBe("failed");
  });
});

describe("reasoning blocks and extra parameters in the request (HVN-118)", () => {
  it("stripReasoningBlocks removes a leading think block and the whitespace after it", () => {
    const reply = '<think>\nThe chat is about tea.\n</think>\n\n{"title": "Tea"}';
    expect(stripReasoningBlocks(reply)).toBe('{"title": "Tea"}');
  });

  it("stripReasoningBlocks removes a leading thinking block, and repeated leading blocks", () => {
    expect(stripReasoningBlocks('<thinking>plan</thinking>{"a": 1}')).toBe('{"a": 1}');
    expect(stripReasoningBlocks('<think>a</think>\n<thinking>b</thinking>{"x": 1}')).toBe(
      '{"x": 1}',
    );
  });

  it("stripReasoningBlocks leaves a block that is not at the start, and a reply without one", () => {
    expect(stripReasoningBlocks('{"title": "x"}<think>later</think>')).toBe(
      '{"title": "x"}<think>later</think>',
    );
    expect(stripReasoningBlocks('{"title": "x"}')).toBe('{"title": "x"}');
  });

  it("the request body is the defaults, with the extra parameters merged over them", () => {
    expect(buildChatCompletionBody("m", "P", {})).toEqual({
      model: "m",
      messages: [{ role: "user", content: "P" }],
      temperature: 0.3,
      max_tokens: 5000,
    });
    expect(
      buildChatCompletionBody("m", "P", {
        reasoning_effort: "low",
        max_tokens: 1234,
        temperature: 0.9,
        chat_template_kwargs: { enable_thinking: false },
      }),
    ).toMatchObject({
      model: "m",
      reasoning_effort: "low",
      max_tokens: 1234,
      temperature: 0.9,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("the extra parameters cannot replace the model or the messages", () => {
    const body = buildChatCompletionBody("m", "P", {
      model: "hijack",
      messages: [{ role: "system", content: "other" }],
      top_p: 0.5,
    });
    expect(body.model).toBe("m");
    expect(body.messages).toEqual([{ role: "user", content: "P" }]);
    expect(body.top_p).toBe(0.5);
  });

  it("a value that is not a JSON object adds nothing, and an empty model falls back to the default", () => {
    expect(buildChatCompletionBody("", "P", ["x"])).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "P" }],
      temperature: 0.3,
      max_tokens: 5000,
    });
  });

  it("a generation sends the extra parameters, parses the reply after its think block, and never logs their value", async () => {
    const sentinel = "SENTINEL-7731";
    await seedChat("chat-tea");
    await setMetadataConfig({ extraRequestParams: { reasoning_effort: sentinel, max_tokens: 4000 } });

    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const answer = {
        title: "Tea notes",
        description: "About tea.",
        synopsis: "A short talk about tea.",
        categories: [],
        keywords: ["tea"],
      };
      // The reasoning holds a draft object of its own: unstripped, the parser reads that draft
      // first and refuses it, so the answer parses only once the block is removed.
      const reply = `<think>\nThe user asks about tea. A draft: {"title": "Draft"}\n</think>\n\n${JSON.stringify(answer)}`;
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const record = await generateForChat("chat-tea");

    expect(record).toMatchObject({ title: "Tea notes", source: "ai" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "meta-a",
      reasoning_effort: sentinel,
      max_tokens: 4000,
    });
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(JSON.stringify(vi.mocked(log[level]).mock.calls)).not.toContain(sentinel);
    }
    // The names are logged, the values are not.
    expect(JSON.stringify(vi.mocked(log.debug).mock.calls)).toContain("reasoning_effort");
  });
});

it("the stored default for the extra parameters is an empty object", async () => {
  expect((await getMetadataAIConfig()).extraRequestParams).toEqual({});
});
