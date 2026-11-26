import { beforeAll, describe, expect, it } from "vitest";
import { roughDateOf } from "../src/model/roughDate";
import {
  assertReassembles,
  FRAGMENT_PARSER_VERSION,
  type FragmentLookup,
  type FragmentParams,
  fragmentProvider,
  planFragmentImport,
  transformFragmentToHaevnChat,
} from "../src/providers/fragment";
import { registerAllProviders } from "../src/providers/index";
import { getProvider, isImportOnlyProvider } from "../src/providers/provider";
import { extractIndexedChat } from "../src/services/searchDocument";
import {
  emptyLookup,
  fragmentFile,
  ID_A,
  ID_B,
  ID_C,
  parsed,
  withId,
} from "./helpers/fragmentFile";

// HVN-163: the chat a fragment becomes, and the plan of an import.

const NOW = 1_800_000_000_000;

async function chatOf(extra: string, body: string) {
  return transformFragmentToHaevnChat(await parsed(withId(extra, body)), NOW);
}

describe("the fragment provider", () => {
  beforeAll(() => registerAllProviders());

  it("is registered, import-only, and has no live source", async () => {
    expect(getProvider("fragment")).toBe(fragmentProvider);
    expect(isImportOnlyProvider("fragment")).toBe(true);
    expect(fragmentProvider.importer).toBeUndefined();
    await expect(fragmentProvider.extractor.extractData()).rejects.toThrow(/import-only/);
    expect(fragmentProvider.getListUrl()).toBe("");
    expect(fragmentProvider.buildChatUrl("x")).toBe("");
  });

  it("has a name no other provider's name is part of, and no other provider's name is part of it", () => {
    const others = [
      "claude",
      "chatgpt",
      "gemini",
      "poe",
      "pi",
      "qwen",
      "grok",
      "codex",
      "deepseek",
    ];
    for (const name of others) expect("fragment".includes(name), name).toBe(false);
  });
});

describe("the chat a fragment becomes", () => {
  it("is an ordinary chat under the fragment: id, from an import-only source", async () => {
    const chat = await chatOf("title: The keeper\nmodel: claude-3-opus", "TB says hi\n");
    expect(chat).toMatchObject({
      id: `fragment:${ID_A}`,
      source: "fragment",
      sourceId: ID_A,
      title: "The keeper",
      models: ["claude-3-opus"],
      deleted: 0,
      syncStatus: "new",
      lastSyncedTimestamp: NOW,
    });
  });

  it("makes the messages of the worked example, in a chain, in file order", async () => {
    const chat = await chatOf(
      "date: ~2024-03\nmodel: claude-3-opus\nspeakers:\n  user: [TB]\n  assistant: [Claude-3-Opus]",
      "TB\nTell me about the keeper.\n\nClaude-3-Opus\nHe kept the light for forty years.\n",
    );
    expect(Object.keys(chat.messages)).toEqual(["t0001", "t0002"]);
    expect(chat.currentId).toBe("t0002");
    expect(chat.messages.t0001).toMatchObject({
      parentId: undefined,
      childrenIds: ["t0002"],
      model: "claude-3-opus",
      done: true,
      chatId: `fragment:${ID_A}`,
    });
    expect(chat.messages.t0002.parentId).toBe("t0001");
    const [request] = chat.messages.t0001.message;
    expect(request).toMatchObject({
      kind: "request",
      parts: [{ part_kind: "user-prompt", content: "Tell me about the keeper." }],
    });
    const [response] = chat.messages.t0002.message;
    expect(response).toMatchObject({
      kind: "response",
      model_name: "claude-3-opus",
      parts: [{ part_kind: "text", content: "He kept the light for forty years." }],
    });
  });

  it("dates each turn one ms after the one before it, so that order is kept when time is not known", async () => {
    const chat = await chatOf(
      "date: 2024-03-15",
      "## User\none\n## Assistant\ntwo\n## User\nthree\n",
    );
    const noon = Date.parse("2024-03-15T12:00:00Z");
    expect(chat.timestamp).toBe(noon);
    expect(chat.providerLastModifiedTimestamp).toBe(noon);
    expect(Object.values(chat.messages).map((m) => m.timestamp)).toEqual([
      noon,
      noon + 1,
      noon + 2,
    ]);
    const iso = (i: number) => {
      const message = chat.messages[`t000${i}`].message[0];
      return message.kind === "request" ? message.parts[0].timestamp : message.timestamp;
    };
    expect([iso(1), iso(2), iso(3)]).toEqual([
      "2024-03-15T12:00:00.000Z",
      "2024-03-15T12:00:00.001Z",
      "2024-03-15T12:00:00.002Z",
    ]);
  });

  it("pads ids to at least four digits, and to more when there are more turns", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `## User\n${i}\n`).join("");
    expect(Object.keys((await chatOf("", body)).messages)[11]).toBe("t0012");
  });

  it("keeps a rough date in params, and the middle of it in the timestamps", async () => {
    const chat = await chatOf("date: ~2024-03", "words\n");
    const rough = roughDateOf(chat);
    expect(rough).toEqual({
      text: "~2024-03",
      precision: "month",
      approximate: true,
      from: Date.parse("2024-03-01T00:00:00Z"),
      to: Date.parse("2024-04-01T00:00:00Z"),
    });
    expect(chat.timestamp).toBe(Math.floor(((rough?.from ?? 0) + (rough?.to ?? 0)) / 2));
  });

  it("gives an undated fragment the timestamp 0, which keeps it in the Modified Time index", async () => {
    const chat = await chatOf("", "words\n");
    expect(chat.timestamp).toBe(0);
    expect(chat.providerLastModifiedTimestamp).toBe(0);
    expect(roughDateOf(chat)).toMatchObject({ precision: "unknown" });
  });

  it("gives an exact time no rough date", async () => {
    const chat = await chatOf("date: 2024-03-15T14:30:00Z", "words\n");
    expect(chat.timestamp).toBe(Date.parse("2024-03-15T14:30:00Z"));
    expect(chat.params.roughDate).toBeUndefined();
  });

  it("writes no model when the file names none: models empty, each message's model the empty string", async () => {
    const chat = await chatOf("", "## User\nhi\n## Assistant\nho\n");
    expect(chat.models).toEqual([]);
    expect(Object.values(chat.messages).map((m) => m.model)).toEqual(["", ""]);
    const response = chat.messages.t0002.message[0];
    expect(response.kind === "response" && "model_name" in response).toBe(false);
  });

  it("never takes the file name for a title", async () => {
    const chat = await chatOf("", "words\n");
    expect(chat.title).toBe("");
    expect((chat.params.fragment as FragmentParams).fileName).toBe("fragment.md");
  });

  it("keeps the folder out of the stored file name", async () => {
    const file = withId("", "words\n", ID_A, "/home/someone/private/notes/keeper.md");
    const chat = transformFragmentToHaevnChat(await parsed(file), NOW);
    expect((chat.params.fragment as FragmentParams).fileName).toBe("keeper.md");
  });

  it("adds the platform and the collection to the tags, in order and once", async () => {
    const chat = await chatOf(
      "tags: [poem, poe, poem]\nplatform: poe\ncollection: Ghosts\npart: 2",
      "words\n",
    );
    expect(chat.tags).toEqual(["poem", "poe", "Ghosts"]);
    expect(chat.params.fragment).toMatchObject({
      platform: "poe",
      collection: "Ghosts",
      part: "2",
    });
  });

  it("keeps the whole of what the parser needs to put the file back", async () => {
    const chat = await chatOf("speakers:\n  user: [Q]\n# note", "Q\nhi\n");
    expect(chat.params.fragment).toMatchObject({
      v: FRAGMENT_PARSER_VERSION,
      frontmatter: `id: ${ID_A}\nspeakers:\n  user: [Q]\n# note`,
      seams: ["Q\n"],
      tail: "\n",
      speakers: { user: ["Q"] },
      unattributed: [],
    });
    expect(chat.params.fragment).toMatchObject({
      fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("lists the messages whose text nobody is named for", async () => {
    const chat = await chatOf("speakers:\n  assistant: [Bot]", "a preface\n\nBot\nreply\n");
    expect((chat.params.fragment as FragmentParams).unattributed).toEqual([0]);
    expect((await chatOf("", "words\n")).params.fragment).toMatchObject({ unattributed: [0] });
  });

  it("puts a system prompt of the frontmatter and a system turn of the body on the first request", async () => {
    const chat = await chatOf(
      "system: Be brief.",
      "# System\nAnswer in verse.\n# User\nhi\n# User\nagain\n",
    );
    expect(chat.system).toBe("Be brief.\n\nAnswer in verse.");
    expect(Object.keys(chat.messages)).toEqual(["t0001", "t0002"]);
    const [first] = chat.messages.t0001.message;
    expect(first.kind === "request" && first.parts.map((p) => p.part_kind)).toEqual([
      "system-prompt",
      "user-prompt",
    ]);
    const [second] = chat.messages.t0002.message;
    expect(second.kind === "request" && second.parts).toHaveLength(1);
  });
});

describe("the metadata a file gives, or leaves to generation", () => {
  it("gives a title: the record is the person's, and holds the title", async () => {
    expect((await chatOf("title: Named", "x")).haevnMetadata).toEqual({ title: "Named" });
  });

  it("gives any one field: only that field is carried", async () => {
    expect((await chatOf("description: A note\nkeywords: [a, b]", "x")).haevnMetadata).toEqual({
      description: "A note",
      keywords: ["a", "b"],
    });
    expect((await chatOf("categories: [poem]", "x")).haevnMetadata).toEqual({
      categories: ["poem"],
    });
  });

  it("gives none: no record is carried, and the chat is generated like any import", async () => {
    expect((await chatOf("model: m\ntags: [t]", "x")).haevnMetadata).toBeUndefined();
  });

  it("is exempted with generate: false: a record that holds the chat's own (empty) title", async () => {
    expect((await chatOf("generate: false", "x")).haevnMetadata).toEqual({ title: "" });
    expect((await chatOf("generate: false\ndescription: d", "x")).haevnMetadata).toEqual({
      description: "d",
    });
    expect((await chatOf("generate: true", "x")).haevnMetadata).toBeUndefined();
  });
});

describe("what the search index takes from a fragment", () => {
  it("leaves out a model nobody named, and reads an empty title as none", async () => {
    const chat = await chatOf("", "## User\nhi\n## Assistant\nho\n");
    const indexed = extractIndexedChat(chat);
    expect(indexed.title).toBe("");
    expect(indexed.messages.map((m) => m.model)).toEqual([undefined, undefined]);
    expect(indexed.timestamp).toBe(0);
  });
});

describe("the plan", () => {
  const stored =
    (fileSha256: string, v = FRAGMENT_PARSER_VERSION): FragmentLookup["stored"] =>
    async () => ({ fileSha256, v });

  it("gives every state of the table, in the order of the files", async () => {
    const files = [
      withId("", "new one\n", ID_A, "new.md"),
      withId("", "old one\n", ID_B, "unchanged.md"),
      withId("", "edited one\n", ID_C, "changed.md"),
      { name: "bare.md", content: "no frontmatter\n" },
      fragmentFile("id: nope", "x\n", "bad-id.md"),
      fragmentFile(`id: 11111111-1111-4111-8111-111111111111\ndate: March`, "x\n", "bad-date.md"),
      fragmentFile("id: 22222222-2222-4222-8222-222222222222\ntitle: [", "x\n", "unreadable.md"),
    ];
    const unchangedSha = (await parsed(files[1])).fileSha256;
    const plan = await planFragmentImport(files, {
      stored: async (id) =>
        id === ID_B
          ? { fileSha256: unchangedSha, v: FRAGMENT_PARSER_VERSION }
          : id === ID_C
            ? { fileSha256: "0".repeat(64), v: FRAGMENT_PARSER_VERSION }
            : undefined,
      withBody: async () => undefined,
    });
    expect(plan.entries.map((e) => [e.name, e.state])).toEqual([
      ["new.md", "new"],
      ["unchanged.md", "unchanged"],
      ["changed.md", "changed"],
      ["bare.md", "no-id"],
      ["bad-id.md", "bad-id"],
      ["bad-date.md", "bad-date"],
      ["unreadable.md", "unreadable"],
    ]);
    expect(plan.importable.map((p) => p.entry.name)).toEqual(["new.md", "changed.md"]);
    expect(plan.entries[3].message).toMatch(/no frontmatter/);
  });

  it("calls a file changed when the parser that stored it was older, though its bytes are equal", async () => {
    const file = withId("", "same bytes\n");
    const sha = (await parsed(file)).fileSha256;
    const older = await planFragmentImport([file], {
      stored: stored(sha, 0),
      withBody: async () => undefined,
    });
    expect(older.entries[0].state).toBe("changed");
    const current = await planFragmentImport([file], {
      stored: stored(sha),
      withBody: async () => undefined,
    });
    expect(current.entries[0].state).toBe("unchanged");
  });

  it("refuses both files that share an id and differ, and is not moved by their order", async () => {
    const one = withId("", "first text\n", ID_A, "a.md");
    const two = withId("", "second text\n", ID_A, "b.md");
    for (const files of [
      [one, two],
      [two, one],
    ]) {
      const plan = await planFragmentImport(files, emptyLookup);
      expect(plan.entries.map((e) => e.state)).toEqual(["duplicate-id", "duplicate-id"]);
      expect(plan.importable).toEqual([]);
    }
  });

  it("imports the first of two byte-equal files that share an id, and skips the other", async () => {
    const plan = await planFragmentImport(
      [withId("", "same\n", ID_A, "a.md"), withId("", "same\n", ID_A, "b.md")],
      emptyLookup,
    );
    expect(plan.entries.map((e) => e.state)).toEqual(["new", "same-file"]);
    expect(plan.entries[1].message).toBe("same file as a.md");
    expect(plan.importable).toHaveLength(1);
  });

  it("refuses three files that share an id when one of them differs", async () => {
    const plan = await planFragmentImport(
      [
        withId("", "same\n", ID_A, "a.md"),
        withId("", "same\n", ID_A, "b.md"),
        withId("", "other\n", ID_A, "c.md"),
      ],
      emptyLookup,
    );
    expect(plan.entries.map((e) => e.state)).toEqual([
      "duplicate-id",
      "duplicate-id",
      "duplicate-id",
    ]);
  });

  it("does not stop the other files when one is refused", async () => {
    const plan = await planFragmentImport(
      [{ name: "bad.md", content: "nothing\n" }, withId("", "fine\n")],
      emptyLookup,
    );
    expect(plan.importable.map((p) => p.entry.name)).toEqual(["fragment.md"]);
  });

  it("warns that a new file repeats a body the archive already holds under another id", async () => {
    const plan = await planFragmentImport([withId("", "a text held twice\n", ID_B)], {
      stored: async () => undefined,
      withBody: async () => ({ id: ID_A, fileName: "first-copy.md" }),
    });
    expect(plan.entries[0].state).toBe("new");
    expect(plan.entries[0].warnings).toEqual([
      expect.objectContaining({ code: "copy", message: expect.stringContaining("first-copy.md") }),
    ]);
  });

  it("warns of a copy inside the import too, on the later file", async () => {
    const plan = await planFragmentImport(
      [withId("", "twice\n", ID_A, "a.md"), withId("", "twice\n", ID_B, "b.md")],
      emptyLookup,
    );
    expect(plan.entries[0].warnings).toEqual([]);
    expect(plan.entries[1].warnings[0]).toMatchObject({ code: "copy" });
    expect(plan.entries[1].warnings[0].message).toContain("a.md");
    expect(plan.entries.map((e) => e.state)).toEqual(["new", "new"]);
  });

  it("describes each file for the dry run: title, date as shown, turns and warnings", async () => {
    const plan = await planFragmentImport(
      [
        withId(
          "title: T\ndate: ~2024-03\nspeakers:\n  asistant: [x]",
          "## User\na\n## Assistant\nb\n",
        ),
      ],
      emptyLookup,
    );
    expect(plan.entries[0]).toMatchObject({
      id: ID_A,
      title: "T",
      date: "c. Mar 2024",
      turns: 2,
      warnings: [{ code: "speakers-unknown-key" }],
    });
  });
});

describe("assertReassembles", () => {
  it("passes a chat that gives back the body of its file", async () => {
    const fragment = await parsed(withId("", "## User\nhello\n## Assistant\nworld\n"));
    const chat = transformFragmentToHaevnChat(fragment, NOW);

    await expect(assertReassembles(chat, fragment)).resolves.toBeUndefined();
  });

  it("throws when a turn is no longer what the file had, naming the file and no text", async () => {
    const fragment = await parsed(withId("", "## User\nhello\n## Assistant\nworld\n"));
    const chat = transformFragmentToHaevnChat(fragment, NOW);
    const [first] = Object.values(chat.messages);
    const request = first.message[0];
    if (request.kind !== "request") throw new Error("the first turn is a request");
    const part = request.parts[0];
    if (part.part_kind !== "user-prompt") throw new Error("the first part is a prompt");
    part.content = "hello, altered";

    const failure = await assertReassembles(chat, fragment).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("fragment.md");
    expect((failure as Error).message).not.toContain("altered");
  });
});
