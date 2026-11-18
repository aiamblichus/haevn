import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexedChat, IndexedMessage } from "../src/services/searchDocument";
import {
  INDEX_FORMAT_VERSION,
  type IndexFilters,
  type MarkedPassage,
  openSqliteHost,
  type SearchIndex,
} from "../src/services/searchIndex";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildQueryPlan, buildRelaxedPlan } from "../src/services/searchWorkerQuery";
import { type IndexKit, kits, sqliteKit } from "./helpers/indexKit";

function chat(
  id: string,
  texts: string[],
  extra: Partial<Pick<IndexedChat, "title" | "source" | "timestamp">> = {},
): IndexedChat {
  const messages: IndexedMessage[] = texts.map((text, i) => ({
    id: `${id}-m${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text,
  }));
  return { id, title: "", source: "test", timestamp: 1_000, messages, ...extra };
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
