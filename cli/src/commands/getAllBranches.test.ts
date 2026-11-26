import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest, pipeOut } from "../daemon/client.js";
import { buildThreeBranchChat, makeToolReturn } from "../testing/fixtures";
import { runAsTyped } from "../testing/runAsTyped";
import type { BinaryContent, Chat, ModelResponsePart } from "../types/chat";
import { consola } from "../utils/output";
import getCommand from "./get";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(), pipeOut: vi.fn() }));
vi.mock("../daemon/config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: () => ({ port: 5599, apiKey: "test-key" }),
}));

const TIME = "2026-01-01T00:00:00.000Z";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MP4 = Buffer.from("fake mp4 bytes");

function stored(name: string, mediaType: string): BinaryContent {
  return { kind: "binary", data: `media/chat-1/${name}`, media_type: mediaType, identifier: name };
}

function reply(text: string, ...media: ModelResponsePart[]): Chat["messages"][string]["message"] {
  return [
    {
      kind: "response",
      timestamp: TIME,
      parts: [{ part_kind: "text", content: text }, ...media] as ModelResponsePart[],
    },
  ];
}

const image = (name: string): ModelResponsePart => ({
  part_kind: "image-response",
  content: stored(name, "image/png"),
});

/**
 * The three-branch chat with an image on each answer. The trunk's is `trunk.png`; branches 1 and 2
 * both hold `shared.png` (one upload in two branches) and branch 2 has a video too; branch 3's is
 * `c.png`. In reading order the files are trunk.png, shared.png, (shared.png again), b.mp4, c.png.
 */
function mediaTree(): Chat {
  const chat = buildThreeBranchChat();
  chat.messages.a1.message = reply("trunk answer", image("trunk.png"));
  chat.messages.a3.message = reply("reply A", image("shared.png"));
  chat.messages.a5.message = reply("reply B", image("shared.png"), {
    part_kind: "video-response",
    content: stored("b.mp4", "video/mp4"),
  } as ModelResponsePart);
  chat.messages.a7.message = reply("reply C", image("c.png"));
  return chat;
}

function serve(files: Record<string, Buffer>): void {
  vi.mocked(pipeOut).mockImplementation(async (_endpoint, action) => {
    const file = files[String(action.name)];
    if (!file) throw new Error(`chat chat-1 has no media file ${String(action.name)}`);
    return { length: file.length, body: new Response(file).body as ReadableStream<Uint8Array> };
  });
}

let dir: string;
let out: string[];
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-get-all-"));
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
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(rawArgs: string[], chat: Chat = buildThreeBranchChat()): Promise<void> {
  vi.mocked(daemonRequest).mockResolvedValue(chat);
  return runAsTyped(getCommand, ["chat-1", "--all-branches", ...rawArgs]);
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(dir, ...parts), "utf8");
}

describe("haevn get --all-branches", () => {
  it("asks the daemon for the whole chat, once", async () => {
    await get([]);

    expect(vi.mocked(daemonRequest).mock.calls).toEqual([
      [{ action: "branches", chatId: "chat-1" }],
    ]);
  });

  it("prints the trunk once and every branch, the current one marked", async () => {
    await get([]);

    const text = out.join("");
    expect(text.match(/^### .+$/gm)).toEqual([
      "### Branch 1 of 3",
      "### Branch 2 of 3 (current)",
      "### Branch 3 of 3",
    ]);
    for (const line of ["Draw a robot", "trunk answer", "reply A", "reply B", "reply C"]) {
      expect(text.split("\n").filter((l) => l === line)).toHaveLength(1);
    }
  });

  it("writes the same document to a file with -o", async () => {
    await get(["-o", path.join(dir, "chat.md")]);

    expect(read("chat.md")).toContain("### Branch 2 of 3 (current)\n\n## User\n\nask B");
  });

  it("gives JSON as the tree: messages with their links and the current message", async () => {
    await get(["-f", "json"]);

    const parsed = JSON.parse(out.join("")) as {
      currentRef: string;
      messages: Array<{ ref: string; parentRef: string | null; childRefs: string[] }>;
    };
    expect(parsed.messages).toHaveLength(8);
    expect(parsed.messages[0].parentRef).toBeNull();
    expect(parsed.messages[1].childRefs).toHaveLength(3);
    expect(parsed.messages.map((m) => m.ref)).toContain(parsed.currentRef);
  });

  it("leaves out ChatGPT's tool returns, as a single branch does", async () => {
    await get([], makeToolReturn(buildThreeBranchChat(), "u6", "search plumbing"));

    const text = out.join("");
    expect(text).not.toContain("search plumbing");
    expect(text).toContain("reply C");
  });

  it("fails on a chat with no messages, as a single branch does", async () => {
    const chat = buildThreeBranchChat();
    chat.messages = {};

    await expect(get([], chat)).rejects.toThrow("exit 1");
    expect(error).toHaveBeenCalledWith("Chat has no messages");
  });
});

describe("haevn get --all-branches with flags that pick one branch", () => {
  it.each([
    [["-m", "u4"], "--all-branches writes every branch, so it cannot be combined with --message."],
    [["--head", "2"], "--all-branches writes every branch, so it cannot be combined with --head."],
    [["--tail", "2"], "--all-branches writes every branch, so it cannot be combined with --tail."],
    [
      ["-m", "u4", "--head", "2", "-t", "1"],
      "--all-branches writes every branch, so it cannot be combined with --message or --head or --tail.",
    ],
  ])("%j exits 1 and asks the daemon nothing", async (rawArgs, message) => {
    await expect(get(rawArgs)).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(
      `${message} Drop ${rawArgs.length > 2 ? "them" : "it"}, or drop --all-branches to get one branch.`,
    );
    expect(daemonRequest).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("lets --head 0 and --tail 0 through, which cut nothing", async () => {
    await get(["--head", "0", "--tail", "0"]);

    expect(out.join("")).toContain("reply C");
    expect(error).not.toHaveBeenCalled();
  });

  it("still refuses a --head that is not a whole number, first", async () => {
    await expect(get(["--head", "-1"])).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith('--head must be a whole number, 0 or more (got "-1").');
  });
});

describe("haevn get --all-branches --include-media -o FILE", () => {
  beforeEach(() => serve({ "trunk.png": PNG, "shared.png": PNG, "b.mp4": MP4, "c.png": PNG }));

  it("numbers the files in the order the Markdown shows them", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")], mediaTree());

    const md = read("chat.md");
    expect(md).toContain("trunk answer\n\n![image](chat-media/01.png)");
    expect(md).toContain("reply A\n\n![image](chat-media/02.png)");
    expect(md).toContain("reply B\n\n![image](chat-media/02.png)\n\n[video](chat-media/03.mp4)");
    expect(md).toContain("reply C\n\n![image](chat-media/04.png)");
    expect(fs.readdirSync(path.join(dir, "chat-media")).sort()).toEqual([
      "01.png",
      "02.png",
      "03.mp4",
      "04.png",
    ]);
  });

  it("saves a file that two messages share once, and links it from both", async () => {
    await get(["--include-media", "-o", path.join(dir, "chat.md")], mediaTree());

    expect(vi.mocked(pipeOut).mock.calls.map(([, action]) => action.name)).toEqual([
      "trunk.png",
      "shared.png",
      "b.mp4",
      "c.png",
    ]);
    expect(read("chat.md").match(/chat-media\/02\.png/g)).toHaveLength(2);
  });

  it("leaves no gap in the numbers for a file that does not arrive, and names it once", async () => {
    serve({ "trunk.png": PNG, "b.mp4": MP4, "c.png": PNG });

    await expect(
      get(["--include-media", "-o", path.join(dir, "chat.md")], mediaTree()),
    ).rejects.toThrow("exit 1");

    expect(fs.readdirSync(path.join(dir, "chat-media")).sort()).toEqual([
      "01.png",
      "02.mp4",
      "03.png",
    ]);
    const md = read("chat.md");
    expect(md).toContain("reply A\n\n[image]");
    expect(md).toContain("reply B\n\n[image]\n\n[video](chat-media/02.mp4)");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("image shared.png was not saved: chat chat-1 has no media file"),
    );
  });

  it("stops before it fetches or writes anything when the folder is already there", async () => {
    fs.mkdirSync(path.join(dir, "chat-media"));
    fs.writeFileSync(path.join(dir, "chat-media", "01.png"), "someone else's");

    await expect(
      get(["--include-media", "-o", path.join(dir, "chat.md")], mediaTree()),
    ).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("chat-media already exists"));
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(read("chat-media", "01.png")).toBe("someone else's");
    expect(fs.existsSync(path.join(dir, "chat.md"))).toBe(false);
  });

  it("writes no folder and fetches nothing when there is no -o, and counts the shared file once", async () => {
    await get(["--include-media"], mediaTree());

    expect(out.join("")).toContain("trunk answer\n\n[image]");
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(vi.mocked(pipeOut)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "4 media files were not saved: add -o FILE to save them beside it.",
    );
  });

  it("saves one file for any number of items that hold it", async () => {
    const chat = buildThreeBranchChat();
    chat.messages.a1.message = reply("trunk answer", image("trunk.png"));
    chat.messages.a3.message = reply(
      "reply A",
      ...Array.from({ length: 10 }, () => image("trunk.png")),
    );

    await get(["--include-media", "-o", path.join(dir, "chat.md")], chat);

    expect(fs.readdirSync(path.join(dir, "chat-media"))).toEqual(["01.png"]);
    expect(read("chat.md").match(/chat-media\/01\.png/g)).toHaveLength(11);
    expect(vi.mocked(pipeOut)).toHaveBeenCalledTimes(1);
  });
});

describe("haevn get --all-branches --include-media -f json", () => {
  it("puts each message's media in its own entry, shared or not", async () => {
    serve({ "trunk.png": PNG, "shared.png": PNG, "b.mp4": MP4, "c.png": PNG });

    await get(["--include-media", "-f", "json"], mediaTree());

    const parsed = JSON.parse(out.join("")) as {
      messages: Array<{ content: string; media?: Array<{ kind: string; data: string }> }>;
    };
    const withMedia = parsed.messages.filter((m) => m.media);
    expect(withMedia.map((m) => m.media?.map((item) => item.kind))).toEqual([
      ["image"],
      ["image"],
      ["image", "video"],
      ["image"],
    ]);
    expect(withMedia[0].media?.[0].data).toBe(PNG.toString("base64"));
  });
});
