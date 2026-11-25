import { createRequire } from "node:module";
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGenerateChatMetadata } from "../src/background/handlers/metadataHandlers";
import {
  handleSearchChats,
  handleSearchChatsStreaming,
} from "../src/background/handlers/searchHandlers";
import { importChatBatch } from "../src/background/import/importBatch";
import { handleFileDownload } from "../src/background/utils/fileDownload";
import { downloadUrlAttachment } from "../src/formatters";
import type { Chat, SearchResult } from "../src/model/haevn_model";
import { parseChatGPTBackupZip } from "../src/providers/chatgpt/importer";
import { transformOpenAIToHaevn } from "../src/providers/chatgpt/transformer";
import { convertClaudeTranscriptToHaevn } from "../src/providers/claude/transformer";
import { fetchDeepseekConversation } from "../src/providers/deepseek/extractor";
import { extractGeminiMessages } from "../src/providers/gemini/extractor";
import { transformGeminiToHaevn } from "../src/providers/gemini/transformer";
import { fetchGrokChatData } from "../src/providers/grok/extractor";
import {
  extractOpenWebUIChatIds,
  fetchOpenWebUIConversation,
} from "../src/providers/openwebui/extractor";
import { fetchChat } from "../src/providers/poe/api";
import { transformPoeToHaevn } from "../src/providers/poe/transformer";
import { createDownloadPromise } from "../src/providers/shared_utils";
import { getDB } from "../src/services/db";
import { loggerService } from "../src/services/loggerService";
import { setMetadataAIConfig } from "../src/services/settingsService";
import type { LogEntry } from "../src/utils/logger/index";
import {
  configureLogger,
  DirectTransport,
  LogLevel,
  log,
  setLogLevel,
} from "../src/utils/logger/index";
import * as mediaUtils from "../src/utils/media_utils";
import { fetchWithTimeout } from "../src/utils/network_utils";

// HVN-157: no log line carries chat content.
//
// The logger keeps its entries in chrome.storage, and `haevn logs` reads them from a terminal, so
// a title, a message, a search query, a file name or a provider's response in a log call is chat
// content on disk. Each case below runs code that logs, through the real `log`, the real
// `loggerService` and a real (in-memory) chrome.storage, on a fixture whose every text, title,
// query, file name and response body holds SENTINEL. A case fails when any entry the service
// accepted, or any entry it persisted, holds it: in the message, the data, the stack or the url.
//
// To cover another code path, add a Case to CASES. Put SENTINEL in whatever the person typed or
// the provider sent; the case must log something (an empty capture fails, so a case cannot pass
// by not reaching its log calls).

const SENTINEL = "SENTINEL-HVN157";

// The provider and search code reach for the workers and the network; none of it is under test.
const sendWorkerRequest = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/workerApi", () => ({ sendWorkerRequest }));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: vi.fn(async () => {}),
}));
vi.mock("../src/utils/rateLimit", () => ({
  RateLimiter: class {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));
vi.mock("../src/utils/network_utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/network_utils")>()),
  fetchWithTimeout: vi.fn(),
}));

// ─── The harness ─────────────────────────────────────────────────────────────

const stored = new Map<string, unknown>();
const fakeLocal = {
  get: async (keys?: string | string[] | null) => {
    const wanted = keys == null ? [...stored.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) stored.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) stored.delete(k);
  },
};
const broadcasts: Array<{ action?: string }> = [];

function everythingIn(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

/** The entries (as text) that hold the sentinel. */
function leaksIn(entries: unknown[]): string[] {
  return entries
    .map(everythingIn)
    .filter((text) => text.toLowerCase().includes(SENTINEL.toLowerCase()));
}

async function persistedEntries(): Promise<unknown[]> {
  await (loggerService as unknown as { persistLogs(): Promise<void> }).persistLogs();
  return (stored.get("logger:entries") as unknown[]) ?? [];
}

/** Run `run`, and return what the logger took in while it ran. */
async function captured(run: () => Promise<unknown> | unknown): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  const listener = (entry: LogEntry) => entries.push(entry);
  loggerService.addListener(listener);
  try {
    await run();
  } finally {
    loggerService.removeListener(listener);
  }
  return entries;
}

/** Set globals for the length of a case, and put back what was there. */
async function withGlobals(stubs: Record<string, unknown>, run: () => Promise<unknown>) {
  const g = globalThis as Record<string, unknown>;
  const before = Object.fromEntries(
    Object.keys(stubs).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]),
  );
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await run();
  } finally {
    for (const [k, d] of Object.entries(before)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

/** The page of a provider, as a real DOM (domino, the one turndown brings). */
function domOf(html: string, url: string): Document {
  const req = createRequire(createRequire(import.meta.url).resolve("turndown"));
  const win = req("@mixmark-io/domino").createWindow(html, url);
  // domino answers a query by a tag name (`img`) with a live list that has no forEach and no
  // iterator; the extractors use both
  const list = Object.getPrototypeOf(win.document.body.querySelectorAll("img"));
  list.forEach ??= Array.prototype.forEach;
  list[Symbol.iterator] ??= Array.prototype[Symbol.iterator];
  return win.document;
}

function answer(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  } as unknown as Response;
}

function fetchWithTimeoutAnswers(route: (url: string) => Response) {
  vi.mocked(fetchWithTimeout).mockImplementation(async (url) => route(String(url)));
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    ...(globalThis.chrome as object),
    storage: {
      local: fakeLocal,
      sync: { get: (_k: unknown, cb: (r: object) => void) => cb({}), set: () => {} },
    },
    runtime: {
      lastError: null,
      sendMessage: vi.fn((message: { action?: string }, callback?: (r: unknown) => void) => {
        broadcasts.push(message);
        if (callback) callback({ success: true });
        return Promise.resolve();
      }),
    },
    downloads: { download: (_o: unknown, cb: (id: number) => void) => cb(7) },
  });
  await loggerService.init();
  await loggerService.setConfig({ minLevel: LogLevel.DEBUG });
  configureLogger({
    transport: new DirectTransport((entry) => loggerService.addEntry(entry), {
      echoToConsole: false,
    }),
  });
  setLogLevel(LogLevel.DEBUG);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await loggerService.clearLogs();
  broadcasts.length = 0;
  sendWorkerRequest.mockReset();
  vi.mocked(fetchWithTimeout).mockReset();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function savedChat(title: string): Chat {
  return {
    id: "chat-1",
    source: "test",
    sourceId: "src-1",
    title,
    models: ["m"],
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
  } as Chat;
}

function searchResult(): SearchResult {
  return {
    chatId: "chat-1",
    chatTitle: `Title ${SENTINEL}`,
    source: "test",
    messageId: "m1",
    messageContent: `Text ${SENTINEL}`,
    messageSnippet: `Snippet ${SENTINEL}`,
    messageRole: "user",
    messageTimestamp: 1,
  } as unknown as SearchResult;
}

/** Make the search worker answer with a result, or fail with an error that quotes the query. */
function searchWorker(mode: "results" | "syntax-error") {
  sendWorkerRequest.mockImplementation(
    async (
      _worker: string,
      message: { requestId: string },
      options: { onProgress: (chunk: unknown) => void },
    ) => {
      if (mode === "syntax-error") throw new Error(`fts5: syntax error near "${SENTINEL}"`);
      options.onProgress({
        type: "searchResultChunk",
        requestId: message.requestId,
        results: [searchResult()],
        done: true,
      });
    },
  );
}

async function untilBroadcast(action: string) {
  await vi.waitFor(() => expect(broadcasts.map((b) => b.action)).toContain(action));
}

async function zipOf(files: Record<string, string>): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, text] of Object.entries(files)) await writer.add(name, new TextReader(text));
  const bytes = await writer.close();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ─── The cases ───────────────────────────────────────────────────────────────

interface Case {
  name: string;
  run: () => Promise<unknown> | unknown;
}

const OPEN_WEBUI_PAGE = `<html><head><meta name="apple-mobile-web-app-title" content="Open WebUI"></head><body></body></html>`;

const CASES: Case[] = [
  {
    name: "Gemini: the page's messages (extractGeminiMessages)",
    run: async () => {
      const document = domOf(
        `<body>
          <user-query><div class="query-content">${SENTINEL} question</div></user-query>
          <model-response><message-content class="model-response-text"><p>${SENTINEL} answer</p></message-content></model-response>
        </body>`,
        "https://gemini.google.com/app/abc",
      );
      const messages = await withGlobals({ document }, () => extractGeminiMessages());
      expect(everythingIn(messages)).toContain(SENTINEL); // the text reached the extractor
    },
  },
  {
    name: "Gemini: the transform (message text, title, file names)",
    run: async () => {
      vi.spyOn(mediaUtils, "processExternalAssets").mockResolvedValue([] as never);
      const chat = await transformGeminiToHaevn({
        platform: "gemini",
        url: "https://gemini.google.com/app/abc",
        conversationId: "conv-1",
        title: `${SENTINEL} title`,
        messageCount: 1,
        extractedAt: "2024-06-01T10:00:00.000Z",
        messages: [
          {
            index: 1,
            content: `${SENTINEL} text`,
            timestamp: "2024-06-01T09:59:00.000Z",
            localTime: "x",
            role: "user",
            files: [{ url: "https://example.test/a.png", name: `${SENTINEL}.png`, type: "image" }],
          },
        ],
      });
      expect(chat.title).toContain(SENTINEL);
    },
  },
  {
    name: "Poe: the transform (message text, attachment URLs)",
    run: async () => {
      vi.spyOn(mediaUtils, "processExternalAssets").mockResolvedValue([] as never);
      const attachment = {
        id: "a1",
        attachmentId: 1,
        name: `${SENTINEL}.png`,
        url: `https://example.test/${SENTINEL}.png`,
        isInline: false,
        file: {
          id: "f1",
          mimeType: "image/png",
          size: 1,
          url: `https://example.test/${SENTINEL}.png`,
          thumbnailUrl: null,
        },
      };
      const author = { uid: 1, id: "u1", fullName: "Synthetic User", handle: "synthetic" };
      const bot = {
        botId: 4,
        id: "b4",
        displayName: "Bot",
        deletionState: "not_deleted",
        picture: null,
        smallPicture: null,
      };
      const turn = (text: string, time: number, user: boolean, attachments: unknown[] = []) => ({
        id: `m${time}`,
        messageId: time,
        messageCode: `c${time}`,
        authorUser: user ? author : null,
        bot: user ? null : bot,
        text,
        contentType: "text_markdown",
        sourceType: "chat_input",
        state: "complete",
        creationTime: time,
        isEdited: false,
        isDeleted: false,
        isChatAnnouncement: false,
        hasCitations: false,
        attachments,
        referencedMessageV2: null,
        usersCanEdit: [],
        messageStateText: null,
        parameters: null,
        command: null,
      });
      const chats = await transformPoeToHaevn({
        chatId: "Q2hhdDoxMjM=",
        chatCode: "poe-1",
        title: `${SENTINEL} title`,
        botName: "Bot",
        extractedAt: "2024-05-10T10:00:00.000Z",
        messages: [
          turn(`${SENTINEL} question`, 1714557480000000, true),
          turn(
            `${SENTINEL} answer ![x](https://example.test/${SENTINEL}.png)`,
            1714557540000000,
            false,
            [attachment],
          ),
        ],
      } as never);
      expect(everythingIn(chats)).toContain(SENTINEL);
    },
  },
  {
    name: "Poe: the API (variables, response, error body)",
    run: async () => {
      stored.set("poeTokens", { formkey: "k", tagId: "t", tchannel: "c", capturedAt: Date.now() });
      const fetched = vi.spyOn(globalThis, "fetch");
      fetched.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { chat: { title: `${SENTINEL} title`, text: `${SENTINEL} text` } },
          }),
        ),
      );
      await fetchChat(`${SENTINEL}-slug`);
      fetched.mockResolvedValueOnce(new Response(`${SENTINEL} error page`, { status: 500 }));
      await expect(fetchChat("slug")).rejects.toThrow();
      fetched.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: [{ message: `${SENTINEL} bad`, path: [`${SENTINEL}`] }] }),
        ),
      );
      await expect(fetchChat("slug")).rejects.toThrow();
      fetched.mockRestore();
    },
  },
  {
    name: "Open WebUI: a chat, its system prompts and its folder (fetchOpenWebUIConversation)",
    run: async () => {
      const route = (url: string) =>
        url.includes("/folders/")
          ? answer({
              id: "f1",
              name: `${SENTINEL} folder`,
              parent_id: null,
              data: { system_prompt: `${SENTINEL} folder prompt` },
            })
          : answer({
              id: "chat-1",
              title: `${SENTINEL} title`,
              system: `${SENTINEL} system prompt`,
              folder_id: "f1",
              chat: {
                history: {
                  currentId: "m1",
                  messages: { m1: { role: "user", content: `${SENTINEL} text`, timestamp: 1 } },
                },
              },
            });
      fetchWithTimeoutAnswers(route);
      const document = domOf(OPEN_WEBUI_PAGE, "https://webui.example.test/c/chat-1");
      const raw = await withGlobals(
        {
          document,
          location: { href: "https://webui.example.test/c/chat-1", hostname: "webui.example.test" },
          localStorage: { getItem: () => "token" },
        },
        () => fetchOpenWebUIConversation("chat-1"),
      );
      expect(everythingIn(raw)).toContain(SENTINEL);
    },
  },
  {
    name: "Open WebUI: an error body (extractOpenWebUIChatIds)",
    run: async () => {
      fetchWithTimeoutAnswers(() =>
        answer(null, { ok: false, status: 500, text: `${SENTINEL} error page` }),
      );
      const document = domOf(OPEN_WEBUI_PAGE, "https://webui.example.test/");
      await withGlobals(
        {
          document,
          location: { href: "https://webui.example.test/", hostname: "webui.example.test" },
          localStorage: { getItem: () => "token" },
        },
        () => expect(extractOpenWebUIChatIds()).rejects.toThrow(),
      );
    },
  },
  {
    name: "Claude: the transform (title, text, attachment file name)",
    run: async () => {
      const chat = await convertClaudeTranscriptToHaevn({
        uuid: "f75ac9be-f5d9-427e-87c8-6abd82a9ef10",
        name: `${SENTINEL} title`,
        updated_at: "2024-01-01T12:00:00Z",
        current_leaf_message_uuid: "msg-1",
        chat_messages: [
          {
            uuid: "msg-1",
            text: `${SENTINEL} text`,
            sender: "human",
            created_at: "2024-01-01T11:59:00Z",
            updated_at: "2024-01-01T11:59:00Z",
            attachments: [
              {
                file_name: `${SENTINEL}.txt`,
                file_size: 1,
                file_type: "text/plain",
                extracted_content: `${SENTINEL} body`,
              },
            ],
          },
        ],
      } as never);
      expect(chat.title).toContain(SENTINEL);
    },
  },
  {
    name: "ChatGPT: the transform, with an image it cannot find",
    run: async () => {
      const pointer = "file-service://file-0";
      const raw = {
        assets: {},
        conversation: {
          id: "chat-gpt-1",
          conversation_id: "chat-gpt-1",
          title: `${SENTINEL} title`,
          create_time: 1_700_000_000,
          update_time: 1_700_000_100,
          current_node: "m0",
          mapping: {
            root: { id: "root", message: null, parent: null, children: ["m0"] },
            m0: {
              id: "m0",
              parent: "root",
              children: [],
              message: {
                id: "m0",
                author: { role: "user" },
                create_time: 1_700_000_000,
                update_time: 1_700_000_000,
                content: {
                  content_type: "multimodal_text",
                  parts: [
                    {
                      content_type: "image_asset_pointer",
                      asset_pointer: pointer,
                      size_bytes: 1,
                      width: 1,
                      height: 1,
                    },
                    `${SENTINEL} text`,
                  ],
                },
                status: "finished_successfully",
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: "all",
                channel: null,
              },
            },
          },
          moderation_results: [],
          is_archived: false,
          is_starred: null,
          is_do_not_remember: null,
          safe_urls: [],
          blocked_urls: [],
        },
      };
      const chat = transformOpenAIToHaevn(raw as never);
      expect(everythingIn(chat)).toContain(SENTINEL);
    },
  },
  {
    name: "ChatGPT: an export ZIP whose image file is named by the person (parseChatGPTBackupZip)",
    run: async () => {
      const pointer = "file-service://file-abc123";
      const conversation = {
        id: "c1",
        title: `${SENTINEL} title`,
        mapping: {
          m0: {
            id: "m0",
            message: {
              id: "m0",
              author: { role: "user" },
              content: {
                content_type: "multimodal_text",
                parts: [
                  { content_type: "image_asset_pointer", asset_pointer: pointer },
                  `${SENTINEL} text`,
                ],
              },
            },
          },
        },
      };
      const zip = await zipOf({
        "conversations.json": JSON.stringify([conversation]),
        [`file-abc123-${SENTINEL}.png`]: "not really a png",
      });
      const items = [];
      for await (const item of parseChatGPTBackupZip(zip)) items.push(item);
      expect(Object.keys(items[0].assets)).toEqual([pointer]); // the file was found, by its name
    },
  },
  {
    name: "DeepSeek: a conversation (title) and an error body",
    run: async () => {
      const wrapper = {
        code: 0,
        msg: "",
        data: {
          biz_code: 0,
          biz_msg: "",
          biz_data: {
            chat_session: { id: "s1", title: `${SENTINEL} title` },
            chat_messages: [{ message_id: 1, role: "USER", content: `${SENTINEL} text` }],
          },
        },
      };
      await withGlobals(
        { localStorage: { getItem: () => JSON.stringify({ value: "token" }) } },
        async () => {
          fetchWithTimeoutAnswers(() => answer(wrapper));
          const data = await fetchDeepseekConversation("s1");
          expect(everythingIn(data)).toContain(SENTINEL);
          fetchWithTimeoutAnswers(() =>
            answer(null, { ok: false, status: 500, text: `${SENTINEL} error page` }),
          );
          await expect(fetchDeepseekConversation("s1")).rejects.toThrow();
          fetchWithTimeoutAnswers(() =>
            answer({
              code: 40003,
              msg: `${SENTINEL} refused`,
              data: { biz_code: 1, biz_msg: `${SENTINEL} refused`, biz_data: {} },
            }),
          );
          await expect(fetchDeepseekConversation("s1")).rejects.toThrow();
        },
      );
    },
  },
  {
    name: "Grok: a conversation (title, response text)",
    run: async () => {
      fetchWithTimeoutAnswers((url) => {
        if (url.endsWith("/response-node?includeThreads=true")) {
          return answer({
            responseNodes: [{ responseId: "r1", sender: "human", parentResponseId: null }],
          });
        }
        if (url.endsWith("/load-responses")) {
          return answer({
            responses: [{ responseId: "r1", sender: "human", message: `${SENTINEL} text` }],
          });
        }
        return answer({ conversationId: "c1", title: `${SENTINEL} title` });
      });
      const data = await fetchGrokChatData("c1");
      expect(everythingIn(data)).toContain(SENTINEL);
    },
  },
  {
    name: "Search: a query that finds a result (handleSearchChatsStreaming)",
    run: async () => {
      searchWorker("results");
      await handleSearchChatsStreaming(
        { action: "searchChatsStreaming", query: `find ${SENTINEL}` } as never,
        vi.fn(),
      );
      await untilBroadcast("searchStreamingComplete");
    },
  },
  {
    name: "Search: a query the index refuses with an error that quotes it (handleSearchChatsStreaming)",
    run: async () => {
      searchWorker("syntax-error");
      await handleSearchChatsStreaming(
        { action: "searchChatsStreaming", query: `find ${SENTINEL}` } as never,
        vi.fn(),
      );
      await untilBroadcast("searchStreamingFailed");
    },
  },
  {
    name: "Search: the one-answer search (handleSearchChats)",
    run: async () => {
      searchWorker("results");
      const sendResponse = vi.fn();
      await handleSearchChats(
        { action: "searchChats", query: `find ${SENTINEL}` } as never,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      searchWorker("syntax-error");
      const failed = vi.fn();
      await handleSearchChats(
        { action: "searchChats", query: `find ${SENTINEL}` } as never,
        failed,
      );
      await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    },
  },
  {
    name: "Metadata: the LLM endpoint (prompt, a reply that is not JSON, an error body)",
    run: async () => {
      const db = getDB();
      await db.chats.put({ ...savedChat(`${SENTINEL} title`), id: "chat-m" });
      await db.chatMessages.put({
        id: "m1",
        chatId: "chat-m",
        childrenIds: [],
        message: [
          { kind: "request", parts: [{ part_kind: "user-prompt", content: `${SENTINEL} text` }] },
        ],
        model: "m",
        done: true,
        timestamp: 1704067200000,
      } as never);
      await setMetadataAIConfig({
        enabled: true,
        url: "https://meta.test/v1",
        model: "meta-a",
        categories: [],
        extraRequestParams: { reasoning_effort: `${SENTINEL} typed` },
        indexMissing: false,
      });
      const fetched = vi.spyOn(globalThis, "fetch");
      const reply = (content: string) =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      for (const response of [
        reply(`${SENTINEL} this is not the JSON asked for`),
        new Response(`{"error":"${SENTINEL} context exceeded: ${SENTINEL}"}`, { status: 400 }),
      ]) {
        fetched.mockResolvedValueOnce(response);
        const sendResponse = vi.fn();
        await handleGenerateChatMetadata(
          { action: "generateChatMetadata", chatId: "chat-m" } as never,
          sendResponse,
        );
        expect(sendResponse.mock.calls[0][0]).toMatchObject({ success: false });
      }
      fetched.mockRestore();
    },
  },
  {
    name: "Import: a file the batch cannot parse, and a chat it saves (importChatBatch)",
    run: async () => {
      await importChatBatch(
        [
          {
            name: `${SENTINEL}.json`,
            load: async () => {
              JSON.parse(SENTINEL); // the message of this error quotes what it choked on
              throw new Error("unreachable");
            },
          },
          {
            name: `${SENTINEL}-2.json`,
            load: async () => ({ chat: savedChat(`${SENTINEL} title`) }),
          },
        ],
        { overwrite: true, index: false },
      );
    },
  },
  {
    name: "Export: an attachment that cannot be fetched (downloadUrlAttachment)",
    run: async () => {
      const url = `https://files.example.test/a/b.png?token=${SENTINEL}`;
      const fetched = vi.spyOn(globalThis, "fetch");
      fetched.mockResolvedValueOnce(new Response("", { status: 404, statusText: "Not Found" }));
      expect(await downloadUrlAttachment(url, "image/png")).toBeNull();
      fetched.mockRejectedValueOnce(new Error("network down"));
      expect(await downloadUrlAttachment(url, "image/png")).toBeNull();
      fetched.mockRestore();
    },
  },
  {
    name: "Download: an export whose file name is made from the chat's title",
    run: async () => {
      const sendResponse = vi.fn();
      handleFileDownload(
        {
          action: "downloadFile",
          content: "x",
          filename: `${SENTINEL}.md`,
          contentType: "text/markdown",
        } as never,
        sendResponse,
      );
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      await createDownloadPromise({
        action: "downloadFile",
        content: "x",
        filename: `${SENTINEL}.md`,
        contentType: "text/markdown",
      });
    },
  },
];

describe("no log line carries chat content (HVN-157)", () => {
  it.each(CASES)("$name", async ({ run }) => {
    const entries = await captured(run);

    expect(entries.length, "the case logged nothing: it proves nothing").toBeGreaterThan(0);
    expect(leaksIn(entries)).toEqual([]);
    expect(leaksIn(await persistedEntries())).toEqual([]);
  });

  it("keeps a page URL's query and fragment out of a content script's entry", async () => {
    const entries = await captured(() => {
      loggerService.addLog({ level: "INFO", message: "a content-script line" }, {
        tab: { id: 3 } as chrome.tabs.Tab,
        url: `https://chat.example.com/search?q=${SENTINEL}#${SENTINEL}`,
      } as chrome.runtime.MessageSender);
    });

    expect(entries.map((e) => e.url)).toEqual(["https://chat.example.com/search"]);
    expect(leaksIn(await persistedEntries())).toEqual([]);
  });

  it("sees a leak when there is one (the check can fail)", async () => {
    const entries = await captured(() => {
      log.info("a title in the data", { title: `${SENTINEL} title` });
      log.warn(`a query in the message: ${SENTINEL}`);
      log.error("an error", new Error(`quotes ${SENTINEL}`));
    });

    expect(leaksIn(entries)).toHaveLength(3);
    expect(leaksIn(await persistedEntries()).length).toBeGreaterThanOrEqual(3);
  });
});
