import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BinaryContent } from "../src/model/haevn_model";
import { getMediaStorageService } from "../src/services/mediaStorage";
import { log } from "../src/utils/logger";
import { processExternalAssets } from "../src/utils/media_utils";
import * as network from "../src/utils/network_utils";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-94: a re-sync that cannot download an asset again keeps the file an earlier sync stored at
// the stable path `media/{chat}/{message}_{index}.{ext}`. Only when there is none does the message
// fall back to the remote URL. Every provider's download goes through processExternalAssets.

let fs: FakeOpfs;

const CHAT = "chat-1";
const MSG = "msg-1";
const URL_A = "https://cdn.example/a.png";
const URL_B = "https://cdn.example/b.png";
const OLD_BYTES = "old picture";
const NEW_BYTES = new Uint8Array([9, 9, 9, 9]);

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

function downloadFails(how: "reject" | "404" = "reject") {
  return vi.spyOn(network, "fetchWithTimeout").mockImplementation(async () => {
    if (how === "reject") throw new Error("The operation timed out");
    return new Response("nope", { status: 404, statusText: "Not Found" });
  });
}

function downloadSucceeds(contentType = "image/png") {
  return vi.spyOn(network, "fetchWithTimeout").mockImplementation(
    async () =>
      new Response(NEW_BYTES, {
        status: 200,
        headers: { "content-type": contentType },
      }),
  );
}

function run(urls: string[], extra: Record<string, unknown> = {}, type = "image/png") {
  return processExternalAssets(
    urls.map((url) => ({ url, type })),
    {
      chatId: CHAT,
      messageId: MSG,
      logPrefix: "[test]",
      retries: 0,
      retryDelayMs: 0,
      ...extra,
    },
  );
}

/** The link a failed download leaves, marked with why (HVN-159): the stubbed request threw. */
function unstored(kind: string, url: string) {
  return { kind, url, vendor_metadata: { unstored: "fetch_failed" } };
}

describe("a download that fails on a re-sync", () => {
  it("keeps the local file already stored for that message and index (the request fails)", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, OLD_BYTES);
    downloadFails("reject");

    const [part] = await run([URL_A]);

    expect(part).toMatchObject({
      kind: "binary",
      data: `media/${CHAT}/${MSG}_0.png`,
      media_type: "image/png",
      vendor_metadata: { storageType: "opfs", size: OLD_BYTES.length },
    });
    // Nothing was written or removed
    expect(fs.files()).toEqual([`media/${CHAT}/${MSG}_0.png`]);
    expect(fs.text(`media/${CHAT}/${MSG}_0.png`)).toBe(OLD_BYTES);
  });

  it("keeps it when the platform answers 404", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, OLD_BYTES);
    downloadFails("404");

    const [part] = await run([URL_A]);

    expect(part).toMatchObject({ kind: "binary", data: `media/${CHAT}/${MSG}_0.png` });
  });

  it("keeps it when the download hangs past the overall timeout", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, OLD_BYTES);
    vi.spyOn(network, "fetchWithTimeout").mockImplementation(() => new Promise<Response>(() => {}));

    const [part] = await run([URL_A], { overallTimeoutMs: 20 });

    expect(part).toMatchObject({ kind: "binary", data: `media/${CHAT}/${MSG}_0.png` });
  });

  it("reads the type from the stored file's extension, not from the asset's hint", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.webp`, OLD_BYTES);
    downloadFails();

    const [part] = await run([URL_A], {}, "image/png");

    expect((part as BinaryContent).media_type).toBe("image/webp");
  });

  it("falls back to the asset's own type for a file whose extension says nothing (.bin)", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.bin`, OLD_BYTES);
    downloadFails();

    const [part] = await run([URL_A], {}, "image/gif");

    expect(part).toMatchObject({
      kind: "binary",
      data: `media/${CHAT}/${MSG}_0.bin`,
      media_type: "image/gif",
    });
  });

  it("uses the remote URL when no file was stored (an image, then a video)", async () => {
    downloadFails();

    const [image] = await run([URL_A], {}, "image/png");
    const [video] = await run([URL_B], {}, "video/mp4");

    expect(image).toEqual(unstored("image-url", URL_A));
    expect(video).toEqual(unstored("video-url", URL_B));
    expect(fs.files()).toEqual([]);
  });

  it("uses the remote URL when the only file is empty (what a failed write leaves behind)", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, new Uint8Array(0));
    downloadFails();

    const [part] = await run([URL_A]);

    expect(part).toEqual(unstored("image-url", URL_A));
  });

  it("looks only at this message and this index", async () => {
    // Index 10 of this message, index 0 of two other messages (one whose id starts with this
    // one's), and the same name in another chat: none of them is the file for index 0
    fs.put(`media/${CHAT}/${MSG}_10.png`, OLD_BYTES);
    fs.put(`media/${CHAT}/${MSG}2_0.png`, OLD_BYTES);
    fs.put(`media/${CHAT}/other_0.png`, OLD_BYTES);
    fs.put(`media/other-chat/${MSG}_0.png`, OLD_BYTES);
    downloadFails();

    const [part] = await run([URL_A]);

    expect(part).toEqual(unstored("image-url", URL_A));
  });

  it("does not take the file of index 10 for the file of index 1", async () => {
    fs.put(`media/${CHAT}/${MSG}_10.png`, OLD_BYTES);
    downloadFails();

    const [first, second] = await run([URL_A, URL_B]);

    expect(first).toEqual(unstored("image-url", URL_A));
    expect(second).toEqual(unstored("image-url", URL_B));
  });

  it("matches the file of each asset by its position in the message", async () => {
    fs.put(`media/${CHAT}/${MSG}_1.png`, OLD_BYTES);
    downloadFails();

    const [first, second] = await run([URL_A, URL_B]);

    expect(first).toEqual(unstored("image-url", URL_A));
    expect(second).toMatchObject({ kind: "binary", data: `media/${CHAT}/${MSG}_1.png` });
  });

  it("keeps the most recently written file when the asset was stored under two types", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.jpg`, "older", 1_000);
    fs.put(`media/${CHAT}/${MSG}_0.png`, "newer one", 2_000);
    fs.put(`media/${CHAT}/${MSG}_0.gif`, new Uint8Array(0), 3_000); // empty: never wins
    downloadFails();

    const [part] = await run([URL_A]);

    expect(part).toMatchObject({ kind: "binary", data: `media/${CHAT}/${MSG}_0.png` });
  });

  it("finds the file of a chat or message whose id holds characters a path cannot", async () => {
    const odd = "chat:1/x";
    fs.put("media/chat_1_x/m_y_0.png", OLD_BYTES);
    downloadFails();

    const [part] = await processExternalAssets([{ url: URL_A, type: "image/png" }], {
      chatId: odd,
      messageId: "m:y",
      retries: 0,
      logPrefix: "",
    });

    expect(part).toMatchObject({ kind: "binary", data: "media/chat_1_x/m_y_0.png" });
  });

  it("still falls back to the URL when the lookup itself fails", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, OLD_BYTES);
    downloadFails();
    vi.spyOn(getMediaStorageService(), "findStored").mockRejectedValue(new Error("opfs is gone"));

    const [part] = await run([URL_A]);

    expect(part).toEqual(unstored("image-url", URL_A));
  });
});

describe("a download that succeeds on a re-sync", () => {
  it("overwrites the stored file at the same path", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.png`, OLD_BYTES);
    downloadSucceeds("image/png");

    const [part] = await run([URL_A]);

    expect(part).toMatchObject({
      kind: "binary",
      data: `media/${CHAT}/${MSG}_0.png`,
      vendor_metadata: { storageType: "opfs", size: NEW_BYTES.length },
    });
    expect(fs.size(`media/${CHAT}/${MSG}_0.png`)).toBe(NEW_BYTES.length);
    expect(fs.files()).toEqual([`media/${CHAT}/${MSG}_0.png`]);
  });

  it("points at the new file, not the old one, when the type has changed", async () => {
    fs.put(`media/${CHAT}/${MSG}_0.jpg`, OLD_BYTES);
    downloadSucceeds("image/png");

    const [part] = await run([URL_A], {}, "image/jpeg");

    expect(part).toMatchObject({ kind: "binary", data: `media/${CHAT}/${MSG}_0.png` });
    expect(fs.size(`media/${CHAT}/${MSG}_0.png`)).toBe(NEW_BYTES.length);
  });
});
