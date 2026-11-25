import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadUrlAttachment } from "../src/formatters";
import type { BinaryContent, ImageResponsePart } from "../src/model/haevn_model";
import {
  extractGeminiConversationTitle,
  extractGeminiMessages,
} from "../src/providers/gemini/extractor";
import type { GeminiConversationData } from "../src/providers/gemini/model";
import { transformGeminiToHaevn } from "../src/providers/gemini/transformer";
import { saveChat } from "../src/services/chatPersistence";
import { getDB } from "../src/services/db";
import { log } from "../src/utils/logger";
import { processExternalAssets } from "../src/utils/media_utils";
import { originAndPath } from "../src/utils/network_utils";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-158: a Gemini generated image is a `blob:` the page made, and it was never stored (the bulk
// sync transforms in a Web Worker, which has no tab to open); its markdown stayed in the text; and
// the screen reader's "You said" label came in with every prompt and every title.

// ─── A page, as a real DOM (domino, the one turndown brings) ─────────────────────────────────

function domOf(html: string): Document {
  const req = createRequire(createRequire(import.meta.url).resolve("turndown"));
  const win = req("@mixmark-io/domino").createWindow(html, "https://gemini.google.com/app/abc");
  // domino answers a query by a tag name with a live list that has no forEach and no iterator
  const list = Object.getPrototypeOf(win.document.body.querySelectorAll("img"));
  list.forEach ??= Array.prototype.forEach;
  list[Symbol.iterator] ??= Array.prototype[Symbol.iterator];
  return win.document;
}

const BLOB_A = "blob:https://gemini.google.com/00000000-0000-0000-0000-00000000000a";
const BLOB_B = "blob:https://gemini.google.com/00000000-0000-0000-0000-00000000000b";

// A real 1x1 PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const USER_TURN = (prompt: string) => `
  <user-query><span class="user-query-container"><div class="query-content">
    <div class="query-text">
      <h5 class="cdk-visually-hidden screen-reader-user-query-label"><span>You said</span> ${prompt}<!----></h5>
      <p class="query-text-line">${prompt}</p>
    </div>
  </div></span></user-query>`;

const GENERATED_IMAGE = (src: string) => `
  <div class="attachment-container generated-images"><response-element><generated-image>
    <single-image><div class="image-container"><div class="overlay-container"><button>
      <img class="image loaded" alt=", AI generated" src="${src}">
    </button></div></div></single-image>
  </generated-image></response-element></div>`;

const MODEL_TURN = (...blobs: string[]) => `
  <model-response><message-content class="model-response-text"><div class="markdown">
    <p>Here is the picture.</p>${blobs.map(GENERATED_IMAGE).join("")}
  </div></message-content></model-response>`;

/** The page's images count as loaded, and a canvas draws each as `pixels` (a data URL). */
function pageWith(html: string, pixels: string | null = PNG_DATA_URL): Document {
  const doc = domOf(`<body>${html}</body>`);
  for (const img of Array.from(doc.querySelectorAll("img")) as unknown as HTMLImageElement[]) {
    // domino resolves `src` against the page, and Chrome keeps a blob URL as it is
    Object.defineProperty(img, "src", { value: img.getAttribute("src") });
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 1024 });
    Object.defineProperty(img, "naturalHeight", { value: 1024 });
  }
  const createElement = doc.createElement.bind(doc);
  doc.createElement = ((tag: string) => {
    if (tag !== "canvas") return createElement(tag);
    return {
      width: 0,
      height: 0,
      getContext: () => (pixels === null ? null : { drawImage: () => {} }),
      toDataURL: (type: string) => {
        expect(type).toBe("image/png");
        return pixels;
      },
    };
  }) as typeof doc.createElement;
  return doc;
}

/** Run `run` with `doc` as the page, and put back what was there. */
async function withPage<T>(doc: Document, run: () => Promise<T> | T): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const before = ["document", "window"].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]);
  Object.defineProperty(g, "document", { value: doc, configurable: true, writable: true });
  Object.defineProperty(g, "window", {
    value: { location: { pathname: "/app/abc", href: doc.URL } },
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    for (const [k, d] of before as [string, PropertyDescriptor | undefined][]) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

async function extract(doc: Document) {
  return await withPage(doc, () => extractGeminiMessages());
}

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the extractor, on a page with a generated image", () => {
  it("carries the image as a data URL of its pixels, and no blob URL", async () => {
    const [, assistant] = await extract(pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A)));

    expect(assistant.files).toEqual([
      { url: PNG_DATA_URL, name: ", AI generated", type: "image/png" },
    ]);
  });

  it("leaves the image out of the message text", async () => {
    const [, assistant] = await extract(pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A)));

    expect(assistant.content).toBe("Here is the picture.");
    expect(assistant.content).not.toContain("![");
    expect(assistant.content).not.toContain("blob:");
  });

  it("treats any other blob image the same way", async () => {
    const stray = `<p>Look: <img alt="x" src="${BLOB_A}"></p>`;
    const [, assistant] = await extract(
      pageWith(
        USER_TURN("Draw it") +
          MODEL_TURN().replace("</div></message-content>", `${stray}</div></message-content>`),
      ),
    );

    expect(assistant.files.map((f) => f.url)).toEqual([PNG_DATA_URL]);
    expect(assistant.content).toBe("Here is the picture.\n\nLook:");
  });

  it("keeps the blob URL as the file when the pixels cannot be read, and still leaves it out of the text", async () => {
    const [, assistant] = await extract(
      pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A), null), // no 2D context
    );

    expect(assistant.files.map((f) => f.url)).toEqual([BLOB_A]);
    expect(assistant.content).not.toContain("![");
  });

  it("stops inlining when the chat's images would not fit one message", async () => {
    const big = `data:image/png;base64,${"A".repeat(15 * 1024 * 1024)}`;
    const [, assistant] = await extract(
      pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A, BLOB_B), big),
    );

    // the first fits the 28M-character budget, the second (30M together) does not: it keeps its blob URL
    expect(assistant.files.map((f) => f.url.slice(0, 10))).toEqual(["data:image", "blob:https"]);
  });

  it("keeps the blob URL when the canvas is past the browser's size limit (it answers data:,)", async () => {
    const [, assistant] = await extract(
      pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A), "data:,"),
    );

    expect(assistant.files.map((f) => f.url)).toEqual([BLOB_A]);
  });

  it("does not wait on an image that never decodes", async () => {
    vi.useFakeTimers();
    try {
      const doc = pageWith(USER_TURN("Draw it") + MODEL_TURN(BLOB_A));
      const img = doc.querySelector("generated-image img") as unknown as HTMLImageElement;
      Object.defineProperty(img, "complete", { value: false, configurable: true });
      Object.defineProperty(img, "decode", { value: () => new Promise(() => {}) });

      const extraction = extract(doc);
      await vi.advanceTimersByTimeAsync(6000);
      const [, assistant] = await extraction;

      expect(assistant.files.map((f) => f.url)).toEqual([BLOB_A]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a remote image's URL alone", async () => {
    const remote = "https://lh3.googleusercontent.com/gg/abc";
    const [, assistant] = await extract(pageWith(USER_TURN("Draw it") + MODEL_TURN(remote)));

    expect(assistant.files.map((f) => f.url)).toEqual([remote]);
  });
});

describe("the extractor, on a user turn", () => {
  it("holds the prompt once, without the screen reader's label", async () => {
    const [user] = await extract(pageWith(USER_TURN("Make it wider") + MODEL_TURN()));

    expect(user.content).toBe("Make it wider");
    expect(user.content).not.toContain("You said");
  });

  it("does not take the label for the title", async () => {
    const doc = pageWith(USER_TURN("Make it wider") + MODEL_TURN());

    expect(await withPage(doc, () => extractGeminiConversationTitle())).toBe("Make it wider");
  });
});

// ─── The transformer and the download ────────────────────────────────────────────────────────

describe("a data: image in a bulk sync (a Web Worker: a tab id, and no chrome.tabs)", () => {
  let fs: FakeOpfs;

  beforeEach(() => {
    fs = new FakeOpfs();
    fs.install();
  });

  function chatWithImage(url: string): GeminiConversationData {
    return {
      platform: "gemini",
      url: "https://gemini.google.com/app/abc",
      conversationId: "conv-1",
      title: "Pictures",
      messageCount: 2,
      extractedAt: "2024-06-01T10:00:00.000Z",
      messages: [
        {
          index: 1,
          content: "Draw it",
          timestamp: "2024-06-01T09:59:00.000Z",
          localTime: "x",
          role: "user",
          files: [],
        },
        {
          index: 2,
          content: "Here is the picture.",
          timestamp: "2024-06-01T10:00:00.000Z",
          localTime: "x",
          role: "assistant",
          files: [{ url, name: ", AI generated", type: "image/png" }],
        },
      ],
    };
  }

  it("is stored as a binary part with a media path", async () => {
    expect((globalThis.chrome as { tabs?: unknown }).tabs).toBeUndefined();

    const chat = await transformGeminiToHaevn(chatWithImage(PNG_DATA_URL), 7);

    const response = chat.messages[chat.currentId].message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    const image = response.parts.find(
      (p): p is ImageResponsePart => p.part_kind === "image-response",
    );
    const content = image?.content as BinaryContent;
    expect(content.kind).toBe("binary");
    expect(content.data).toMatch(/^media\/conv-1\/.+_0\.png$/);
    expect(content.media_type).toBe("image/png");
    expect(content.vendor_metadata).toMatchObject({ storageType: "opfs", size: PNG_BYTES.length });
    // the file holds the picture's bytes
    expect(fs.files()).toEqual([content.data]);
    expect(fs.size(content.data)).toBe(PNG_BYTES.length);
  });

  it("does not store a dead blob URL's text: a blob that reached it is the old fallback", async () => {
    const chat = await transformGeminiToHaevn(chatWithImage(BLOB_A), 7);

    const response = chat.messages[chat.currentId].message[0];
    if (response.kind !== "response") throw new Error("expected a response");
    const image = response.parts.find(
      (p): p is ImageResponsePart => p.part_kind === "image-response",
    );
    expect(image?.content).toMatchObject({ kind: "image-url", url: BLOB_A });
    expect(fs.files()).toEqual([]);
  });
});

describe("processExternalAssets with a data: URL", () => {
  let fs: FakeOpfs;
  const run = (url: string, type?: string, extra: Record<string, unknown> = {}) =>
    processExternalAssets([{ url, type }], {
      chatId: "c1",
      messageId: "m1",
      tabId: 3,
      logPrefix: "[test]",
      ...extra,
    });

  beforeEach(() => {
    fs = new FakeOpfs();
    fs.install();
  });

  it("takes the type the URL declares over the asset's hint", async () => {
    const [part] = await run(`data:image/webp;base64,${PNG_BASE64}`, "image");

    expect(part).toMatchObject({ kind: "binary", media_type: "image/webp" });
    expect(fs.files()).toEqual(["media/c1/m1_0.webp"]);
  });

  it("decodes one that is not base64", async () => {
    await run("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", "image");

    expect(fs.text("media/c1/m1_0.svg")).toBe("<svg></svg>");
  });

  it("falls back to the URL when it is malformed", async () => {
    const [part] = await run("data:image/png;base64", "image/png");

    expect(part).toMatchObject({ kind: "image-url" });
    expect(fs.files()).toEqual([]);
  });

  it("writes nothing and keeps the URL for a read-only caller", async () => {
    const [part] = await run(PNG_DATA_URL, "image/png", { media: "skip" });

    expect(part).toMatchObject({ kind: "image-url", url: PNG_DATA_URL });
    expect(fs.files()).toEqual([]);
  });

  it("logs its type and not its content", () => {
    expect(originAndPath(PNG_DATA_URL)).toBe("data:image/png");
    expect(originAndPath("data:,hello")).toBe("data:");
  });
});

describe("an image kept as a data: URL after a failed save (the fallback)", () => {
  it("is exported whole, whatever its size (a base64 of a buffer past the stack's reach)", async () => {
    const bytes = new Uint8Array(1_500_000).map((_, i) => i % 251);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    const base64 = btoa(binary);

    const downloaded = await downloadUrlAttachment(`data:image/png;base64,${base64}`, "image/png");

    expect(downloaded).toMatchObject({ kind: "binary", media_type: "image/png" });
    expect((downloaded as BinaryContent).data).toBe(base64);
  });
});

describe("a re-sync over a chat that kept a broken image part", () => {
  it("leaves one image part, the stored one", async () => {
    const fs = new FakeOpfs();
    fs.install();
    const chatWith = (url: string): GeminiConversationData => ({
      platform: "gemini",
      url: "https://gemini.google.com/app/resync",
      conversationId: "resync-1",
      title: "Pictures",
      messageCount: 2,
      extractedAt: "2024-06-01T10:00:00.000Z",
      messages: [
        {
          index: 1,
          content: "Draw it",
          timestamp: "2024-06-01T09:59:00.000Z",
          localTime: "x",
          role: "user",
          files: [],
        },
        {
          index: 2,
          content: "Here is the picture.",
          timestamp: "2024-06-01T10:00:00.000Z",
          localTime: "x",
          role: "assistant",
          files: [{ url, name: ", AI generated", type: "image/png" }],
        },
      ],
    });
    const imageParts = async () => {
      const rows = await getDB().chatMessages.where("chatId").equals("resync-1").toArray();
      return rows.flatMap((row) =>
        row.message.flatMap((m) =>
          m.kind === "response"
            ? m.parts.filter((p) => p.part_kind === "image-response").map((p) => p.content)
            : [],
        ),
      );
    };

    // the first sync, as it ran before the fix: the blob could not be stored
    await saveChat(await transformGeminiToHaevn(chatWith(BLOB_A), 7), {});
    expect(await imageParts()).toMatchObject([{ kind: "image-url", url: BLOB_A }]);

    await saveChat(await transformGeminiToHaevn(chatWith(PNG_DATA_URL), 7), {});

    expect(await imageParts()).toMatchObject([{ kind: "binary", media_type: "image/png" }]);
  });
});
