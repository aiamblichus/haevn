import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchChatGPTConversation } from "../src/providers/chatgpt/extractor";
import type {
  ChatGPTRawExtraction,
  OpenAIConversation,
  OpenAIConversationNode,
} from "../src/providers/chatgpt/model";
import { chatgptProvider } from "../src/providers/chatgpt/provider";
import { transformOpenAIToHaevn } from "../src/providers/chatgpt/transformer";
import { log } from "../src/utils/logger";
import * as network from "../src/utils/network_utils";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-123: a ChatGPT chat with many large images did not sync, because the content script
// downloaded every image and returned the chat and all the bytes in one message, and Chrome stops a
// message at 64 MiB. The extraction now returns a reference per image (stage 1 of the download, a
// few hundred bytes each); the transformer downloads each image on its own, one message per image,
// into OPFS.

// The rate limiter is not what these tests are about, and it would make them wait in real time.
vi.mock("../src/utils/rateLimit", () => ({
  RateLimiter: class {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));

const MIB = 1024 * 1024;
const CHAT = "chat-gpt-1";

let fs: FakeOpfs;

beforeEach(() => {
  fs = new FakeOpfs();
  fs.install();
  vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: `/c/${CHAT}` });
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pointerOf(i: number): string {
  // both spellings the web returns
  return i % 2 === 0 ? `file-service://file-${i}` : `sediment://file_${i}`;
}

function node(id: string, parent: string | null, role: string, pointers: string[]) {
  return {
    id,
    parent,
    children: [] as string[],
    message: {
      id,
      author: { role },
      create_time: 1_700_000_000,
      update_time: 1_700_000_000,
      content: {
        content_type: "multimodal_text",
        parts: [
          ...pointers.map((asset_pointer) => ({
            content_type: "image_asset_pointer",
            asset_pointer,
            size_bytes: 4 * MIB,
            width: 1,
            height: 1,
          })),
          `text of ${id}`,
        ],
      },
      status: "finished_successfully",
      end_turn: true,
      weight: 1,
      metadata: { model_slug: "gpt-5" },
      recipient: "all",
      channel: null,
    },
  };
}

/** A chain of messages, each with the given pointers; a user message first. */
function conversation(perMessage: string[][]): OpenAIConversation {
  const mapping: Record<string, unknown> = {
    root: { id: "root", message: null, parent: null, children: ["m0"] },
  };
  perMessage.forEach((pointers, i) => {
    const id = `m${i}`;
    const built = node(
      id,
      i === 0 ? "root" : `m${i - 1}`,
      i % 2 === 0 ? "user" : "assistant",
      pointers,
    );
    if (i < perMessage.length - 1) built.children = [`m${i + 1}`];
    mapping[id] = built;
  });
  return {
    id: CHAT,
    conversation_id: CHAT,
    title: "A chat with images",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: `m${perMessage.length - 1}`,
    mapping: mapping as Record<string, OpenAIConversationNode>,
    moderation_results: [],
    is_archived: false,
    is_starred: null,
    is_do_not_remember: null,
    safe_urls: [],
    blocked_urls: [],
  } as unknown as OpenAIConversation;
}

function signedUrl(pointer: string): string {
  return `https://files.example.test/${encodeURIComponent(pointer)}?sig=abc`;
}

function refsFor(pointers: string[]): NonNullable<ChatGPTRawExtraction["assetRefs"]> {
  return Object.fromEntries(
    pointers.map((pointer) => [
      pointer,
      { downloadUrl: signedUrl(pointer), contentType: "image/png", filename: "a.png" },
    ]),
  );
}

describe("the extraction returns references, not bytes", () => {
  function stageOneServer(
    conv: OpenAIConversation,
    answer: (url: string) => Response | undefined = () => undefined,
  ) {
    return vi.spyOn(network, "fetchWithTimeout").mockImplementation(async (url) => {
      const given = answer(url);
      if (given) return given;
      if (url.includes("/backend-api/conversation/")) return Response.json(conv);
      const file = decodeURIComponent(url.split("/files/download/")[1].split("?")[0]);
      return Response.json({
        download_url: `https://files.example.test/${file}?sig=abc`,
        file_name: "photo.png",
        mime_type: "image/png",
      });
    });
  }

  it("asks for each image's signed URL and downloads none of them", async () => {
    const pointers = Array.from({ length: 24 }, (_, i) => pointerOf(i));
    const conv = conversation(pointers.map((p) => [p]));
    const fetched = stageOneServer(conv);

    const raw = await fetchChatGPTConversation("token", CHAT);

    // every request went to the API (the conversation, then stage 1 of each image); none to the
    // signed host, so no image bytes were read here
    const urls = fetched.mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(1 + pointers.length);
    expect(urls.every((url) => url.startsWith("https://chatgpt.com/backend-api/"))).toBe(true);
    // both spellings keep their own query
    expect(urls.some((url) => url.includes("file_1?conversation_id=chat-gpt-1&inline=false"))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes("file-0?post_id=&inline=false"))).toBe(true);

    expect(raw.assets).toEqual({});
    expect(Object.keys(raw.assetRefs ?? {}).sort()).toEqual([...pointers].sort());
    expect(raw.assetRefs?.[pointers[0]]).toEqual({
      downloadUrl: "https://files.example.test/file-0?sig=abc",
      contentType: "image/png",
      filename: "photo.png",
    });
    expect(JSON.stringify(raw).includes("dataBase64")).toBe(false);
  });

  it("leaves out an image whose stage 1 failed, and one that came back without a URL", async () => {
    const pointers = [pointerOf(0), pointerOf(1), pointerOf(2)];
    const conv = conversation([pointers]);
    stageOneServer(conv, (url) => {
      if (url.includes("file-0")) return new Response("gone", { status: 404 });
      if (url.includes("file_1")) return Response.json({ status: "error" });
      return undefined;
    });

    const raw = await fetchChatGPTConversation("token", CHAT);

    expect(Object.keys(raw.assetRefs ?? {})).toEqual([pointers[2]]);
  });
});

describe("the transformer downloads each image on its own", () => {
  const BYTES = 4 * MIB;
  const BIG_BASE64 = Buffer.alloc(BYTES, 7).toString("base64");

  /** A tab that answers every fetchBlob with one image, and keeps what was sent and answered. */
  function tabServing(answer: (url: string) => Record<string, unknown>) {
    const requests: Record<string, unknown>[] = [];
    const responses: Record<string, unknown>[] = [];
    const sendMessage = vi.fn(
      (_tabId: number, message: Record<string, unknown>, callback: (r: unknown) => void) => {
        requests.push(message);
        const response = answer(message.url as string);
        responses.push(response);
        queueMicrotask(() => callback(response));
      },
    );
    vi.stubGlobal("chrome", {
      ...(globalThis as { chrome: object }).chrome,
      tabs: { sendMessage },
      runtime: { lastError: undefined },
    });
    return { sendMessage, requests, responses };
  }

  const image = () => ({ success: true, base64: BIG_BASE64, contentType: "image/png" });

  it("syncs a chat whose images are past 64 MiB together, with one asset per message", async () => {
    // 12 messages with 2 images each: 24 x 4 MiB = 96 MiB of images
    const perMessage = Array.from({ length: 12 }, (_, m) => [
      pointerOf(2 * m),
      pointerOf(2 * m + 1),
    ]);
    const all = perMessage.flat();
    const conv = conversation(perMessage);
    const raw: ChatGPTRawExtraction = { conversation: conv, assets: {}, assetRefs: refsFor(all) };
    const tab = tabServing(image);

    // what the content script would send for the chat: nothing near the limit
    expect(JSON.stringify(raw).length).toBeLessThan(MIB);

    const [chat] = await chatgptProvider.transformer.transform(raw, 7, {});

    // each image was asked for, once, in a message of its own
    expect(tab.requests).toHaveLength(all.length);
    expect(new Set(tab.requests.map((r) => r.url))).toEqual(new Set(all.map(signedUrl)));
    for (const request of tab.requests) {
      expect(Object.keys(request).sort()).toEqual(["action", "credentials", "url"]);
      expect(request.action).toBe("fetchBlob");
      // the page's own default: no cookies sent to the signed host
      expect(request.credentials).toBe("same-origin");
    }
    // the images together are past the limit, and no message carries more than one
    const sizes = tab.responses.map((r) => JSON.stringify(r).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(64 * MIB);
    expect(Math.max(...sizes)).toBeLessThan(64 * MIB);
    expect(tab.responses.every((r) => typeof r.base64 === "string")).toBe(true);

    // every image is in OPFS under its message, and the chat holds paths, not bytes
    expect(fs.files()).toHaveLength(all.length);
    expect(fs.has(`media/${CHAT}/m0_0.png`)).toBe(true);
    expect(fs.has(`media/${CHAT}/m11_1.png`)).toBe(true);
    expect(fs.size(`media/${CHAT}/m5_1.png`)).toBe(BYTES);
    expect(JSON.stringify(chat).length).toBeLessThan(MIB);
    const user = chat.messages.m0.message[0];
    expect(user).toMatchObject({
      kind: "request",
      parts: [
        {
          part_kind: "user-prompt",
          content: [
            "text of m0",
            {
              kind: "binary",
              data: `media/${CHAT}/m0_0.png`,
              media_type: "image/png",
              identifier: "a.png",
              vendor_metadata: { storageType: "opfs", size: BYTES },
            },
            { kind: "binary", data: `media/${CHAT}/m0_1.png` },
          ],
        },
      ],
    });
    // an assistant message shows its images as image responses
    const assistant = chat.messages.m1.message[0];
    expect(assistant).toMatchObject({
      kind: "response",
      parts: [
        { part_kind: "text", content: "text of m1" },
        {
          part_kind: "image-response",
          content: { kind: "binary", data: `media/${CHAT}/m1_0.png` },
        },
        {
          part_kind: "image-response",
          content: { kind: "binary", data: `media/${CHAT}/m1_1.png` },
        },
      ],
    });
  }, 120_000);

  it("fetches a pointer used twice in a message once", async () => {
    const pointer = pointerOf(0);
    const raw: ChatGPTRawExtraction = {
      conversation: conversation([[pointer, pointer]]),
      assets: {},
      assetRefs: refsFor([pointer]),
    };
    const tab = tabServing(() => ({ success: true, base64: "AAAA", contentType: "image/png" }));

    const [chat] = await chatgptProvider.transformer.transform(raw, 7, {});

    expect(tab.requests).toHaveLength(1);
    const parts = (chat.messages.m0.message[0] as { parts: { content: unknown[] }[] }).parts;
    expect(parts[0].content).toMatchObject(["text of m0", { kind: "binary" }, { kind: "binary" }]);
  });

  it("keeps the file an earlier sync stored when the download fails, and links the one it never had", async () => {
    const [a, b, c] = [pointerOf(0), pointerOf(1), pointerOf(2)];
    // c has no reference: stage 1 failed at extraction
    const raw: ChatGPTRawExtraction = {
      conversation: conversation([[a, b, c]]),
      assets: {},
      assetRefs: refsFor([a, b]),
    };
    fs.put(`media/${CHAT}/m0_0.png`, "the picture from last time");
    tabServing(() => ({ success: false, error: "HTTP 403 Forbidden" }));

    const [chat] = await chatgptProvider.transformer.transform(raw, 7, {});

    const content = (chat.messages.m0.message[0] as { parts: { content: unknown[] }[] }).parts[0]
      .content;
    expect(content).toMatchObject([
      `[Image not found: ${c}]\ntext of m0`,
      {
        kind: "binary",
        data: `media/${CHAT}/m0_0.png`,
        vendor_metadata: { storageType: "opfs", size: "the picture from last time".length },
      },
      { kind: "image-url", url: signedUrl(b) },
    ]);
    // nothing new was written
    expect(fs.files()).toEqual([`media/${CHAT}/m0_0.png`]);
  });

  it("without a tab downloads from the extension, with the same credentials", async () => {
    const pointer = pointerOf(0);
    const raw: ChatGPTRawExtraction = {
      conversation: conversation([[pointer]]),
      assets: {},
      assetRefs: refsFor([pointer]),
    };
    const fetched = vi
      .spyOn(network, "fetchWithTimeout")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }),
      );

    const [chat] = await chatgptProvider.transformer.transform(raw, undefined, {});

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0][0]).toBe(signedUrl(pointer));
    expect(fetched.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
    expect(fs.files()).toEqual([`media/${CHAT}/m0_0.webp`]);
    expect(JSON.stringify(chat)).toContain(`media/${CHAT}/m0_0.webp`);
  });
});

describe("an extraction with bytes (the ZIP importer's) is not downloaded", () => {
  it("keeps the inline image as it did, and a transform of it reaches for nothing", async () => {
    const pointer = pointerOf(0);
    const raw: ChatGPTRawExtraction = {
      conversation: conversation([[pointer]]),
      assets: { [pointer]: { dataBase64: "QUJD", contentType: "image/png", filename: "x.png" } },
    };
    const fetched = vi.spyOn(network, "fetchWithTimeout");

    const chat = transformOpenAIToHaevn(raw);
    const [viaProvider] = await chatgptProvider.transformer.transform(raw, 7, {});

    for (const c of [chat, viaProvider]) {
      expect(c.messages.m0.message[0]).toMatchObject({
        parts: [
          {
            content: [
              "text of m0",
              { kind: "binary", data: "QUJD", media_type: "image/png", identifier: "x.png" },
            ],
          },
        ],
      });
    }
    expect(fetched).not.toHaveBeenCalled();
    expect(fs.files()).toEqual([]);
  });
});
