import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPendingHandoff,
  getPendingHandoffs,
  settlePendingHandoff,
} from "../src/background/bulkSync/pendingHandoffs";
import type { Chat, UserContent } from "../src/model/haevn_model";
import type { GeminiConversationData, GeminiFileInfo } from "../src/providers/gemini/model";
import { transformGeminiToHaevn } from "../src/providers/gemini/transformer";
import { log } from "../src/utils/logger";
import {
  countUnstoredMedia,
  processExternalAssets,
  unstoredMediaCodes,
} from "../src/utils/media_utils";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-159: a download route does the same thing in every context a transform runs in. Gemini's
// uploaded images (lh3.googleusercontent.com/gg/…) were fetched through a helper tab, which the
// bulk-sync Web Worker cannot open: the chat saved, the image stayed a link that answers 403.
// Now the extension fetches it with the Google cookies, in either context, and an image that
// could not be stored is marked on its part and counted.

const UPLOAD = "https://lh3.googleusercontent.com/gg/AbC_dEf-123";
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function conversation(files: GeminiFileInfo[]): GeminiConversationData {
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
        content: "What is this?",
        timestamp: "2024-06-01T09:59:00.000Z",
        localTime: "x",
        role: "user",
        files,
      },
      {
        index: 2,
        content: "A picture.",
        timestamp: "2024-06-01T10:00:00.000Z",
        localTime: "x",
        role: "assistant",
        files: [],
      },
    ],
  };
}

/** The files of the chat's first message, as the parts the transform made of them. */
function userFiles(chat: Chat): UserContent[] {
  const first = Object.values(chat.messages).find((m) => m.message[0].kind === "request");
  const request = first?.message[0];
  if (request?.kind !== "request") throw new Error("expected a request");
  const part = request.parts[0];
  if (part.part_kind !== "user-prompt" || typeof part.content === "string") {
    throw new Error("expected a prompt with files");
  }
  return part.content.filter((c) => typeof c !== "string");
}

function respondWith(status: number, contentType = "image/jpeg") {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(status === 200 ? JPEG_BYTES : "no", {
        status,
        headers: { "content-type": contentType },
      }),
  );
}

let fs: FakeOpfs;

beforeEach(() => {
  fs = new FakeOpfs();
  fs.install();
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a Gemini upload in the bulk-sync worker (a tab id, no chrome.tabs)", () => {
  it("is stored by the extension's own fetch, with the cookies and the full size, and opens nothing", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const postMessage = vi.fn();
    vi.stubGlobal("self", { postMessage });
    vi.stubGlobal("chrome", { runtime: { lastError: null } });
    expect((globalThis.chrome as { tabs?: unknown }).tabs).toBeUndefined();

    const chat = await transformGeminiToHaevn(
      conversation([{ url: UPLOAD, name: "photo.jpg", type: "image/jpeg" }]),
      7,
    );

    const [part] = userFiles(chat);
    expect(part).toMatchObject({ kind: "binary", media_type: "image/jpeg" });
    expect((part as { data: string }).data).toMatch(/^media\/conv-1\/.+_0\.jpg$/);
    expect(fs.size((part as { data: string }).data)).toBe(JPEG_BYTES.length);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${UPLOAD}=s0`);
    expect(fetchSpy.mock.calls[0][1]?.credentials).toBe("include");
    expect(postMessage).not.toHaveBeenCalled();
    expect(countUnstoredMedia(chat)).toBe(0);
  });
});

describe("a Gemini upload in the service worker (chrome.tabs present)", () => {
  it("is stored the same way, and no tab is created or messaged", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const create = vi.fn();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { lastError: null },
      tabs: { create, sendMessage, remove: vi.fn() },
      scripting: { executeScript: vi.fn() },
    });

    const chat = await transformGeminiToHaevn(
      conversation([{ url: UPLOAD, name: "photo.jpg", type: "image/jpeg" }]),
      7,
    );

    const [part] = userFiles(chat);
    expect(part).toMatchObject({ kind: "binary", media_type: "image/jpeg" });
    expect(fs.files()).toHaveLength(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${UPLOAD}=s0`);
    expect(fetchSpy.mock.calls[0][1]?.credentials).toBe("include");
    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("the size a Gemini upload is stored at", () => {
  it("asks for =s0 only on a /gg/ link that names no size", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const sized = `${UPLOAD}=w512`;
    const queried = `${UPLOAD}?authuser=0`;
    const elsewhere = "https://lh3.googleusercontent.com/a/AvatarId";

    await transformGeminiToHaevn(
      conversation([{ url: UPLOAD }, { url: sized }, { url: queried }, { url: elsewhere }]),
    );

    expect(fetchSpy.mock.calls.map(([url]) => url).sort()).toEqual(
      [`${UPLOAD}=s0`, sized, queried, elsewhere].sort(),
    );
  });
});

describe("an image that could not be stored", () => {
  const SECRET_URL = "https://lh3.googleusercontent.com/gg/PathId?k=SECRETQUERY#SECRETFRAGMENT";

  function logged(): string {
    return [log.info, log.warn, log.error]
      .flatMap((spy) => vi.mocked(spy).mock.calls.flat())
      .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg)))
      .join("\n");
  }

  it("stays a link, marked with why, and is counted", async () => {
    vi.stubGlobal("fetch", respondWith(403));

    const chat = await transformGeminiToHaevn(
      conversation([{ url: SECRET_URL, name: "photo.jpg", type: "image/jpeg" }]),
    );

    const [part] = userFiles(chat);
    expect(part).toEqual({
      kind: "image-url",
      url: SECRET_URL,
      vendor_metadata: { unstored: "http_403" },
    });
    expect(countUnstoredMedia(chat)).toBe(1);
    expect(unstoredMediaCodes(chat)).toEqual(["http_403"]);
    expect(fs.files()).toEqual([]);
  });

  it("logs the address as origin and path, never its query or fragment", async () => {
    vi.stubGlobal("fetch", respondWith(403));

    await transformGeminiToHaevn(conversation([{ url: SECRET_URL, type: "image/jpeg" }]));

    const text = logged();
    // the capture is not empty: the failure was logged, with the path every media line carries
    expect(text).toContain("lh3.googleusercontent.com/gg/PathId");
    expect(text).not.toContain("SECRETQUERY");
    expect(text).not.toContain("SECRETFRAGMENT");
  });

  it("carries a code for each way a download ends", async () => {
    const run = async (setup: () => void, extra: Record<string, unknown> = {}) => {
      setup();
      const [part] = await processExternalAssets([{ url: UPLOAD, type: "image/jpeg" }], {
        chatId: "c",
        messageId: "m",
        retries: 0,
        logPrefix: "[test]",
        ...extra,
      });
      return part;
    };
    const code = (part: UserContent) => (part as { vendor_metadata?: unknown }).vendor_metadata;

    expect(code(await run(() => vi.stubGlobal("fetch", respondWith(404))))).toEqual({
      unstored: "http_404",
    });
    expect(
      code(
        await run(() =>
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
              throw new TypeError("Failed to fetch");
            }),
          ),
        ),
      ),
    ).toEqual({ unstored: "fetch_failed" });
    expect(
      code(
        await run(
          () =>
            vi.stubGlobal(
              "fetch",
              vi.fn(() => new Promise(() => {})),
            ),
          {
            overallTimeoutMs: 20,
          },
        ),
      ),
    ).toEqual({ unstored: "timeout" });
    expect(
      code(
        await run(() => {
          vi.stubGlobal("fetch", respondWith(200));
          fs.failures.writableWriteThrows = true;
          fs.failures.syncWriteThrows = true;
        }),
      ),
    ).toEqual({ unstored: "save_failed" });
  });

  it("writes no file for a download that loses the timeout race, and counts its link once (HVN-160)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // the download outlives the overall timeout, and cannot be cancelled
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
      }),
    );

    const [part] = await processExternalAssets([{ url: UPLOAD, type: "image/jpeg" }], {
      chatId: "c",
      messageId: "m",
      retries: 0,
      overallTimeoutMs: 20,
      logPrefix: "[test]",
    });
    expect(part).toEqual({
      kind: "image-url",
      url: UPLOAD,
      vendor_metadata: { unstored: "timeout" },
    });
    expect(countUnstoredMedia({ parts: [part] })).toBe(1);

    // past the end of the download: it has finished, and would have written its file by now
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.files()).toEqual([]);
  });

  it("marks a page's blob: link without fetching it: the extension cannot reach it", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);

    const chat = await transformGeminiToHaevn(
      conversation([{ url: "blob:https://gemini.google.com/0000", type: "image/png" }]),
    );

    expect(userFiles(chat)[0]).toMatchObject({
      kind: "image-url",
      vendor_metadata: { unstored: "fetch_failed" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is not marked when the caller reads only (media: skip), and writes nothing", async () => {
    const fetchSpy = respondWith(403);
    vi.stubGlobal("fetch", fetchSpy);

    const [part] = await processExternalAssets([{ url: UPLOAD, type: "image/jpeg" }], {
      chatId: "c",
      messageId: "m",
      media: "skip",
    });

    expect(part).toEqual({ kind: "image-url", url: UPLOAD });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is not marked when an earlier sync's file is kept instead", async () => {
    const options = { chatId: "c", messageId: "m", retries: 0, logPrefix: "[test]" };
    vi.stubGlobal("fetch", respondWith(200));
    await processExternalAssets([{ url: UPLOAD, type: "image/jpeg" }], options);

    vi.stubGlobal("fetch", respondWith(403));
    const [part] = await processExternalAssets([{ url: UPLOAD, type: "image/jpeg" }], options);

    expect(part).toMatchObject({ kind: "binary" });
    expect(unstoredMediaCodes(part)).toEqual([]);
  });
});

describe("a link kept on purpose (linkOnly)", () => {
  it("is not fetched, marked or counted, and the other files keep their place", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);

    const chat = await transformGeminiToHaevn(
      conversation([
        { url: "https://encrypted-tbn0.gstatic.com/images?q=tbn:SECRET", type: "image/jpeg" },
        { url: UPLOAD, type: "image/jpeg" },
        { url: "https://i.ytimg.com/vi/x/hq.jpg", type: "image/jpeg" },
      ]),
    );

    const parts = userFiles(chat);
    expect(parts[0]).toEqual({
      kind: "image-url",
      url: "https://encrypted-tbn0.gstatic.com/images?q=tbn:SECRET",
    });
    expect(parts[2]).toEqual({ kind: "image-url", url: "https://i.ytimg.com/vi/x/hq.jpg" });
    // the upload is the second file, so it is stored at index 1, as it was before linkOnly
    expect(parts[1]).toMatchObject({ kind: "binary" });
    expect((parts[1] as { data: string }).data).toMatch(/_1\.jpg$/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${UPLOAD}=s0`);
    expect(countUnstoredMedia(chat)).toBe(0);
  });

  it("never sends credentials to a host that only looks like Google's", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const lookalikes = [
      "https://lh3.googleusercontent.com.evil.test/gg/abc",
      "https://lh3.googleusercontent.com@evil.test/gg/abc",
      "https://evil.test/lh3.googleusercontent.com/gg/abc",
      "https://evil-googleusercontent.com/gg/abc",
    ];

    const chat = await transformGeminiToHaevn(
      conversation(lookalikes.map((url) => ({ url, type: "image/jpeg" }))),
    );

    expect(userFiles(chat)).toEqual(lookalikes.map((url) => ({ kind: "image-url", url })));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches only https://lh3.googleusercontent.com: every other host, and http:, is a link (HVN-160)", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const links = [
      // a real Google host, but not the one that answers with the upload
      "https://drive-thirdparty.googleusercontent.com/gg/AbC",
      "https://lh4.googleusercontent.com/gg/AbC",
      "https://googleusercontent.com/gg/AbC",
      // the redirect hop, named as a file: its cookies are for the chain, not for a file
      "https://lh3.google.com/rd-gg/AbC",
      // the right host over the wrong scheme
      "http://lh3.googleusercontent.com/gg/AbC",
      // no scheme and no host: nothing the extension can fetch
      "lh3.googleusercontent.com/gg/AbC",
    ];

    const chat = await transformGeminiToHaevn(
      conversation(links.map((url) => ({ url, type: "image/jpeg" }))),
    );

    expect(userFiles(chat)).toEqual(links.map((url) => ({ kind: "image-url", url })));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(countUnstoredMedia(chat)).toBe(0);
  });

  it("logs the host, and not the address, of a link kept on another Google host (HVN-169)", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);
    const signed =
      "https://drive-thirdparty.googleusercontent.com/gg/AbC_SIGNED?token=SECRETQUERY#SECRETFRAGMENT";

    await transformGeminiToHaevn(
      conversation([
        { url: signed, type: "image/jpeg" },
        { url: UPLOAD, type: "image/jpeg" },
      ]),
    );

    // one line names the kept link's host, and it names no path and no query
    const infoLines = vi
      .mocked(log.info)
      .mock.calls.flat()
      .map((arg) => String(arg));
    const hostLines = infoLines.filter((line) => line.includes("drive-thirdparty"));
    expect(hostLines).toHaveLength(1);
    expect(hostLines[0]).toContain("drive-thirdparty.googleusercontent.com");
    expect(hostLines[0]).not.toContain("/gg/");
    // and no line of any level carries the address's path or query, the upload's own lines included
    const everything = [log.info, log.warn, log.error]
      .flatMap((spy) => vi.mocked(spy).mock.calls.flat())
      .map((arg) => String(arg))
      .join("\n");
    expect(everything).not.toContain("AbC_SIGNED");
    expect(everything).not.toContain("SECRET");
    // the upload on lh3 is still fetched: the new line is for the other host only
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("is not fetched, marked or counted by the generic caller either", async () => {
    const fetchSpy = respondWith(200);
    vi.stubGlobal("fetch", fetchSpy);

    const parts = await processExternalAssets(
      [{ url: "https://example.test/a.png", type: "image/png", linkOnly: true }],
      { chatId: "c", messageId: "m" },
    );

    expect(parts).toEqual([{ kind: "image-url", url: "https://example.test/a.png" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.files()).toEqual([]);
  });
});

describe("the manifest", () => {
  it("lets the extension reach both hops of Gemini's image links, and no other googleusercontent host (HVN-160)", () => {
    const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));

    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(["*://lh3.googleusercontent.com/*", "*://lh3.google.com/*"]),
    );
    // the wide pattern granted every googleusercontent subdomain to the extension's fetches
    expect(manifest.host_permissions).not.toContain("*://*.googleusercontent.com/*");
  });
});

describe("the run's count of media not stored", () => {
  it("adds up two reports settled at the same moment", async () => {
    await Promise.all([settlePendingHandoff("c1", 2), settlePendingHandoff("c2", 3)]);

    expect((await getPendingHandoffs()).unstoredMedia).toBe(5);
  });

  it("survives the hand-off of the next chat, which the tick makes while reports come in", async () => {
    await addPendingHandoff("c1");
    await settlePendingHandoff("c1", 2);
    await addPendingHandoff("c2");
    await settlePendingHandoff("c2", 1);

    expect((await getPendingHandoffs()).unstoredMedia).toBe(3);
  });

  it("is not changed by a report that has none", async () => {
    await settlePendingHandoff("c1", 4);
    await settlePendingHandoff("c2");

    expect((await getPendingHandoffs()).unstoredMedia).toBe(4);
  });
});
