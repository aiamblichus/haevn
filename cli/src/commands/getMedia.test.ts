import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest, pipeOut } from "../daemon/client.js";
import { buildChat } from "../testing/fixtures";
import { runAsTyped } from "../testing/runAsTyped";
import type { Chat, ModelResponsePart, UserContent } from "../types/chat";
import { extensionFor, JSON_ITEM_MAX_BYTES, linkTarget, mediaFolderFor } from "../utils/media";
import { consola } from "../utils/output";
import getCommand from "./get";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(), pipeOut: vi.fn() }));
vi.mock("../daemon/config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: () => ({ port: 5599, apiKey: "test-key" }),
}));

const TIME = "2026-01-01T00:00:00.000Z";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = Buffer.from("fake mp4 bytes");
const PDF = Buffer.from("%PDF-1.7 fake");

function stored(name: string, mediaType: string): UserContent {
  return { kind: "binary", data: `media/chat-1/${name}`, media_type: mediaType, identifier: name };
}

/**
 * u0 "Draw me a hen" -> a1 (text, a png, an mp4) -> u2 ("look at this" and a pdf) -> a3 (an image
 * that is only a link). The media are, in order: a1_0.png, a1_1.mp4, u2_0.pdf, a link.
 */
function mediaChat(): Chat {
  const chat = buildChat([
    { id: "u0", parentId: null, role: "user", text: "Draw me a hen" },
    { id: "a1", parentId: "u0", role: "assistant", text: "" },
    { id: "u2", parentId: "a1", role: "user", text: "" },
    { id: "a3", parentId: "u2", role: "assistant", text: "" },
  ]);
  chat.messages.a1.message = [
    {
      kind: "response",
      timestamp: TIME,
      parts: [
        { part_kind: "text", content: "Here is the hen." },
        { part_kind: "image-response", content: stored("a1_0.png", "image/png") },
        { part_kind: "video-response", content: stored("a1_1.mp4", "video/mp4") },
      ] as ModelResponsePart[],
    },
  ];
  chat.messages.u2.message = [
    {
      kind: "request",
      parts: [
        {
          part_kind: "user-prompt",
          timestamp: TIME,
          content: ["look at this", stored("u2_0.pdf", "application/pdf")],
        },
      ],
    },
  ];
  chat.messages.a3.message = [
    {
      kind: "response",
      timestamp: TIME,
      parts: [
        {
          part_kind: "image-response",
          content: { kind: "image-url", url: "https://example.com/hen (2).png" },
        },
      ] as ModelResponsePart[],
    },
  ];
  return chat;
}

/** The extension's media files: the daemon's pipe answers each by name, or fails as the extension would. */
function serve(files: Record<string, Buffer>): void {
  vi.mocked(pipeOut).mockImplementation(async (_endpoint, action) => {
    const name = String(action.name);
    const file = files[name];
    if (!file) throw new Error(`chat chat-1 has no media file ${name}`);
    return { length: file.length, body: new Response(file).body as ReadableStream<Uint8Array> };
  });
}

let dir: string;
let out: string[];
let exit: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-get-media-"));
  out = [];
  vi.mocked(daemonRequest).mockReset();
  vi.mocked(pipeOut).mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    out.push(String(text));
    return true;
  });
  vi.spyOn(consola, "success").mockImplementation(() => undefined);
  warn = vi.spyOn(consola, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
  exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(rawArgs: string[], chat: Chat = mediaChat()): Promise<void> {
  vi.mocked(daemonRequest).mockResolvedValue(chat);
  return runAsTyped(getCommand, ["chat-1", ...rawArgs]);
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(dir, ...parts), "utf8");
}

describe("haevn get --include-media -o FILE (Markdown)", () => {
  beforeEach(() => serve({ "a1_0.png": PNG, "a1_1.mp4": MP4, "u2_0.pdf": PDF }));

  it("writes an image, a video and a file beside the output, numbered in message order", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")]);

    expect(fs.readdirSync(path.join(dir, "chat-media")).sort()).toEqual([
      "01.png",
      "02.mp4",
      "03.pdf",
    ]);
    expect(fs.readFileSync(path.join(dir, "chat-media", "01.png"))).toEqual(PNG);
    expect(fs.readFileSync(path.join(dir, "chat-media", "02.mp4"))).toEqual(MP4);
    expect(fs.readFileSync(path.join(dir, "chat-media", "03.pdf"))).toEqual(PDF);
    expect(exit).not.toHaveBeenCalled();
  });

  it("asks the extension for each file by chat and stored name, on the configured daemon", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")]);

    expect(vi.mocked(pipeOut).mock.calls.map(([endpoint, action]) => [endpoint, action])).toEqual([
      [
        { port: 5599, apiKey: "test-key" },
        { action: "backupMedia", chatId: "chat-1", name: "a1_0.png" },
      ],
      [
        { port: 5599, apiKey: "test-key" },
        { action: "backupMedia", chatId: "chat-1", name: "a1_1.mp4" },
      ],
      [
        { port: 5599, apiKey: "test-key" },
        { action: "backupMedia", chatId: "chat-1", name: "u2_0.pdf" },
      ],
    ]);
  });

  it("links an image as an image and the others as links, where the stand-in was", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")]);

    const md = read("chat.md");
    expect(md).toContain(
      "Here is the hen.\n\n![image](chat-media/01.png)\n\n[video](chat-media/02.mp4)",
    );
    expect(md).toContain("look at this\n\n[file](chat-media/03.pdf)");
    expect(md).not.toContain("[image]\n");
  });

  it("links a URL-only item and downloads nothing for it", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")]);

    expect(read("chat.md")).toContain("![image](https://example.com/hen%20%282%29.png)");
    expect(vi.mocked(pipeOut)).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.join(dir, "chat-media"))).toHaveLength(3);
  });

  it("links the media of a reply that also shows its thinking", async () => {
    const chat = mediaChat();
    const parts = chat.messages.a1.message[0].parts as ModelResponsePart[];
    parts.unshift({ part_kind: "thinking", content: "A hen, then" });

    await get(["--include-media", "--include-thinking", "-o", path.join(dir, "chat.md")], chat);

    expect(read("chat.md")).toContain(
      "<thinking>\nA hen, then\n</thinking>\n\nHere is the hen.\n\n![image](chat-media/01.png)\n\n[video](chat-media/02.mp4)",
    );
  });

  it("leaves the chat's own text where it was", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")]);

    expect(read("chat.md")).toContain("## User\n\nDraw me a hen");
  });

  it("without --include-media writes no folder and shows the stand-ins", async () => {
    await get(["-o", path.join(dir, "chat.md")]);

    expect(fs.existsSync(path.join(dir, "chat-media"))).toBe(false);
    expect(read("chat.md")).toContain("Here is the hen.\n\n[image]\n\n[video]");
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the folder for the output and escapes it in the links", async () => {
    await get(["--include-media", "-o", path.join(dir, "my chat (1).md")]);

    expect(fs.existsSync(path.join(dir, "my chat (1)-media", "01.png"))).toBe(true);
    expect(read("my chat (1).md")).toContain("![image](my%20chat%20%281%29-media/01.png)");
  });

  it("only fetches the media of the messages it shows", async () => {
    await get(["--include-media", "--head", "2", "-o", path.join(dir, "chat.md")]);

    expect(vi.mocked(pipeOut).mock.calls.map(([, action]) => action.name)).toEqual([
      "a1_0.png",
      "a1_1.mp4",
    ]);
    expect(fs.readdirSync(path.join(dir, "chat-media"))).toEqual(["01.png", "02.mp4"]);
  });

  it("pads the numbers to the width the count needs", async () => {
    const chat = buildChat([
      { id: "u0", parentId: null, role: "user", text: "many" },
      { id: "a1", parentId: "u0", role: "assistant", text: "" },
    ]);
    chat.messages.a1.message = [
      {
        kind: "response",
        timestamp: TIME,
        parts: Array.from({ length: 101 }, () => ({
          part_kind: "image-response",
          content: stored("a1_0.png", "image/png"),
        })) as ModelResponsePart[],
      },
    ];
    await get(["--include-media", "-o", path.join(dir, "chat.md")], chat);

    const names = fs.readdirSync(path.join(dir, "chat-media")).sort();
    expect(names).toHaveLength(101);
    expect(names[0]).toBe("001.png");
    expect(names[100]).toBe("101.png");
  });

  it("writes an inline base64 image, and says an inline text has no file", async () => {
    const chat = buildChat([
      { id: "u0", parentId: null, role: "user", text: "see" },
      { id: "a1", parentId: "u0", role: "assistant", text: "" },
    ]);
    chat.messages.u0.message = [
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            timestamp: TIME,
            content: [
              "see",
              { kind: "binary", data: PNG.toString("base64"), media_type: "image/png" },
              { kind: "binary", data: "the text a provider extracted", media_type: "text/plain" },
            ],
          },
        ],
      },
    ];
    chat.messages.a1.message = [
      { kind: "response", timestamp: TIME, parts: [{ part_kind: "text", content: "ok" }] },
    ];
    await get(["--include-media", "-o", path.join(dir, "chat.md")], chat);

    expect(fs.readFileSync(path.join(dir, "chat-media", "01.png"))).toEqual(PNG);
    expect(read("chat.md")).toContain("![image](chat-media/01.png)\n\n[file]");
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("1 media item has no file in the archive to save.");
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps the stand-in for an item whose record has no content, and goes on", async () => {
    const chat = buildChat([
      { id: "u0", parentId: null, role: "user", text: "see" },
      { id: "a1", parentId: "u0", role: "assistant", text: "" },
    ]);
    chat.messages.a1.message = [
      {
        kind: "response",
        timestamp: TIME,
        parts: [
          { part_kind: "image-response" },
          { part_kind: "video-response", content: { kind: "binary", media_type: "video/mp4" } },
          { part_kind: "audio-response", content: { kind: "audio-url" } },
        ] as unknown as ModelResponsePart[],
      },
    ];

    await get(["--include-media", "-o", path.join(dir, "chat.md")], chat);

    expect(read("chat.md")).toContain("[image]\n\n[video]\n\n[audio]");
    expect(fs.existsSync(path.join(dir, "chat-media"))).toBe(false);
    expect(warn).toHaveBeenCalledWith("3 media items have no file in the archive to save.");
  });

  it("refuses a media folder that is already there, before it fetches or writes anything", async () => {
    fs.mkdirSync(path.join(dir, "chat-media"));
    fs.writeFileSync(path.join(dir, "chat-media", "01.png"), "an earlier run's file");

    await expect(get(["--include-media", "-o", path.join(dir, "chat.md")])).rejects.toThrow(
      "exit 1",
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining("chat-media already exists"));
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "chat.md"))).toBe(false);
    expect(read("chat-media", "01.png")).toBe("an earlier run's file");
  });

  it("does not need the folder free when the branch has no media to save", async () => {
    fs.mkdirSync(path.join(dir, "chat-media"));
    const plain = buildChat([
      { id: "u0", parentId: null, role: "user", text: "hello" },
      { id: "a1", parentId: "u0", role: "assistant", text: "hi" },
    ]);

    await get(["--include-media", "-o", path.join(dir, "chat.md")], plain);

    expect(read("chat.md")).toContain("hello");
  });

  it("keeps the stand-in for a file that did not arrive, numbers the rest without a gap and exits 1", async () => {
    serve({ "a1_1.mp4": MP4, "u2_0.pdf": PDF });

    await expect(get(["--include-media", "-o", path.join(dir, "chat.md")])).rejects.toThrow(
      "exit 1",
    );

    expect(warn).toHaveBeenCalledWith(
      "image a1_0.png was not saved: chat chat-1 has no media file a1_0.png",
    );
    expect(fs.readdirSync(path.join(dir, "chat-media")).sort()).toEqual(["01.mp4", "02.pdf"]);
    const md = read("chat.md");
    expect(md).toContain("Here is the hen.\n\n[image]\n\n[video](chat-media/01.mp4)");
    expect(md).toContain("[file](chat-media/02.pdf)");
  });

  it("leaves no empty folder when no file arrived", async () => {
    serve({});

    await expect(get(["--include-media", "-o", path.join(dir, "chat.md")])).rejects.toThrow(
      "exit 1",
    );

    expect(fs.existsSync(path.join(dir, "chat-media"))).toBe(false);
    expect(read("chat.md")).toContain("[image]");
  });
});

describe("haevn get --include-media to the terminal (Markdown)", () => {
  beforeEach(() => serve({ "a1_0.png": PNG, "a1_1.mp4": MP4, "u2_0.pdf": PDF }));

  it("writes no file, keeps the stand-ins and says once to use -o", async () => {
    await get(["--include-media"], mediaChat());

    const shown = out.join("");
    expect(shown).toContain("Here is the hen.\n\n[image]\n\n[video]");
    expect(shown).toContain("look at this\n\n[file]");
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "3 media files were not saved: add -o FILE to save them beside it.",
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it("still links a URL-only item, which needs no file", async () => {
    await get(["--include-media"]);

    expect(out.join("")).toContain("![image](https://example.com/hen%20%282%29.png)");
  });
});

describe("haevn get --include-media as JSON", () => {
  beforeEach(() => serve({ "a1_0.png": PNG, "a1_1.mp4": MP4, "u2_0.pdf": PDF }));

  type JsonMessage = { ref: string; media?: Array<Record<string, unknown>> };
  function messages(): JsonMessage[] {
    return (JSON.parse(out.join("")) as { branch: { messages: JsonMessage[] } }).branch.messages;
  }

  it("carries each item in the message's media, with its bytes as base64", async () => {
    await get(["--include-media", "-f", "json"]);

    const [u0, a1, u2, a3] = messages();
    expect(u0.media).toBeUndefined();
    expect(a1.media).toEqual([
      {
        kind: "image",
        mediaType: "image/png",
        name: "a1_0.png",
        bytes: PNG.length,
        data: PNG.toString("base64"),
      },
      {
        kind: "video",
        mediaType: "video/mp4",
        name: "a1_1.mp4",
        bytes: MP4.length,
        data: MP4.toString("base64"),
      },
    ]);
    expect(u2.media).toEqual([
      {
        kind: "file",
        mediaType: "application/pdf",
        name: "u2_0.pdf",
        bytes: PDF.length,
        data: PDF.toString("base64"),
      },
    ]);
    // A link is carried as a link, with nothing downloaded for it
    expect(a3.media).toEqual([{ kind: "image", url: "https://example.com/hen (2).png" }]);
    expect(vi.mocked(pipeOut)).toHaveBeenCalledTimes(3);
  });

  it("writes no media folder with -o, and keeps the bytes inline", async () => {
    await get(["--include-media", "-f", "json", "-o", path.join(dir, "chat.json")]);

    expect(fs.readdirSync(dir)).toEqual(["chat.json"]);
    expect(read("chat.json")).toContain(PNG.toString("base64"));
  });

  it("has no media key without the flag, and fetches nothing", async () => {
    await get(["-f", "json"]);

    expect(messages().every((m) => m.media === undefined)).toBe(true);
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
  });

  it("says why a file is not inlined when it is over the limit, and exits 1", async () => {
    vi.mocked(pipeOut).mockImplementation(async () => ({
      length: JSON_ITEM_MAX_BYTES + 1,
      body: new Response("x").body as ReadableStream<Uint8Array>,
    }));

    await expect(get(["--include-media", "-f", "json"])).rejects.toThrow("exit 1");

    const [, a1] = messages();
    expect(a1.media?.[0]).toMatchObject({ kind: "image", name: "a1_0.png" });
    expect(a1.media?.[0].data).toBeUndefined();
    expect(String(a1.media?.[0].error)).toContain("save the media with -f markdown -o FILE");
  });
});

describe("the helpers of --include-media", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["audio/mpeg", "mp3"],
    ["application/pdf", "pdf"],
    ["IMAGE/PNG; charset=binary", "png"],
    ["application/x-something-new", "bin"],
    ["application/octet-stream", "bin"],
    ["", "bin"],
    [undefined, "bin"],
  ])("takes the extension of %j as %s", (mediaType, extension) => {
    expect(extensionFor(mediaType)).toBe(extension);
  });

  it("escapes what would end a link early", () => {
    expect(linkTarget("a b(c)<d>\n.png")).toBe("a%20b%28c%29%3Cd%3E%0A.png");
    expect(linkTarget("chat-media/01.png")).toBe("chat-media/01.png");
  });

  it("puts the folder beside the output, named for it without its extension", () => {
    expect(mediaFolderFor("/x/y/chat.md")).toEqual({ dir: "/x/y/chat-media", name: "chat-media" });
    expect(mediaFolderFor("chat")).toEqual({ dir: "chat-media", name: "chat-media" });
    expect(mediaFolderFor("a.b.md").name).toBe("a.b-media");
  });
});
