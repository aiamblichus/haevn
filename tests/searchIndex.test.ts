import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type IndexedChat, type IndexedMessage, LABEL_IDS } from "../src/services/searchDocument";
import {
  INDEX_FORMAT_VERSION,
  type IndexFilters,
  type MarkedPassage,
  openSqliteHost,
  SqliteSearchIndex,
  type SearchIndex,
} from "../src/services/searchIndex";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildQueryPlan, buildRelaxedPlan } from "../src/services/searchWorkerQuery";
import { type IndexKit, kits, sqliteKit } from "./helpers/indexKit";

function chat(
  id: string,
  texts: string[],
  extra: Partial<Pick<IndexedChat, "title" | "source" | "timestamp" | "models" | "tags">> = {},
): IndexedChat {
  const messages: IndexedMessage[] = texts.map((text, i) => ({
    id: `${id}-m${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text,
  }));
  return {
    id,
    title: "",
    source: "test",
    timestamp: 1_000,
    models: [],
    tags: [],
    messages,
    ...extra,
  };
}

const plan = (query: string) => buildQueryPlan(parseSearchQuery(query));

/** The marked words of a passage, as the text says them. */
const marked = (passage: MarkedPassage) =>
  passage.marks.map((m) => passage.text.slice(m.start, m.start + m.length));

describe.each(kits)("the search index, on $name (HVN-87)", (kit: IndexKit) => {
  let index: SearchIndex;

  /** Open, and make an index to write to the way the worker does: a rebuild with nothing in it. */
  async function openWith(...chats: IndexedChat[]): Promise<SearchIndex> {
    index = kit.create();
    await index.open();
    const build = index.beginRebuild();
    build.transaction(() => {
      for (const c of chats) build.put(c);
    });
    build.commit();
    return index;
  }

  const ids = (query: string, filters?: IndexFilters) =>
    index
      .search(plan(query), filters)
      .map((r) => r.chatId)
      .sort();

  beforeEach(() => {
    kit.reset();
  });

  afterEach(() => {
    index?.close();
  });

  describe("what a chat is when it matches", () => {
    it("takes a chat that has no source and a time that is not a number, as the old index did", async () => {
      const odd = {
        ...chat("odd", ["a wombat"]),
        source: undefined,
        timestamp: Number.NaN,
        messages: [{ id: "m", role: "user", text: "a wombat", timestamp: Number.NaN }],
      } as unknown as IndexedChat;
      await openWith(odd, chat("fine", ["a wombat"]));

      expect(ids("wombat")).toEqual(["fine", "odd"].sort());
      expect(ids("wombat", { provider: "" })).toEqual(["odd"]);
    });

    it("answers a query of as many words as the parser lets through", async () => {
      await openWith(chat("a", ["word0 word1"]));
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");

      expect(parseSearchQuery(words).problem).toBeUndefined();
      expect(ids(words)).toEqual([]);
      expect(ids("word0 word1")).toEqual(["a"]);
    });

    it("has every word, in any of its messages, and not only where one message has them all", async () => {
      await openWith(
        chat("apart", ["we talked about wombats", "and later about kubernetes"]),
        chat("only-a", ["wombats everywhere"]),
        chat("only-b", ["kubernetes everywhere"]),
      );

      expect(ids("wombats kubernetes")).toEqual(["apart"]);
      expect(ids("wombats")).toEqual(["apart", "only-a"]);
    });

    it("finds the words of a title and of the messages together", async () => {
      await openWith(chat("t", ["the body says kubernetes"], { title: "About wombats" }));

      expect(ids("wombats kubernetes")).toEqual(["t"]);
    });

    it("keeps a phrase to the words next to each other, whatever stands between them", async () => {
      await openWith(
        chat("exact", ["say hello world, please"]),
        chat("comma", ["say hello, world please"]),
        chat("apart", ["hello there world"]),
        chat("reversed", ["world hello"]),
      );

      expect(ids('"hello world"')).toEqual(["comma", "exact"]);
    });

    it("keeps a phrase inside one message", async () => {
      await openWith(chat("split", ["ends with hello", "world starts here"]));

      expect(ids('"hello world"')).toEqual([]);
      expect(ids("hello world")).toEqual(["split"]);
    });

    it("finds a phrase of stop words", async () => {
      await openWith(
        chat("a", ["to be or not"]),
        chat("b", ["not to be"]),
        chat("c", ["do be well"]),
      );

      expect(ids('"to be"')).toEqual(["a", "b"]);
    });

    it("matches a prefix, and leaves out the word typed with a minus", async () => {
      await openWith(
        chat("a", ["recursion and rlhf"]),
        chat("b", ["recursive things"]),
        chat("c", ["a rectangle"]),
      );

      expect(ids("recurs*")).toEqual(["a", "b"]);
      expect(ids("recurs* -rlhf")).toEqual(["b"]);
    });

    it("takes any of the words of a relaxed plan", async () => {
      await openWith(chat("a", ["migrate the database"]), chat("b", ["cook rice"]));

      const relaxed = buildRelaxedPlan(parseSearchQuery("migrate rice"));

      expect(
        index
          .search(relaxed as NonNullable<typeof relaxed>)
          .map((r) => r.chatId)
          .sort(),
      ).toEqual(["a", "b"]);
    });

    it("finds a nearby spelling for a word typed with ~N, and no more than N away", async () => {
      await openWith(chat("a", ["we run kubernetes at work"]), chat("b", ["we run nothing"]));

      expect(ids("kubernates~1")).toEqual(["a"]);
      expect(ids("kubarnetes~1")).toEqual(["a"]);
      expect(ids("kubarnates~1")).toEqual([]);
      expect(ids("kubarnates~2")).toEqual(["a"]);
      expect(ids("kubarnatez~2")).toEqual([]);
    });

    it("does not take a word of the query for an operator", async () => {
      await openWith(chat("a", ["this AND that, or NOT, near * (x) col:y"]), chat("b", ["that"]));

      expect(ids("and")).toEqual(["a"]);
      expect(ids("not")).toEqual(["a"]);
      expect(ids("col:y")).toEqual(["a"]);
      expect(ids('"a" "b" "c')).toEqual([]);
    });
  });

  describe("words as the index cuts and folds them", () => {
    it("finds an accented word without the accent, and the other way round", async () => {
      await openWith(chat("a", ["a quiet café"]), chat("b", ["a plain cafe"]));

      expect(ids("cafe")).toEqual(["a", "b"]);
      expect(ids("café")).toEqual(["a", "b"]);
      expect(ids("CAFÉ")).toEqual(["a", "b"]);
    });

    it("finds İstanbul by either spelling, and a decomposed é", async () => {
      await openWith(chat("tr", ["İstanbul is big"]), chat("fr", ["école"]));

      expect(ids("istanbul")).toEqual(["tr"]);
      expect(ids("İstanbul")).toEqual(["tr"]);
      expect(ids("ecole")).toEqual(["fr"]);
    });

    it("keeps Cyrillic letters apart where a Russian reader does, and folds their case", async () => {
      await openWith(chat("ru", ["Привет, мир! Йод и ёж"]));

      expect(ids("привет")).toEqual(["ru"]);
      expect(ids("ПРИВЕТ")).toEqual(["ru"]);
      expect(ids("йод")).toEqual(["ru"]);
      expect(ids("иод")).toEqual([]);
      expect(ids("ёж")).toEqual(["ru"]);
      expect(ids("еж")).toEqual([]);
    });

    it("finds a run of CJK characters whole, an emoji, and a word with an underscore", async () => {
      await openWith(chat("zh", ["他说 你好世界。 再见 😀, snake_case"]));

      expect(ids("你好世界")).toEqual(["zh"]);
      expect(ids("😀")).toEqual(["zh"]);
      expect(ids("snake_case")).toEqual(["zh"]);
      expect(ids("snake")).toEqual([]);
    });

    it("cuts a hyphen, a dot and a slash, and finds the words together", async () => {
      await openWith(chat("a", ["local-first software and foo.bar"]), chat("b", ["a local shop"]));

      expect(ids("local-first")).toEqual(["a"]);
      expect(ids("foo.bar")).toEqual(["a"]);
    });
  });

  describe("filters", () => {
    const crowd = () => [
      chat("old", ["pineapple"], { timestamp: 100, source: "claude" }),
      chat("mid", ["pineapple"], { timestamp: 200, source: "chatgpt" }),
      chat("new", ["pineapple"], { timestamp: 300, source: "claude" }),
    ];

    it("cut the chats by date and by source before anything is counted", async () => {
      await openWith(...crowd());

      expect(ids("pineapple", { after: 150 })).toEqual(["mid", "new"]);
      expect(ids("pineapple", { before: 250 })).toEqual(["mid", "old"]);
      expect(ids("pineapple", { after: 150, before: 250 })).toEqual(["mid"]);
      expect(ids("pineapple", { provider: "claude" })).toEqual(["new", "old"]);
      expect(ids("pineapple", { chatId: "mid" })).toEqual(["mid"]);
    });
  });

  describe("passages", () => {
    it("are the messages that have a word, in order, marked on the words the index matched", async () => {
      await openWith(
        chat("a", ["one pineapple, two", "nothing here", "(pineapple) and pineapples; last"]),
      );

      const passages = index.passages(plan("pineapple"), "a");

      expect(passages.map((p) => p.messageId)).toEqual(["a-m1", "a-m3"]);
      expect(passages.map(marked)).toEqual([["pineapple"], ["pineapple"]]);
      expect(passages[0].text).toBe("one pineapple, two");
      expect(passages[0].role).toBe("user");
      expect(passages[1].role).toBe("user");
    });

    it("mark the whole word of a prefix and of a near spelling, and a phrase as one span", async () => {
      await openWith(chat("a", ["we were running, late; kubernetes; say hello, world"]));

      expect(index.passages(plan("run*"), "a").map(marked)).toEqual([["running"]]);
      expect(index.passages(plan("kubernates~2"), "a").map(marked)).toEqual([["kubernetes"]]);
      expect(index.passages(plan('"hello world"'), "a").map(marked)).toEqual([["hello, world"]]);
    });

    it("mark an accented word by what the text has, not by what was typed", async () => {
      await openWith(chat("a", ["the Café and İstanbul"]));

      expect(index.passages(plan("cafe istanbul"), "a").map(marked)).toEqual([
        ["Café", "İstanbul"],
      ]);
    });

    it("hold a match after text whose lower case is longer, at the place the text has it", async () => {
      await openWith(chat("a", [`${"İ".repeat(40)} pineapple`]));

      const [passage] = index.passages(plan("pineapple"), "a");

      expect(marked(passage)).toEqual(["pineapple"]);
      expect(passage.marks[0].start).toBe(41);
    });

    it("carry the title as a message of its own, and the system prompt", async () => {
      await openWith({
        ...chat("a", ["a body"]),
        title: "About pineapple",
        messages: [
          { id: "system", role: "user", text: "pineapple expert" },
          ...chat("a", ["a body"]).messages,
        ],
      });

      expect(index.passages(plan("pineapple"), "a").map((p) => p.messageId)).toEqual([
        "title",
        "system",
      ]);
    });

    it("are one for a message, the user's text before the assistant's, whichever has the word", async () => {
      await openWith({
        ...chat("a", []),
        messages: [
          { id: "m1", role: "user", text: "a pineapple question" },
          { id: "m1", role: "assistant", text: "a pineapple answer" },
          { id: "m2", role: "user", text: "nothing" },
          { id: "m2", role: "assistant", text: "an answer about pineapple" },
        ],
      });

      const passages = index.passages(plan("pineapple"), "a");

      expect(passages.map((p) => [p.messageId, p.role])).toEqual([
        ["m1", "user"],
        ["m2", "assistant"],
      ]);
      expect(index.passages(plan("pineapple"), "a", 1).map((p) => p.messageId)).toEqual(["m1"]);
    });

    it("stop at the limit", async () => {
      await openWith(chat("a", ["pineapple 1", "pineapple 2", "pineapple 3"]));

      expect(index.passages(plan("pineapple"), "a", 2)).toHaveLength(2);
    });

    describe("for many chats at once", () => {
      // More than the index reads one by one, with words, a prefix and a near spelling.
      const crowd = (n: number) =>
        Array.from({ length: n }, (_, i) =>
          chat(`c${String(i).padStart(2, "0")}`, [
            `first ${i % 3 === 0 ? "pineapple" : "mango"} question`,
            `an ${i % 2 === 0 ? "pineapples" : "answer"} about it`,
            `last pineapple note ${i}`,
          ]),
        );

      it.each([
        "pineapple",
        "pine*",
        "pineaple~1",
        "mango pineapple",
      ])("are the passages that each chat gives alone, for %s", async (query) => {
        await openWith(...crowd(20));
        const ids = crowd(20).map((c) => c.id);

        const together = index.passagesFor(plan(query), ids, 2);

        expect(together.size).toBeGreaterThan(0);
        for (const id of ids) {
          expect(together.get(id) ?? []).toEqual(index.passages(plan(query), id, 2));
        }
      });

      it("leave a chat with no passage out of the map, and an unknown chat", async () => {
        await openWith(...crowd(12), chat("none", ["nothing here"]));

        const together = index.passagesFor(
          plan("mango"),
          [...crowd(12).map((c) => c.id), "none", "unknown"],
          4,
        );

        expect(together.has("none")).toBe(false);
        expect(together.has("unknown")).toBe(false);
        expect(together.has("c01")).toBe(true);
      });

      it("give every passage of a chat when there is no limit", async () => {
        await openWith(...crowd(12));

        const together = index.passagesFor(
          plan("pine*"),
          crowd(12).map((c) => c.id),
          -1,
        );

        expect(together.get("c00")?.map((p) => p.messageId)).toEqual([
          "c00-m1",
          "c00-m2",
          "c00-m3",
        ]);
      });
    });

    it("keep the time and the model of the message", async () => {
      await openWith({
        ...chat("a", ["pineapple"]),
        messages: [
          { id: "m", role: "assistant", text: "pineapple", timestamp: 77, model: "gpt-x" },
        ],
      });

      expect(index.passages(plan("pineapple"), "a")[0]).toMatchObject({
        messageId: "m",
        role: "assistant",
        timestamp: 77,
        model: "gpt-x",
      });
    });

    it("are none for a chat the index does not hold", async () => {
      await openWith(chat("a", ["pineapple"]));

      expect(index.passages(plan("pineapple"), "ghost")).toEqual([]);
    });
  });

  describe("writing", () => {
    it("takes a chat out for real, with no rebuild", async () => {
      await openWith(chat("keep", ["pineapple"]), chat("gone", ["pineapple"]));

      index.remove("gone");

      expect(ids("pineapple")).toEqual(["keep"]);
      expect(index.passages(plan("pineapple"), "gone")).toEqual([]);
      expect(index.chats()).toBe(1);
    });

    it("replaces the text of a chat that is put again", async () => {
      await openWith(chat("a", ["pineapple"]));

      index.put(chat("a", ["mango"]));

      expect(ids("pineapple")).toEqual([]);
      expect(ids("mango")).toEqual(["a"]);
      expect(index.chats()).toBe(1);
    });

    it("undoes a transaction that throws", async () => {
      await openWith(chat("a", ["pineapple"]));

      expect(() =>
        index.transaction(() => {
          index.put(chat("b", ["pineapple"]));
          throw new Error("no");
        }),
      ).toThrow("no");

      expect(ids("pineapple")).toEqual(["a"]);
    });

    it("keeps the rows of one chat out of another's, however many messages it has", async () => {
      await openWith(
        chat(
          "long",
          Array.from({ length: 300 }, (_, i) => `pineapple ${i}`),
        ),
        chat("next", ["mango"]),
      );

      expect(index.passages(plan("pineapple"), "long")).toHaveLength(300);
      expect(index.passages(plan("pineapple"), "next")).toEqual([]);
      expect(ids("mango")).toEqual(["next"]);
    });
  });

  describe("files and rebuilds", () => {
    it("has no index to read when there is none, and says so", async () => {
      index = kit.create();

      expect(await index.open()).toBe(false);
      expect(index.search(plan("pineapple"))).toEqual([]);
      expect(index.chats()).toBe(0);
    });

    it("finds what a finished rebuild wrote when it is opened again", async () => {
      await openWith(chat("a", ["pineapple"]));
      index.close();

      index = kit.create();
      expect(await index.open()).toBe(true);

      expect(ids("pineapple")).toEqual(["a"]);
    });

    it("keeps answering from the old index while a rebuild writes the new one", async () => {
      await openWith(chat("old", ["pineapple"]));

      const build = index.beginRebuild();
      build.put(chat("new", ["pineapple"]));

      expect(ids("pineapple")).toEqual(["old"]);
      expect(build.chats()).toBe(1);

      build.commit();

      expect(ids("pineapple")).toEqual(["new"]);
    });

    it("is not read when a rebuild never finished, and the old one is", async () => {
      await openWith(chat("old", ["pineapple"]));
      const build = index.beginRebuild();
      build.put(chat("half", ["pineapple"]));
      index.close(); // the worker died here

      index = kit.create();
      expect(await index.open()).toBe(true);

      expect(ids("pineapple")).toEqual(["old"]);
    });

    it("leaves the old index alone when a rebuild is thrown away", async () => {
      await openWith(chat("old", ["pineapple"]));

      const build = index.beginRebuild();
      build.put(chat("new", ["pineapple"]));
      build.discard();

      expect(ids("pineapple")).toEqual(["old"]);
      expect(index.chats()).toBe(1);
      // and the next rebuild starts clean
      const again = index.beginRebuild();
      expect(again.chats()).toBe(0);
      again.discard();
    });

    it("writes one rebuild at a time", async () => {
      await openWith(chat("a", ["pineapple"]));

      const build = index.beginRebuild();

      expect(() => index.beginRebuild()).toThrow();
      build.discard();
    });

    it("does not read an index of another format, newer or older", async () => {
      for (const format of [2, INDEX_FORMAT_VERSION + 1]) {
        kit.reset();
        await kit.seedFormat(format);
        index = kit.create();

        expect(await index.open()).toBe(false);

        index.close();
      }
    });

    it("reads an index of the current format", async () => {
      await kit.seedFormat(INDEX_FORMAT_VERSION);
      // The Map fixture holds a real (empty) index for this; SQLite's seeded file has the format
      // record only, which is all `open` reads.
      index = kit.create();

      expect(await index.open()).toBe(true);
    });
  });
});

describe("the SQLite index's own ranking (HVN-87)", () => {
  let index: SearchIndex;

  beforeEach(async () => {
    sqliteKit.reset();
    index = sqliteKit.create();
    await index.open();
  });

  afterEach(() => {
    index.close();
  });

  function write(...chats: IndexedChat[]): void {
    const build = index.beginRebuild();
    for (const c of chats) build.put(c);
    build.commit();
  }

  const rank = (query: string) => index.search(plan(query)).map((r) => r.chatId);
  const aside = "lorem ipsum dolor sit amet ".repeat(60);

  it("puts the chat about the word before the chat that mentions it once", () => {
    write(
      chat("aside", [`${aside} wombat ${aside}`]),
      chat("about", ["wombat wombat wombat", "more about the wombat"]),
    );

    expect(rank("wombat")).toEqual(["about", "aside"]);
  });

  it("lets the rare word decide, on one scale for every chat", () => {
    write(
      ...Array.from({ length: 20 }, (_, i) => chat(`common${i}`, ["the common word"])),
      chat("rare", ["a common word and a quokkafish"]),
    );

    expect(rank("common quokkafish")).toEqual(["rare"]);
    expect(rank("common")).toHaveLength(21);
  });

  it("counts a word in the title for more than the same word in the body", () => {
    write(
      chat("body", ["wombat"], { title: "something else" }),
      chat("title", ["something else"], { title: "wombat" }),
    );

    expect(rank("wombat")).toEqual(["title", "body"]);
  });
});

describe("the near spellings of a word are looked up once for a query (HVN-87)", () => {
  let index: SearchIndex;
  let scans = 0;

  /** Count the scans of the vocabulary, which is what finding a near spelling costs. */
  async function countVocabScans(): Promise<void> {
    // The memory host hands out the same database for the same name: wrap the two slots.
    const host = await openSqliteHost();
    for (const name of ["/haevn-search-a.db", "/haevn-search-b.db"]) {
      const db = host.open(name);
      const exec = db.exec.bind(db);
      db.exec = ((arg: unknown) => {
        if (typeof arg === "object" && arg !== null && "sql" in arg) {
          if (String((arg as { sql: string }).sql).includes("FROM vocab")) scans++;
        }
        return exec(arg as never);
      }) as typeof db.exec;
    }
  }

  beforeEach(async () => {
    sqliteKit.reset();
    index = sqliteKit.create();
    await index.open();
    const build = index.beginRebuild();
    for (let i = 0; i < 12; i++) build.put(chat(`c${i}`, ["a note about kubernetes", "and more"]));
    build.commit();
    scans = 0;
    await countVocabScans();
  });

  afterEach(() => {
    index.close();
  });

  it("scans the vocabulary once for the search and the passages of its chats", () => {
    const query = plan("kubernetez~1");
    const ranked = index.search(query).map((r) => r.chatId);
    expect(scans).toBe(1);

    index.passagesFor(query, ranked, 4); // twelve chats: one pass
    index.passages(query, ranked[0], 4);
    index.passages(query, ranked[1], 4);

    expect(ranked).toHaveLength(12);
    expect(scans).toBe(1);
  });

  it("scans again after a write, which can add a word", () => {
    const query = plan("kubernetez~1");
    index.search(query);

    index.put(chat("new", ["kubernetes again"]));

    expect(index.search(query).map((r) => r.chatId)).toContain("new");
    expect(scans).toBe(2);
  });
});

describe("which file of the SQLite index is read, and which is wiped (HVN-87)", () => {
  let index: SearchIndex;

  beforeEach(async () => {
    sqliteKit.reset();
    index = sqliteKit.create();
    await index.open();
  });

  afterEach(() => {
    index.close();
  });

  function write(target: SearchIndex, ...chats: IndexedChat[]): void {
    const build = target.beginRebuild();
    for (const c of chats) build.put(c);
    build.commit();
  }

  const names = ["/haevn-search-a.db", "/haevn-search-b.db"];
  const ids = (query: string) => index.search(plan(query)).map((r) => r.chatId);

  /** The memory host hands out the same database for the same name, so a test can reach it. */
  async function databases() {
    const host = await openSqliteHost();
    return names.map((name) => host.open(name));
  }

  /** Make the read of the file's tables fail the way SQLite reports `code`, while `armed.on`. */
  async function failReads(code: number, message: string): Promise<{ on: boolean }> {
    const armed = { on: true };
    for (const db of await databases()) {
      const selectValue = db.selectValue.bind(db);
      db.selectValue = ((...args: Parameters<typeof db.selectValue>) => {
        if (armed.on) throw Object.assign(new Error(message), { resultCode: code });
        return selectValue(...args);
      }) as typeof db.selectValue;
    }
    return armed;
  }

  it("does not wipe a good index when reading it fails for a reason that may pass", async () => {
    write(index, chat("kept", ["pineapple"]));
    index.close();
    const armed = await failReads(5, "database is locked"); // SQLITE_BUSY

    index = sqliteKit.create();
    await expect(index.open()).rejects.toThrow(/locked/);
    armed.on = false;
    index.close();

    index = sqliteKit.create();
    expect(await index.open()).toBe(true);
    expect(ids("pineapple")).toEqual(["kept"]);
  });

  it.each([
    [26, "file is not a database"],
    [11, "database disk image is malformed"],
    [1, "no such column: value"],
  ])("wipes a file that SQLite says is not an index (%s)", async (code, message) => {
    write(index, chat("lost", ["pineapple"]));
    index.close();
    const armed = await failReads(code, message);

    index = sqliteKit.create();
    expect(await index.open()).toBe(false);
    armed.on = false;
    index.close();

    index = sqliteKit.create();
    expect(await index.open()).toBe(false);
    expect(ids("pineapple")).toEqual([]);
  });

  it("reads the newer of two finished files, as a crash between the swap and the wipe leaves them", async () => {
    write(index, chat("older", ["pineapple"]));
    // The swap happens, and the process dies before the old file is wiped.
    const host = (index as unknown as { host: { unlink: (name: string) => void } }).host;
    host.unlink = () => {};
    write(index, chat("newer", ["pineapple"]));
    index.close();

    index = sqliteKit.create();
    expect(await index.open()).toBe(true);

    expect(ids("pineapple")).toEqual(["newer"]);
  });
});

describe.each(kits)("models and tags in the index, on $name (HVN-164)", (kit: IndexKit) => {
  let index: SearchIndex;

  async function openWith(...chats: IndexedChat[]): Promise<void> {
    index = kit.create();
    await index.open();
    const build = index.beginRebuild();
    build.transaction(() => {
      for (const c of chats) build.put(c);
    });
    build.commit();
  }

  const ids = (query: string) =>
    index
      .search(plan(query))
      .map((r) => r.chatId)
      .sort();

  /** The chats of the tests below: `a` and `b` carry labels, `c` carries none. */
  const a = chat("a", ["tell me about cats"], {
    models: ["gpt-4o"],
    tags: ["poetry", "creative writing"],
  });
  const b = chat("b", ["poetry is only mentioned in the text"], {
    models: ["claude-3-5-sonnet", "gpt-4"],
    tags: ["code"],
  });
  const c = chat("c", ["nothing to see"]);

  beforeEach(() => {
    kit.reset();
  });

  afterEach(() => {
    index?.close();
  });

  it("does not find a chat by its model or its tag typed as a plain word: that is about the text", async () => {
    await openWith(a, b, c);

    expect(ids("poetry")).toEqual(["b"]); // b's message, not a's tag
    expect(ids("sonnet")).toEqual([]);
    expect(ids("4o")).toEqual([]);
    expect(ids("creative writing")).toEqual([]);
    expect(ids("poet*")).toEqual(["b"]);
  });

  it("does not let a plain word be relaxed onto a label either", async () => {
    await openWith(a, b, c);

    const relaxed = buildRelaxedPlan(parseSearchQuery("sonnet gpt"));

    expect(relaxed && index.search(relaxed).map((r) => r.chatId)).toEqual([]);
  });

  it("finds a chat by its label only, with model: and tag:", async () => {
    await openWith(a, b, c);

    expect(ids("tag:poetry")).toEqual(["a"]); // not b, which has the word in its text
    expect(ids("tag:code")).toEqual(["b"]);
    expect(ids("model:sonnet")).toEqual(["b"]);
    expect(ids("tag:cats")).toEqual([]); // a word of a's text, not a tag
  });

  it("keeps the two kinds apart", async () => {
    await openWith(a, b, c);

    expect(ids("model:poetry")).toEqual([]);
    expect(ids("tag:gpt")).toEqual([]);
    expect(ids("model:code")).toEqual([]);
  });

  it("takes a hyphenated label as the label it is, not as its parts", async () => {
    await openWith(a, b, c);

    expect(ids("model:gpt")).toEqual(["a", "b"]); // a word of either
    expect(ids("model:gpt-4o")).toEqual(["a"]);
    expect(ids("model:gpt-4")).toEqual(["b"]); // `4` next to `gpt`; a's is `4o`
    expect(ids("model:claude-3-5-sonnet")).toEqual(["b"]);
    expect(ids("model:sonnet-3")).toEqual([]); // the words of a label in another order
    expect(ids("model:4o-gpt")).toEqual([]);
  });

  it("does not find a label by words that are in two different labels", async () => {
    await openWith(a, b, c);

    // `gpt-4o`'s `gpt` and `claude-3-5-sonnet`'s `sonnet` are both b's models, but one label has
    // only one of them.
    expect(ids("model:gpt-sonnet")).toEqual([]);
    expect(ids('tag:"poetry creative"')).toEqual([]); // two tags of a, side by side in no label
    expect(ids('tag:"creative writing"')).toEqual(["a"]);
  });

  it("goes on after the last word of a label typed with a star", async () => {
    await openWith(a, b, c);

    expect(ids("model:gpt*")).toEqual(["a", "b"]);
    expect(ids("model:gpt-4*")).toEqual(["a", "b"]); // `4o` and `4`
    expect(ids("model:claude-3*")).toEqual(["b"]);
    expect(ids("tag:poet*")).toEqual(["a"]);
  });

  it("combines labels with each other and with the text, every part required", async () => {
    await openWith(a, b, c);

    expect(ids("tag:poetry model:gpt-4o")).toEqual(["a"]);
    expect(ids("tag:poetry model:gpt-4")).toEqual([]);
    expect(ids("tag:poetry cats")).toEqual(["a"]);
    expect(ids("tag:poetry mentioned")).toEqual([]);
    expect(ids("tag:code mentioned")).toEqual(["b"]);
  });

  it("leaves out a chat that has the label with -tag: and -model:, and never with a plain -word", async () => {
    // Synced chats carry the provider's own name as their model, so `-claude` must not drop them.
    await openWith(
      chat("synced", ["a python question"], { models: ["Claude"], tags: ["chatgpt"] }),
      chat("typed", ["a python question about claude"], { models: ["gpt-4o"] }),
    );

    expect(ids("python -claude")).toEqual(["synced"]); // only the chat that says claude is left out
    expect(ids("python -chatgpt")).toEqual(["synced", "typed"]);
    expect(ids("python -model:claude")).toEqual(["typed"]);
    expect(ids("python -tag:chatgpt")).toEqual(["typed"]);

    index.close();
    kit.reset();
    await openWith(a, b, c);

    expect(ids("tag:poetry -tag:code")).toEqual(["a"]);
    expect(ids("poetry -tag:code")).toEqual([]); // b is the only chat that says poetry, and has the tag
    expect(ids("poetry -code")).toEqual(["b"]); // b's tag is not a word it said; a has no poetry text
    expect(ids("tag:poetry -model:gpt-4o")).toEqual([]);
    expect(ids("poetry -model:gpt-4")).toEqual([]); // b says poetry, and has the model gpt-4
    expect(ids("poetry -tag:cats")).toEqual(["b"]); // cats is not a tag
  });

  it("folds case and accents in a label, as it does in text", async () => {
    await openWith(chat("x", ["hello"], { models: ["Café-Model"], tags: ["Déjà Vu"] }));

    expect(ids("model:CAFE-model")).toEqual(["x"]);
    expect(ids('tag:"deja vu"')).toEqual(["x"]);
  });

  it("indexes a label again when the chat is written again", async () => {
    await openWith(a, b, c);

    index.put({ ...a, tags: ["essays"], models: [] });

    expect(ids("tag:poetry")).toEqual([]);
    expect(ids("model:gpt-4o")).toEqual([]);
    expect(ids("tag:essays")).toEqual(["a"]);
    expect(ids("cats")).toEqual(["a"]); // its text is still there
  });

  it("forgets a label when the chat is removed", async () => {
    await openWith(a, b, c);

    index.remove("a");

    expect(ids("tag:poetry")).toEqual([]);
    expect(ids("model:gpt")).toEqual(["b"]);
  });

  it("gives a chat the rows of fifty labels of a kind and no more, and never one of the next chat", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `label${i}`);
    await openWith(
      chat("many", ["text"], { tags: many }),
      chat("next", ["text"], { tags: ["onlyhere"] }),
    );

    expect(ids("tag:label0")).toEqual(["many"]);
    expect(ids("tag:label49")).toEqual(["many"]);
    expect(ids("tag:label50")).toEqual([]);
    expect(ids("tag:onlyhere")).toEqual(["next"]);
    expect(ids("tag:label59")).toEqual([]);
  });

  describe("passages", () => {
    const passagesOf = (query: string, chatId: string, limit?: number) =>
      index.passages(plan(query), chatId, limit);

    it("shows the label that matched, as a passage that names no message", async () => {
      await openWith(a, b, c);

      const [tag, ...rest] = passagesOf("tag:poetry", "a");

      expect(rest).toEqual([]);
      expect(tag).toMatchObject({ messageId: LABEL_IDS.tag, text: "poetry" });
      expect(marked(tag)).toEqual(["poetry"]);
    });

    it("shows the model of a model: search, and marks only what the label has", async () => {
      await openWith(a, b, c);

      const [model] = passagesOf("model:claude-3*", "b");

      expect(model).toMatchObject({ messageId: LABEL_IDS.model, text: "claude-3-5-sonnet" });
      expect(marked(model)).toEqual(["claude-3"]); // the phrase, as one mark
    });

    it("shows no label for a plain word, even when the chat has the word as a tag", async () => {
      await openWith(a, b, c);

      expect(passagesOf("poetry", "a")).toEqual([]);
      expect(passagesOf("poetry", "b").map((p) => p.messageId)).toEqual(["b-m1"]);
      // Said in a message and held as a tag: the message is the passage.
      index.put(chat("e", ["poetry again"], { tags: ["poetry"] }));
      expect(passagesOf("poetry", "e").map((p) => p.messageId)).toEqual(["e-m1"]);
    });

    it("shows the messages first and the labels last, and a label of each kind once", async () => {
      await openWith(
        chat("d", ["gpt is a word", "and so is code"], {
          models: ["gpt-4", "gpt-4o"],
          tags: ["code"],
        }),
      );

      const query = "gpt code model:gpt tag:code";
      const found = passagesOf(query, "d");

      expect(found.map((p) => p.messageId)).toEqual([
        "d-m1",
        "d-m2",
        LABEL_IDS.model,
        LABEL_IDS.tag,
      ]);
      expect(passagesOf(query, "d", 3).map((p) => p.messageId)).toEqual([
        "d-m1",
        "d-m2",
        LABEL_IDS.model,
      ]);
    });

    it("shows both the text and the label of a query that has both", async () => {
      await openWith(a, b, c);

      const found = passagesOf("tag:poetry cats", "a");

      expect(found.map((p) => p.messageId)).toEqual(["a-m1", LABEL_IDS.tag]);
      expect(marked(found[0])).toEqual(["cats"]);
      expect(marked(found[1])).toEqual(["poetry"]);
    });

    it("shows no passage of a text that has the word of a tag: it is not a hit", async () => {
      await openWith(a, b, c);

      expect(passagesOf("tag:poetry", "b")).toEqual([]);
    });

    it("gives the same passages for many chats at once as for each alone", async () => {
      // More chats than the index seeks one by one, so that the pass over the rows is the one run.
      const chats = Array.from({ length: 12 }, (_, i) =>
        chat(`m${i}`, [`text of ${i} with cats`], {
          models: i % 2 === 0 ? ["gpt-4o"] : ["claude"],
          tags: ["shared"],
        }),
      );
      await openWith(...chats);
      const everyId = chats.map((x) => x.id);

      for (const query of ["tag:shared", "model:gpt-4o cats", "cats", "tag:shared model:claude"]) {
        const together = index.passagesFor(plan(query), everyId);
        for (const id of everyId) {
          expect(together.get(id) ?? [], `${query} in ${id}`).toEqual(passagesOf(query, id));
        }
      }
      expect(index.passagesFor(plan("tag:shared"), everyId).size).toBe(12);
      expect(index.passagesFor(plan("model:gpt-4o"), everyId).size).toBe(6);
    });
  });

  describe("ranking and filters", () => {
    it("keeps the filters: a labelled search is cut by provider and date as any other", async () => {
      await openWith(
        chat("old", ["x"], { tags: ["shared"], source: "claude", timestamp: 100 }),
        chat("new", ["x"], { tags: ["shared"], source: "chatgpt", timestamp: 900 }),
      );

      expect(
        index.search(plan("tag:shared"), { provider: "chatgpt" }).map((r) => r.chatId),
      ).toEqual(["new"]);
      expect(index.search(plan("tag:shared"), { before: 500 }).map((r) => r.chatId)).toEqual([
        "old",
      ]);
    });

    it("scores a labelled search, so that the chats come back in a stable order", async () => {
      await openWith(
        chat("p", ["x"], { tags: ["shared"] }),
        chat("q", ["x"], { tags: ["shared"] }),
      );

      const ranked = index.search(plan("tag:shared"));

      expect(ranked.map((r) => r.chatId)).toEqual(["p", "q"]);
      expect(ranked.every((r) => Number.isFinite(r.score) && r.score > 0)).toBe(true);
    });
  });
});

describe("a chat that runs out of rowids keeps its labels in its own range (HVN-164)", () => {
  it("stops the messages early enough for the labels, so none lands in the next chat", async () => {
    sqliteKit.reset();
    // Eight bits are 256 rows to a chat, so a chat can run out of them with a few hundred
    // messages instead of a million; the room kept for the labels is 100 of those rows.
    const index = new SqliteSearchIndex(8);
    await index.open();
    const build = index.beginRebuild();
    const said = (id: string, text: string): IndexedMessage => ({ id, role: "user", text });
    build.transaction(() => {
      build.put({
        id: "big",
        title: "",
        source: "test",
        timestamp: 1,
        models: ["bigmodel"],
        tags: ["bigtag"],
        messages: Array.from({ length: 300 }, (_, i) => said(`m${i}`, `word${i}`)),
      });
      build.put({
        id: "next",
        title: "",
        source: "test",
        timestamp: 1,
        models: [],
        tags: ["nexttag"],
        messages: [said("n1", "nexttext")],
      });
    });
    build.commit();
    const ids = (query: string) =>
      index
        .search(plan(query))
        .map((r) => r.chatId)
        .sort();

    // The big chat's own labels are its own; the next chat has only its own.
    expect(ids("tag:bigtag")).toEqual(["big"]);
    expect(ids("model:bigmodel")).toEqual(["big"]);
    expect(ids("tag:nexttag")).toEqual(["next"]);
    expect(ids("nexttext")).toEqual(["next"]);
    // The messages that fit (256 less the 100 kept) are searchable, and the rest are not.
    expect(ids("word155")).toEqual(["big"]);
    expect(ids("word156")).toEqual([]);
    index.close();
  });
});
