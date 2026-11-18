// The search index's one door to SQLite: the only module that imports `@sqlite.org/sqlite-wasm`
// (a lint rule says so). It hides the engine, the files and the query language from the search
// worker, which sees the `SearchIndex` below and nothing of how it is kept.
//
// Shape of the data. One FTS5 table, `msgs`, with a row for each thing a chat said: its title, its
// system prompt, and what the user and what the assistant said in each message. A row's rowid is
// `chat * 2^20 + position`, so the chat of a hit is `rowid >> 20` and a chat's rows are one range,
// both without reading the row. The text is stored in the table: FTS5's `highlight()` marks
// exactly the words its tokenizer matched, so a mark never disagrees with the index about what a
// word is. A chat is a result when every word of the query is somewhere in it, in any of its rows
// (an INTERSECT of the chats each word is in), and a passage is a row that has any of the words.
// `docs` has one row for each chat, with what the filters read.
//
// Two files, a slot each. A rebuild writes the slot that is not live and then makes it live in one
// transaction, so search keeps answering from the old file until the new one is whole, and a
// worker that dies mid-rebuild leaves a slot that is never read.

import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { IndexedChat } from "./searchDocument";
import { foldText } from "./searchFold";
import { anyOf, buildMatches, editDistanceWithin } from "./searchMatch";
import type { TextRange } from "./searchSnippet";
import type { QueryPlan } from "./searchWorkerQuery";

// --- The host: where the database files live ---

/**
 * Where SQLite keeps its files. In the search worker it is the origin's private file system (the
 * `opfs-sahpool` VFS: synchronous access handles, no `SharedArrayBuffer`, and so no cross-origin
 * isolation headers); in Node, where the tests run, it is memory that outlives a module reset the
 * way a file outlives a worker.
 */
export interface SqliteHost {
  readonly kind: "opfs" | "memory";
  /** SQLite's own version, e.g. "3.54.1". */
  readonly version: string;
  /** Open a file, created when it is not there. */
  open(name: string): Database;
  /** Close a database that `open` returned. */
  close(db: Database): void;
  /** Delete a file whose database is closed, and its journal. */
  unlink(name: string): void;
}

/**
 * Files in the OPFS pool: two index slots (see `SqliteSearchIndex`), and each open file needs one
 * handle more for its journal. Twelve leaves room for a temporary file or two.
 */
const POOL_CAPACITY = 12;
const POOL_NAME = "haevn-search";

/** How long to wait before the second try at opening the pool (see `openSqliteHost`). */
const OPEN_RETRY_MS = 1500;

type WasmInit = (options?: { locateFile?: (file: string) => string }) => Promise<Sqlite3Static>;

function inOpfsWorker(): boolean {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  return typeof storage?.getDirectory === "function";
}

/** What the memory host keeps on `globalThis`, so that a reloaded module finds it again. */
interface MemoryState {
  sqlite3?: Sqlite3Static;
  files: Map<string, Database>;
}
const MEMORY_STATE = Symbol.for("haevn.search.memoryHost");

function memoryState(): MemoryState {
  const holder = globalThis as unknown as Record<symbol, MemoryState | undefined>;
  const state = holder[MEMORY_STATE] ?? { files: new Map() };
  holder[MEMORY_STATE] = state;
  return state;
}

/**
 * Forget every file of the memory host (a test's clean slate). The next `openSqliteHost` starts
 * with nothing stored, as a first run does.
 */
export function resetMemorySqliteHost(): void {
  const state = memoryState();
  for (const db of state.files.values()) db.close();
  state.files.clear();
}

async function openMemoryHost(): Promise<SqliteHost> {
  const state = memoryState();
  const sqlite3 = state.sqlite3 ?? (await (sqlite3InitModule as unknown as WasmInit)());
  state.sqlite3 = sqlite3;
  const { files } = state;
  return {
    kind: "memory",
    version: sqlite3.version.libVersion,
    open(name) {
      let db = files.get(name);
      if (!db) {
        db = new sqlite3.oo1.DB(":memory:");
        files.set(name, db);
      }
      return db;
    },
    // A memory file is its connection: closing it would delete it.
    close() {},
    unlink(name) {
      files.get(name)?.close();
      files.delete(name);
    },
  };
}

async function openOpfsHost(): Promise<SqliteHost> {
  const sqlite3 = await (sqlite3InitModule as unknown as WasmInit)({
    // An IIFE bundle has no `import.meta.url` to find the module beside; it sits next to the
    // worker script, which is at the extension's root.
    locateFile: (file) => new URL(file, globalThis.location.href).href,
  });
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: POOL_NAME,
    initialCapacity: POOL_CAPACITY,
    // A failed install must not delete the pool (the default): the index in it is worth keeping
    // when the failure is only a handle that another context still holds.
    preserveOnInitFailure: true,
  });
  return {
    kind: "opfs",
    version: sqlite3.version.libVersion,
    open: (name) => new pool.OpfsSAHPoolDb(name),
    close: (db) => db.close(),
    unlink(name) {
      pool.unlink(name);
      pool.unlink(`${name}-journal`);
    },
  };
}

/**
 * Open SQLite where this context keeps files. The pool's handles are exclusive, so an open fails
 * while another context (a worker that did not die before an extension reload) still holds them;
 * the open is tried once more after a pause, with a fresh module, because the module remembers a
 * failed install.
 */
export async function openSqliteHost(): Promise<SqliteHost> {
  if (!inOpfsWorker()) return openMemoryHost();
  try {
    return await openOpfsHost();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    return openOpfsHost();
  }
}

// --- The contract ---

/**
 * What the index holds: bump it when the schema or the tokenizer changes what a stored index
 * means. An index of another format is not read, and the next start rebuilds it.
 *   1, 2: Lunr segments in the `lunrIndex` table (before SQLite).
 *   3: SQLite FTS5, one row for each message, text stored, accents folded.
 */
export const INDEX_FORMAT_VERSION = 3;

/** What a search may be narrowed to, before the cut. */
export interface IndexFilters {
  /** The chat's timestamp is at or after this. */
  after?: number;
  /** ... and at or before this. */
  before?: number;
  /** Only chats of this source. */
  provider?: string;
  /** Only this chat. */
  chatId?: string;
}

export interface RankedChat {
  chatId: string;
  /** Higher is better; comparable inside one answer only. */
  score: number;
}

/** A message that has a word of the query, with the spans of the text the query matched. */
export interface MarkedPassage {
  messageId: string;
  role: "user" | "assistant";
  /** The whole text of the message. */
  text: string;
  /** Where the query matched in `text`: whole words as the index cut them. */
  marks: TextRange[];
  timestamp?: number;
  model?: string;
}

/** Writing: what a rebuild's new file and the live one have in common. */
export interface IndexWriter {
  /** Index a chat, or index it again: what was there is replaced. */
  put(chat: IndexedChat): void;
  /** Take a chat out; nothing of it is searched afterwards. */
  remove(chatId: string): void;
  /** Group writes into one commit; a throw undoes them all. */
  transaction<T>(fn: () => T): T;
  /** Chats held. */
  chats(): number;
}

/** A rebuild in progress, writing a file that nothing searches until `commit`. */
export interface IndexBuild extends IndexWriter {
  /** Make this file the one that is searched, and drop the one it replaces. */
  commit(): void;
  /** Throw this file away. */
  discard(): void;
}

export interface SearchIndex extends IndexWriter {
  /** Where the index is kept, and what it is: for the log line. */
  describe(): string;
  /**
   * Open the files and find the index to read. True when there is one in the current format;
   * false for none (a first run, an older format, a rebuild that did not finish). Throws, with the
   * reason, when the files cannot be opened.
   */
  open(): Promise<boolean>;
  /** Every chat that matches the plan inside the filters, best first. */
  search(plan: QueryPlan, filters?: IndexFilters): RankedChat[];
  /** The messages of one chat that have a word of the plan, in order, with their marks. */
  passages(plan: QueryPlan, chatId: string, limit?: number): MarkedPassage[];
  /**
   * `passages` for many chats at once, keyed by chat id (a chat with none is not in the map). A
   * prefix of one letter has tens of thousands of rows to merge, and asking for each chat's
   * passages alone costs that merge each time; this reads the rows of the plan once.
   */
  passagesFor(plan: QueryPlan, chatIds: string[], limit?: number): Map<string, MarkedPassage[]>;
  /** Start a rebuild into the file that is not the live one. */
  beginRebuild(): IndexBuild;
  close(): void;
}

/** The index as this context keeps it: OPFS in the search worker, memory in Node. */
export function createSearchIndex(): SearchIndex {
  return new SqliteSearchIndex();
}

// --- SQLite ---

const SLOT_FILES = ["/haevn-search-a.db", "/haevn-search-b.db"] as const;
export const TOKENIZER = "unicode61 remove_diacritics 2 categories 'L* N* Co So M*' tokenchars '_'";
/** A chat's rows are the rowids from `chat << ORDINAL_BITS` up. */
const ORDINAL_BITS = 20;
const ORDINAL_SPAN = 2 ** ORDINAL_BITS;
/** The title counts ten times what the body does, as it did in the Lunr index. */
const TITLE_WEIGHT = 10;
const VARIANTS_LIMIT = 64;
/** Up to this many chats, `passagesFor` asks for each chat alone. */
const SEEK_MAX_CHATS = 8;
/** Rows marked in one query of `passagesFor`. */
const SHOWN_PER_QUERY = 2000;
/** Around a hit, in `highlight()`: not in any text (the extraction takes them out). */
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

type Binding = (string | number | null)[];

function firstRowid(chat: number): number {
  return chat * ORDINAL_SPAN;
}

/** A marked text as its plain text and the spans that were marked. */
function readMarks(marked: string): { text: string; marks: TextRange[] } {
  const pieces: string[] = [];
  const marks: TextRange[] = [];
  let length = 0;
  let open = -1;
  let at = 0;
  while (at < marked.length) {
    let next = at;
    while (next < marked.length && marked[next] !== MARK_OPEN && marked[next] !== MARK_CLOSE) {
      next++;
    }
    if (next > at) {
      pieces.push(marked.slice(at, next));
      length += next - at;
    }
    if (next < marked.length) {
      if (marked[next] === MARK_OPEN) open = length;
      else if (open >= 0) {
        marks.push({ start: open, length: length - open });
        open = -1;
      }
    }
    at = next + 1;
  }
  return { text: pieces.join(""), marks };
}

/** One index file. */
class Slot implements IndexWriter {
  private inTransaction = false;

  constructor(
    readonly name: string,
    readonly db: Database,
  ) {}

  /** Whether the file already has this index's tables (a file just made does not). */
  hasSchema(): boolean {
    return (
      this.db.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'") ===
      1
    );
  }

  createSchema(): void {
    this.db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE docs(
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        ts REAL NOT NULL
      );
      CREATE VIRTUAL TABLE msgs USING fts5(
        title, body, mid UNINDEXED, role UNINDEXED, ts UNINDEXED, model UNINDEXED,
        tokenize = "${TOKENIZER}"
      );
      CREATE VIRTUAL TABLE vocab USING fts5vocab(msgs, row);
    `);
  }

  tune(building: boolean): void {
    this.db.exec(`
      PRAGMA cache_size = -16384;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_mode = ${building ? "MEMORY" : "DELETE"};
      PRAGMA synchronous = ${building ? "OFF" : "FULL"};
    `);
  }

  getMeta(key: string): string | undefined {
    const value = this.db.selectValue("SELECT value FROM meta WHERE key = ?", [key]);
    return value === undefined || value === null ? undefined : String(value);
  }

  setMeta(key: string, value: string | number): void {
    this.db.exec({
      sql: "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      bind: [key, String(value)],
    });
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  chats(): number {
    return Number(this.db.selectValue("SELECT count(*) FROM docs"));
  }

  private chatKey(chatId: string): number | undefined {
    const key = this.db.selectValue("SELECT id FROM docs WHERE chat_id = ?", [chatId]);
    return key === undefined || key === null ? undefined : Number(key);
  }

  private clearRows(key: number): void {
    this.db.exec({
      sql: "DELETE FROM msgs WHERE rowid BETWEEN ? AND ?",
      bind: [firstRowid(key), firstRowid(key + 1) - 1],
    });
  }

  put(chat: IndexedChat): void {
    this.transaction(() => {
      const known = this.chatKey(chat.id);
      let key: number;
      if (known === undefined) {
        this.db.exec({
          sql: "INSERT INTO docs(chat_id, provider, ts) VALUES (?, ?, ?)",
          bind: [chat.id, chat.source, chat.timestamp],
        });
        key = Number(this.db.selectValue("SELECT last_insert_rowid()"));
      } else {
        key = known;
        this.clearRows(key);
        this.db.exec({
          sql: "UPDATE docs SET provider = ?, ts = ? WHERE id = ?",
          bind: [chat.source, chat.timestamp, key],
        });
      }

      const insert = this.db.prepare(
        "INSERT INTO msgs(rowid, title, body, mid, role, ts, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      try {
        let ordinal = 0;
        const add = (...values: Binding) => {
          insert.bind([firstRowid(key) + ordinal++, ...values]).stepReset();
        };
        if (chat.title) add(chat.title, "", "title", "user", null, null);
        for (const message of chat.messages) {
          if (ordinal >= ORDINAL_SPAN) break;
          add(
            "",
            message.text,
            message.id,
            message.role,
            message.timestamp ?? null,
            message.model ?? null,
          );
        }
      } finally {
        insert.finalize();
      }
    });
  }

  remove(chatId: string): void {
    this.transaction(() => {
      const key = this.chatKey(chatId);
      if (key === undefined) return;
      this.clearRows(key);
      this.db.exec({ sql: "DELETE FROM docs WHERE id = ?", bind: [key] });
    });
  }

  /** The words of the index within `maxEdits` of `term`, the most common first. */
  variants(term: string, maxEdits: number): string[] {
    const folded = foldText(term);
    const length = Array.from(folded).length;
    const found: [string, number][] = [];
    this.db.exec({
      sql: "SELECT term, doc FROM vocab WHERE length(term) BETWEEN ? AND ?",
      bind: [length - maxEdits, length + maxEdits],
      rowMode: "array",
      callback: (row: unknown[]) => {
        const word = String(row[0]);
        if (editDistanceWithin(folded, word, maxEdits) <= maxEdits) {
          found.push([word, Number(row[1])]);
        }
      },
    });
    return found
      .sort((a, b) => b[1] - a[1])
      .slice(0, VARIANTS_LIMIT)
      .map(([word]) => word);
  }

  search(plan: QueryPlan, filters: IndexFilters): RankedChat[] {
    const { required, optional, excluded } = buildMatches(plan, (term, max) =>
      this.variants(term, max),
    );
    const positive = anyOf([...required, ...optional]);
    if (!positive) return [];

    // The chats that satisfy every required clause (or any optional one), less the excluded ones.
    const chatsOf = "SELECT rowid >> 20 AS c FROM msgs WHERE msgs MATCH ?";
    const bind: Binding = [];
    let sets: string;
    if (required.length > 0) {
      sets = required.map(() => chatsOf).join(" INTERSECT ");
      bind.push(...required);
    } else {
      sets = chatsOf;
      bind.push(positive);
    }
    const out = anyOf(excluded);
    if (out) {
      sets += " EXCEPT SELECT rowid >> 20 FROM msgs WHERE msgs MATCH ?";
      bind.push(out);
    }

    const where: string[] = [];
    if (filters.after !== undefined) {
      where.push("d.ts >= ?");
      bind.push(filters.after);
    }
    if (filters.before !== undefined) {
      where.push("d.ts <= ?");
      bind.push(filters.before);
    }
    if (filters.provider !== undefined) {
      where.push("d.provider = ?");
      bind.push(filters.provider);
    }
    if (filters.chatId !== undefined) {
      where.push("d.chat_id = ?");
      bind.push(filters.chatId);
    }
    const hits = new Map<number, { chatId: string; score: number }>();
    this.db.exec({
      sql: `SELECT h.c, d.chat_id FROM (${sets}) h JOIN docs d ON d.id = h.c${
        where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
      }`,
      bind,
      rowMode: "array",
      callback: (row: unknown[]) => {
        hits.set(Number(row[0]), { chatId: String(row[1]), score: 0 });
      },
    });
    if (hits.size === 0) return [];

    // One scale for every chat: bm25 over the whole index, summed over a chat's rows.
    this.db.exec({
      sql: `SELECT rowid >> 20, bm25(msgs, ${TITLE_WEIGHT}.0, 1.0) FROM msgs WHERE msgs MATCH ?`,
      bind: [positive],
      rowMode: "array",
      callback: (row: unknown[]) => {
        const hit = hits.get(Number(row[0]));
        if (hit) hit.score -= Number(row[1]);
      },
    });

    return [...hits.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .map(([, hit]) => hit);
  }

  passages(plan: QueryPlan, chatId: string, limit: number): MarkedPassage[] {
    const key = this.chatKey(chatId);
    if (key === undefined) return [];
    const { required, optional } = buildMatches(plan, (term, max) => this.variants(term, max));
    const positive = anyOf([...required, ...optional]);
    if (!positive) return [];

    // A message is one passage, however many of its rows have a word: the row of the first hit,
    // the user's text before the assistant's. The rows are found first, and only the ones that
    // are shown are marked.
    const range = [firstRowid(key), firstRowid(key + 1) - 1];
    const shown: number[] = [];
    const seen = new Set<string>();
    this.db.exec({
      sql: "SELECT rowid, mid FROM msgs WHERE msgs MATCH ? AND rowid BETWEEN ? AND ? ORDER BY rowid",
      bind: [positive, ...range],
      rowMode: "array",
      callback: (row: unknown[]) => {
        const message = String(row[1]);
        if (seen.has(message) || (limit >= 0 && shown.length >= limit)) return;
        seen.add(message);
        shown.push(Number(row[0]));
      },
    });
    if (shown.length === 0) return [];

    const passages: MarkedPassage[] = [];
    this.db.exec({
      sql: `SELECT mid, role, ts, model,
              highlight(msgs, 0, ?, ?), highlight(msgs, 1, ?, ?)
            FROM msgs
            WHERE msgs MATCH ? AND rowid BETWEEN ? AND ? AND rowid IN (${shown.join(",")})
            ORDER BY rowid`,
      bind: [MARK_OPEN, MARK_CLOSE, MARK_OPEN, MARK_CLOSE, positive, ...range],
      rowMode: "array",
      callback: (row: unknown[]) => {
        const marked = String(row[4]) || String(row[5]);
        const { text, marks } = readMarks(marked);
        passages.push({
          messageId: String(row[0]),
          role: row[1] === "assistant" ? "assistant" : "user",
          text,
          marks,
          ...(row[2] === null ? {} : { timestamp: Number(row[2]) }),
          ...(row[3] === null ? {} : { model: String(row[3]) }),
        });
      },
    });
    return passages;
  }

  passagesFor(plan: QueryPlan, chatIds: string[], limit: number): Map<string, MarkedPassage[]> {
    const found = new Map<string, MarkedPassage[]>();
    // A few chats are cheaper one by one (a seek in each term's rows); many are cheaper in one pass.
    if (chatIds.length <= SEEK_MAX_CHATS) {
      for (const chatId of chatIds) {
        const passages = this.passages(plan, chatId, limit);
        if (passages.length > 0) found.set(chatId, passages);
      }
      return found;
    }

    const { required, optional } = buildMatches(plan, (term, max) => this.variants(term, max));
    const positive = anyOf([...required, ...optional]);
    if (!positive) return found;

    const idOf = new Map<number, string>();
    for (const chatId of chatIds) {
      const key = this.chatKey(chatId);
      if (key !== undefined) idOf.set(key, chatId);
    }

    // Pass one: the rows of the plan, in order, and the first rows of each chat that is asked for,
    // one for each message.
    const rows = new Map<number, { messages: Set<string>; rowids: number[] }>();
    this.db.exec({
      sql: "SELECT rowid, mid FROM msgs WHERE msgs MATCH ?",
      bind: [positive],
      rowMode: "array",
      callback: (row: unknown[]) => {
        const rowid = Number(row[0]);
        const key = Math.floor(rowid / ORDINAL_SPAN);
        if (!idOf.has(key)) return;
        let entry = rows.get(key);
        if (!entry) {
          entry = { messages: new Set(), rowids: [] };
          rows.set(key, entry);
        }
        const message = String(row[1]);
        if (entry.messages.has(message) || (limit >= 0 && entry.messages.size >= limit)) return;
        entry.messages.add(message);
        entry.rowids.push(rowid);
      },
    });

    // Pass two: the marks of those rows only. The unary plus keeps `rowid IN` from becoming one
    // seek for each row; the rows that pass are marked, and no others.
    const shown = [...rows.values()].flatMap((entry) => entry.rowids);
    for (let at = 0; at < shown.length; at += SHOWN_PER_QUERY) {
      this.db.exec({
        sql: `SELECT rowid, mid, role, ts, model,
                highlight(msgs, 0, ?, ?), highlight(msgs, 1, ?, ?)
              FROM msgs
              WHERE msgs MATCH ? AND +rowid IN (${shown.slice(at, at + SHOWN_PER_QUERY).join(",")})`,
        bind: [MARK_OPEN, MARK_CLOSE, MARK_OPEN, MARK_CLOSE, positive],
        rowMode: "array",
        callback: (row: unknown[]) => {
          const chatId = idOf.get(Math.floor(Number(row[0]) / ORDINAL_SPAN));
          if (chatId === undefined) return;
          const { text, marks } = readMarks(String(row[5]) || String(row[6]));
          let list = found.get(chatId);
          if (!list) {
            list = [];
            found.set(chatId, list);
          }
          list.push({
            messageId: String(row[1]),
            role: row[2] === "assistant" ? "assistant" : "user",
            text,
            marks,
            ...(row[3] === null ? {} : { timestamp: Number(row[3]) }),
            ...(row[4] === null ? {} : { model: String(row[4]) }),
          });
        },
      });
    }
    return found;
  }
}

/** The index on SQLite. The worker makes it through `createSearchIndex`; tests make it directly. */
export class SqliteSearchIndex implements SearchIndex {
  private host: SqliteHost | undefined;
  private live: Slot | undefined;
  private building: Slot | undefined;

  describe(): string {
    return this.host ? `SQLite ${this.host.version}, ${this.host.kind}` : "SQLite, not opened";
  }

  async open(): Promise<boolean> {
    this.close();
    const host = await openSqliteHost();
    this.host = host;

    // Read what each file holds; the live one is the newest of those finished in this format.
    let live: { slot: Slot; generation: number } | undefined;
    for (const name of SLOT_FILES) {
      const slot = this.openSlot(name);
      const generation = this.finishedGeneration(slot);
      if (generation === undefined) {
        this.wipe(slot);
      } else if (!live || generation > live.generation) {
        if (live) this.wipe(live.slot);
        live = { slot, generation };
      } else {
        this.wipe(slot);
      }
    }
    this.live = live?.slot;
    this.live?.tune(false);
    return this.live !== undefined;
  }

  private requireHost(): SqliteHost {
    if (!this.host) throw new Error("The search index is not open");
    return this.host;
  }

  private openSlot(name: string): Slot {
    return new Slot(name, this.requireHost().open(name));
  }

  /** The generation of a finished index in the current format, or undefined for any other file. */
  private finishedGeneration(slot: Slot): number | undefined {
    try {
      if (!slot.hasSchema()) return undefined;
      if (slot.getMeta("state") !== "live") return undefined;
      if (Number(slot.getMeta("format")) !== INDEX_FORMAT_VERSION) return undefined;
      return Number(slot.getMeta("generation"));
    } catch {
      // Not a database, or one cut short: it holds nothing to read.
      return undefined;
    }
  }

  /** Delete a file, so that its space is free and the next open of its name starts empty. */
  private wipe(slot: Slot): void {
    const host = this.requireHost();
    try {
      host.close(slot.db);
    } finally {
      host.unlink(slot.name);
    }
  }

  private requireLive(): Slot {
    if (!this.live) throw new Error("The search index has no live file");
    return this.live;
  }

  put(chat: IndexedChat): void {
    this.requireLive().put(chat);
  }

  remove(chatId: string): void {
    this.live?.remove(chatId);
  }

  transaction<T>(fn: () => T): T {
    return this.requireLive().transaction(fn);
  }

  chats(): number {
    return this.live?.chats() ?? 0;
  }

  search(plan: QueryPlan, filters: IndexFilters = {}): RankedChat[] {
    return this.live?.search(plan, filters) ?? [];
  }

  passages(plan: QueryPlan, chatId: string, limit = -1): MarkedPassage[] {
    return this.live?.passages(plan, chatId, limit) ?? [];
  }

  passagesFor(plan: QueryPlan, chatIds: string[], limit = -1): Map<string, MarkedPassage[]> {
    return this.live?.passagesFor(plan, chatIds, limit) ?? new Map();
  }

  beginRebuild(): IndexBuild {
    if (this.building) throw new Error("A rebuild of the search index is already writing");
    const host = this.requireHost();
    const target = SLOT_FILES.find((name) => name !== this.live?.name) ?? SLOT_FILES[0];
    host.unlink(target);
    const slot = this.openSlot(target);
    slot.createSchema();
    slot.setMeta("state", "building");
    slot.tune(true);
    this.building = slot;

    return {
      put: (chat) => slot.put(chat),
      remove: (chatId) => slot.remove(chatId),
      transaction: (fn) => slot.transaction(fn),
      chats: () => slot.chats(),
      commit: () => {
        // The one write that makes the file the index; with synchronous full, it is also the
        // flush of everything written before it.
        slot.db.exec("PRAGMA synchronous = FULL");
        const generation = (this.live ? (this.finishedGeneration(this.live) ?? 0) : 0) + 1;
        slot.transaction(() => {
          slot.setMeta("format", INDEX_FORMAT_VERSION);
          slot.setMeta("generation", generation);
          slot.setMeta("state", "live");
        });
        slot.tune(false);
        const old = this.live;
        this.live = slot;
        this.building = undefined;
        if (old) this.wipe(old);
      },
      discard: () => {
        this.building = undefined;
        this.wipe(slot);
      },
    };
  }

  close(): void {
    const host = this.host;
    if (!host) return;
    for (const slot of [this.live, this.building]) {
      if (slot) host.close(slot.db);
    }
    this.live = undefined;
    this.building = undefined;
    this.host = undefined;
  }
}
