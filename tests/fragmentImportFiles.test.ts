import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HVN-163, slice 3: the archive page's way in. The handler of `importFragmentFiles` is the page's
// door to the same operation the CLI's import reaches (`importFragments`); here it runs on the real
// archive (Dexie on fake-indexeddb, the batch, the plan). What is not real: the search worker's
// index, thumbnails, the broadcast.

vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig: vi.fn(async () => ({ enabled: false, autoGenerate: false })),
  getStarmapConfig: vi.fn(async () => ({ enabled: false, embeddingsEnabled: false })),
  getCliSettings: vi.fn(),
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => {}),
}));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { collectFragmentFiles } from "../cli/src/commands/fragmentImport";
import { handleImportFragmentFiles } from "../src/background/handlers/importHandlers";
import { importFragments } from "../src/background/import/importFragments";
import { acquireOperationLock, releaseOperationLock } from "../src/background/state";
import { gatherFragmentSources, readFragmentFiles } from "../src/options/import/fragmentFiles";
import { getDB } from "../src/services/db";
import { ImportService } from "../src/services/importService";
import { SearchIndexManager } from "../src/services/searchIndexManager";
import type { BackgroundRequest, BackgroundResponse } from "../src/types/messaging";
import { ID_A, ID_B, ID_C, withId } from "./helpers/fragmentFile";

type Message = Extract<BackgroundRequest, { action: "importFragmentFiles" }>;

async function ask(
  files: { name: string; content: string }[],
  options: { dryRun: boolean; overwrite?: boolean },
): Promise<BackgroundResponse> {
  let reply: BackgroundResponse | undefined;
  const message: Message = {
    action: "importFragmentFiles",
    files,
    dryRun: options.dryRun,
    overwrite: options.overwrite ?? true,
  };
  await handleImportFragmentFiles(message, (response) => {
    reply = response;
  });
  if (!reply) throw new Error("the handler never answered");
  return reply;
}

/** The data of a successful answer */
function dataOf(reply: BackgroundResponse): {
  plan: { name: string; state: string; message?: string }[];
  imported?: {
    processed: number;
    saved: number;
    skipped: number;
    errors: number;
    failed: { name: string; message: string }[];
  };
} {
  if (!reply.success || !("data" in reply))
    throw new Error(`not a success: ${JSON.stringify(reply)}`);
  return reply.data as ReturnType<typeof dataOf>;
}

const states = (reply: BackgroundResponse) => dataOf(reply).plan.map((entry) => entry.state);
const stored = async () => (await getDB().chats.toArray()).map((chat) => chat.id).sort();

const FILE_A = withId("title: Alpha", "## User\nHello\n\n## Assistant\nHi\n", ID_A, "a.md");
const FILE_B = withId("title: Beta", "Only words\n", ID_B, "b.md");

beforeEach(async () => {
  const db = getDB();
  await Promise.all(
    [db.chats, db.chatMessages, db.chatMetadata, db.metadataQueue].map((table) => table.clear()),
  );
  await releaseOperationLock();
  // The index is the search worker's; saving a chat asks it to add the chat
  vi.spyOn(SearchIndexManager, "addOrUpdateChatInIndex").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the importFragmentFiles handler (HVN-163, slice 3)", () => {
  it("answers the plan of a dry run and writes nothing", async () => {
    const reply = await ask([FILE_A, FILE_B], { dryRun: true });

    expect(states(reply)).toEqual(["new", "new"]);
    expect(dataOf(reply).imported).toBeUndefined();
    expect(await stored()).toEqual([]);
  });

  it("imports what the plan allows, and a second dry run finds every file unchanged", async () => {
    const reply = await ask([FILE_A, FILE_B], { dryRun: false });

    expect(dataOf(reply).imported).toMatchObject({ processed: 2, saved: 2, errors: 0, failed: [] });
    expect(await stored()).toEqual([`fragment:${ID_B}`, `fragment:${ID_A}`]); // by id: B sorts first
    expect(states(await ask([FILE_A, FILE_B], { dryRun: true }))).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("leaves a refused file in the plan and imports the others", async () => {
    const noId = { name: "no-id.md", content: "---\ntitle: nothing\n---\nBody\n" };

    const reply = await ask([noId, FILE_A], { dryRun: false });

    expect(states(reply)).toEqual(["no-id", "new"]);
    expect(dataOf(reply).imported).toMatchObject({ saved: 1, errors: 0 });
    expect(await stored()).toEqual([`fragment:${ID_A}`]);
  });

  it("keeps a changed fragment's chat when overwrite is off, and replaces it when it is on", async () => {
    await ask([FILE_A], { dryRun: false });
    const edited = withId("title: Alpha", "## User\nHello again\n", ID_A, "a.md");

    const kept = await ask([edited], { dryRun: false, overwrite: false });

    expect(states(kept)).toEqual(["changed"]);
    expect(dataOf(kept).imported).toMatchObject({ saved: 0, skipped: 1 });
    const before = await getDB().chats.get(`fragment:${ID_A}`);
    expect(JSON.stringify(before?.params)).not.toContain("Hello again");

    const replaced = await ask([edited], { dryRun: false, overwrite: true });

    expect(dataOf(replaced).imported).toMatchObject({ saved: 1, skipped: 0 });
    const after = await getDB().chats.get(`fragment:${ID_A}`);
    expect(after?.params?.fragment).not.toEqual(before?.params?.fragment);
  });

  it("names the files that could not be saved, and saves the others", async () => {
    const save = ImportService.saveImportedChat.bind(ImportService);
    vi.spyOn(ImportService, "saveImportedChat").mockImplementation(async (chat, raw, options) => {
      if (chat.id === `fragment:${ID_B}`) throw new Error("the disk is full");
      return save(chat, raw, options);
    });

    const reply = await ask([FILE_A, FILE_B], { dryRun: false });

    expect(dataOf(reply).imported).toMatchObject({
      saved: 1,
      errors: 1,
      failed: [{ name: "b.md", message: "the disk is full" }],
    });
    expect(await stored()).toEqual([`fragment:${ID_A}`]);
  });

  it("answers BUSY, with the operation, when another operation holds the lock; a dry run goes on", async () => {
    await acquireOperationLock("bulkSync");

    const busy = await ask([FILE_A], { dryRun: false });
    const dry = await ask([FILE_A], { dryRun: true });

    expect(busy).toMatchObject({ success: false, errorCode: "BUSY", activeOperation: "bulkSync" });
    expect(await stored()).toEqual([]);
    expect(states(dry)).toEqual(["new"]);
  });

  it("refuses a request with no files, or with a file that has no text", async () => {
    expect(await ask([], { dryRun: true })).toMatchObject({ success: false });
    expect(
      await ask([{ name: "x.md", content: undefined as unknown as string }], { dryRun: true }),
    ).toMatchObject({ success: false });
  });

  it("writes nothing for a request that does not say dryRun and overwrite", async () => {
    const answer = async (partial: Record<string, unknown>) => {
      let reply: BackgroundResponse | undefined;
      await handleImportFragmentFiles(
        { action: "importFragmentFiles", files: [FILE_A], ...partial } as Message,
        (response) => {
          reply = response;
        },
      );
      return reply;
    };

    expect(await answer({ overwrite: true })).toMatchObject({ success: false });
    expect(await answer({ dryRun: false })).toMatchObject({ success: false });
    expect(await answer({ dryRun: "no", overwrite: true })).toMatchObject({ success: false });
    expect(await stored()).toEqual([]);
  });
});

describe("the page and the CLI read a file alike (HVN-163, slice 3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-fragment-parity-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Files whose bytes tell the two readers apart: a byte-order mark, CRLF, non-ASCII, bad UTF-8 */
  function writeFolder(): void {
    const body = "## User\nCafé — naïve “quotes”\r\n\r\n## Assistant\nA reply ✓\r\n";
    fs.writeFileSync(path.join(dir, "bom.md"), `﻿---\r\nid: ${ID_A}\r\n---\r\n${body}`);
    fs.writeFileSync(
      path.join(dir, "crlf.md"),
      `---\r\nid: ${ID_B}\r\ntitle: Seagulls\r\n---\r\n${body}`,
    );
    fs.writeFileSync(path.join(dir, "plain.md"), `---\nid: ${ID_C}\n---\nOnly words\n`);
    fs.writeFileSync(
      path.join(dir, "latin1.md"),
      Buffer.from("---\nid: x\n---\ncaf\xe9\n", "latin1"),
    );
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a fragment");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "dot-file");
  }

  async function pageReads() {
    const files = fs
      .readdirSync(dir)
      .map((name) => new File([fs.readFileSync(path.join(dir, name))], name));
    const gathered = gatherFragmentSources([
      {
        kind: "folder",
        name: path.basename(dir),
        entries: files.map((file) => ({ name: file.name, file })),
      },
    ]);
    const read = await readFragmentFiles(gathered);
    if (!read) throw new Error("the read was cancelled");
    return { gathered, read };
  }

  it("gives the same text for every file, the same refusal for bad UTF-8, and the same count left out", async () => {
    writeFolder();

    const cli = await collectFragmentFiles([dir]);
    const page = await pageReads();

    expect(page.read.files.map((f) => f.content)).toEqual(cli.files.map((f) => f.content));
    expect(page.read.files.map((f) => f.name)).toEqual(cli.files.map((f) => path.basename(f.name)));
    expect(page.read.refused).toMatchObject([
      { name: "latin1.md", message: cli.refused[0].message },
    ]);
    expect(page.gathered.notMarkdown).toBe(cli.notMarkdown);
    // The mark is kept, not stripped: it is part of the file's hash
    expect(page.read.files.find((f) => f.name === "bom.md")?.content.startsWith("﻿")).toBe(true);
  });

  it("a folder imported from the page is unchanged for the CLI's import, and the other way round", async () => {
    writeFolder();
    const cli = await collectFragmentFiles([dir]);
    const page = await pageReads();

    // From the page, then the CLI's own call (the bridge's `importFragments`) on the CLI's reading
    expect(dataOf(await ask(page.read.files, { dryRun: false })).imported).toMatchObject({
      saved: 3,
    });
    const fromCli = await importFragments(cli.files, {
      dryRun: true,
      overwrite: true,
      index: false,
    });
    expect(fromCli.plan.map((entry) => entry.state)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);

    // From the CLI's reading, then the page's
    await getDB().chats.clear();
    await importFragments(cli.files, { dryRun: false, overwrite: true, index: false });
    expect(states(await ask(page.read.files, { dryRun: true }))).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });
});
