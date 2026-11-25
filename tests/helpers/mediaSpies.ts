/**
 * What a media-writing transform could touch, counted: the shared download helper, a bare fetch,
 * a message to a tab, OPFS. Used by the media-skip tests and the provider health read-only proof.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { registerAllProviders } from "../../src/providers";
import * as network from "../../src/utils/network_utils";
import { FakeOpfs } from "./fakeOpfs";
import {
  aistudioRaw,
  chatgptRaw,
  claudeRaw,
  geminiRaw,
  grokRaw,
  poeRaw,
  qwenRaw,
  sentinels,
} from "./healthFixtures";

export const IMAGE = "https://cdn.example.test/picture.png";

/** A payload per media-writing provider with one image in it. */
export const WITH_MEDIA: Record<string, () => unknown> = {
  claude: () =>
    claudeRaw(sentinels("m-claude"), {
      files: [
        {
          file_uuid: "f1",
          file_kind: "image",
          file_name: "a.png",
          preview_url: "/api/files/f1/preview",
        },
      ],
    }),
  chatgpt: () =>
    chatgptRaw(sentinels("m-chatgpt"), {
      image: { pointer: "file-service://file-a", url: IMAGE },
    }),
  // an upload: Gemini keeps the links of other hosts (thumbnails, icons) as links, and fetches none
  gemini: () =>
    geminiRaw(sentinels("m-gemini"), {
      files: [
        { url: "https://lh3.googleusercontent.com/gg/AbC", type: "image/png", name: "a.png" },
      ],
    }),
  aistudio: () =>
    aistudioRaw(sentinels("m-ais"), { files: [{ url: IMAGE, type: "image/png", name: "a.png" }] }),
  qwen: () =>
    qwenRaw(sentinels("m-qwen"), {
      files: [
        { id: "f", name: "a.png", file_type: "image/png", type: "image", size: 1, url: IMAGE },
      ],
    }),
  grok: () =>
    grokRaw(sentinels("m-grok"), {
      attachments: [
        {
          fileMetadataId: "f",
          fileMimeType: "image/png",
          fileName: "a.png",
          fileUri: "users/u/f/content",
          parsedFileUri: "",
          createTime: "2026-11-19T10:00:00.000Z",
          fileSource: "x",
        },
      ],
    }),
  poe: () =>
    poeRaw(sentinels("m-poe"), {
      attachments: [
        {
          id: "att-1",
          attachmentId: 1,
          name: "a.png",
          url: IMAGE,
          isInline: false,
          file: { id: "file-1", mimeType: "image/png", size: 10, url: IMAGE, thumbnailUrl: null },
        },
      ],
    }),
};

const realFetch = globalThis.fetch;
const realChrome = (globalThis as { chrome: unknown }).chrome;
const realSetImmediate = globalThis.setImmediate;

export interface MediaWorld {
  fs: FakeOpfs;
  getDirectory: ReturnType<typeof vi.fn>;
  /** Everything a download or a media write would touch, counted. */
  touches(): number;
}

/**
 * Installs, for each test, an OPFS, a download helper, a fetch and a tab API that all fail or
 * count, and puts the globals back after it. Call it once at the top of a test file.
 */
export function mediaWorld(): MediaWorld {
  const world = {} as MediaWorld & {
    downloads: ReturnType<typeof vi.spyOn>;
    tabCalls: ReturnType<typeof vi.fn>;
    globalFetch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    registerAllProviders();
    world.fs = new FakeOpfs();
    world.fs.install();
    world.getDirectory = vi.fn(navigator.storage.getDirectory.bind(navigator.storage));
    (navigator.storage as { getDirectory: unknown }).getDirectory = world.getDirectory;
    // every way a download could leave: the shared fetch helper, a bare fetch, a message to a tab
    world.downloads = vi.spyOn(network, "fetchWithTimeout").mockImplementation(async () => {
      throw new Error("offline");
    });
    world.globalFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    globalThis.fetch = world.globalFetch as unknown as typeof fetch;
    world.tabCalls = vi.fn();
    (globalThis as { chrome: unknown }).chrome = {
      ...(globalThis as { chrome: Record<string, unknown> }).chrome,
      tabs: {
        sendMessage: world.tabCalls,
        create: world.tabCalls,
        remove: world.tabCalls,
        get: world.tabCalls,
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Not unstubAllGlobals: that would take away the chrome mock the test setup installed once.
    globalThis.fetch = realFetch;
    (globalThis as { chrome: unknown }).chrome = realChrome;
  });

  world.touches = () =>
    world.downloads.mock.calls.length +
    world.globalFetch.mock.calls.length +
    world.tabCalls.mock.calls.length +
    world.getDirectory.mock.calls.length;
  return world;
}

/** Drive the fake setTimeout until a promise settles; real macrotasks between, for crypto.subtle. */
export async function untilSettled<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => realSetImmediate(resolve));
    await vi.advanceTimersByTimeAsync(500);
  }
  return promise;
}
