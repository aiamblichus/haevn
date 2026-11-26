// The search index's one door to SQLite: the only module that imports `@sqlite.org/sqlite-wasm`
// (a lint rule says so). It hides the engine, the files and the query language from the search
// worker, which sees the `SearchIndex` below and nothing of how it is kept.
//
// Shape of the data. One FTS5 table, `msgs`, with a row for each thing a chat said: its title, its
// system prompt, and what the user and what the assistant said in each message, and then a row
// for each model and each tag it carries (`mid` is `haevn:model` or `haevn:tag`, the label is the
// row's body; HVN-164). A row's rowid is
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
import { type IndexedChat, LABEL_IDS, type LabelKind, MAX_LABELS } from "./searchDocument";
import { foldText } from "./searchFold";
import {
  anyOf,
  buildMatches,
  editDistanceWithin,
  type Match,
  type PlanMatches,
} from "./searchMatch";
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

function hasOpfs(): boolean {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  return typeof storage?.getDirectory === "function";
}

/**
 * Whether the memory host was asked for. Only tests ask (tests/setup.ts sets the flag, on
 * `globalThis` so that a module the test reloads still sees it): where the extension has no OPFS,
 * an index in memory would rebuild at every start and keep in RAM what this index exists to free.
 */
const MEMORY_HOST_FLAG = Symbol.for("haevn.search.useMemoryHost");

/** Ask for the memory host, or take the request back. For tests. */
export function useMemorySqliteHost(on = true): void {
  (globalThis as unknown as Record<symbol, boolean>)[MEMORY_HOST_FLAG] = on;
}

function memoryHostChosen(): boolean {
  return (globalThis as unknown as Record<symbol, boolean | undefined>)[MEMORY_HOST_FLAG] === true;
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

/**
 * The index lives in the "opfs-sahpool" VFS. At start-up the library also tries to install its
 * "opfs" and "opfs-wl" VFSes, which find a helper script by URL; an IIFE worker has none to give,
 * so each logs "Ignoring inability to install …: Invalid URL". They are never used: turn them off
 * by name before the first init (the library reads this once, at bootstrap, then deletes it).
 * "opfs-sahpool" has its own switch and does not need what they share.
 */
function disableUnusedOpfsVfses(): void {
  (globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, "opfs-wl": true } },
  };
}

async function openOpfsHost(): Promise<SqliteHost> {
  disableUnusedOpfsVfses();
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
  if (memoryHostChosen()) return openMemoryHost();
  if (!hasOpfs()) {
    // Nothing to wait for: a pause does not give a context its file system.
    throw new Error(
      "The search index needs the origin private file system (OPFS), and this context has no navigator.storage.getDirectory.",
    );
  }
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
 *   4: and a row for each model and each tag of a chat (HVN-164). The tables are the same; an
 *      index of format 3 has no label rows, so it is not read and the next start rebuilds it.
 *   5: the model labels also hold the model each response names (`model_name`, HVN-168). Same
 *      tables; an index of format 4 lacks those labels for chats synced earlier, so it is not read
 *      and the next start rebuilds it.
 */
export const INDEX_FORMAT_VERSION = 5;

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

const SQLITE_ERROR = 1; // no such table, a schema that is not ours
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Whether SQLite said, reading a file, that it is not an index of ours (cut short, or torn). */
function isNotAnIndex(error: unknown): boolean {
  const code = (error as { resultCode?: unknown } | null)?.resultCode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === SQLITE_ERROR || primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
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

/** One MATCH that rows are looked for by, and the label rows it is confined to, if it is. */
interface Source {
  match: string;
  scope?: LabelKind;
}

/** A row of a chat that a search shows a passage of, and which source found it. */
interface ShownRow {
  rowid: number;
  mid: string;
  source: number;
}

/**
 * The rows a MATCH looks at, as a condition on `mid`: the rows of one kind of label for a clause
 * confined to it, and for every other clause the title and the messages, never a label. A word
 * typed plain is about what was said, and the labels of a synced chat are often the provider's own
 * name, so `-claude` must not drop every chat of Claude's (HVN-164).
 */
function rowsOf(scope: LabelKind | undefined): string {
  return scope ? " AND mid = ?" : " AND mid NOT IN (?, ?)";
}

/** The binding of `rowsOf`. */
function scopeBinding(scope: LabelKind | undefined): Binding {
  return scope ? [LABEL_IDS[scope]] : [LABEL_IDS.model, LABEL_IDS.tag];
}

/** The binding of a source's MATCH and of its `rowsOf`. */
function matchBinding(source: Source): Binding {
  return [source.match, ...scopeBinding(source.scope)];
}

/**
 * What a plan is looked for by: every word that is not confined as one MATCH (it looks at the
 * title and the messages), then the words confined to the models, then the ones confined to the
 * tags. A passage is a row that one of them matches.
 */
function passageSources(matches: PlanMatches): Source[] {
  const sources: Source[] = [];
  const plain = anyOf([...matches.required, ...matches.optional]);
  if (plain) sources.push({ match: plain });
  for (const scope of ["model", "tag"] as const) {
    const confined = anyOf(matches.required, scope);
    if (confined) sources.push({ match: confined, scope });
  }
  return sources;
}

/** One index file. */
class Slot implements IndexWriter {
  private inTransaction = false;

  /** `variants` answers since the last write; a write can add a word. */
  private nearSpellings = new Map<string, string[]>();

  /** How many rowids a chat's rows have between them: 2^bits (only a test makes it smaller). */
  private readonly span: number;

  constructor(
    readonly name: string,
    readonly db: Database,
    private readonly bits: number,
  ) {
    this.span = 2 ** bits;
  }

  /** The first rowid of the chat with this key. */
  private firstRowid(chat: number): number {
    return chat * this.span;
  }

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
      bind: [this.firstRowid(key), this.firstRowid(key + 1) - 1],
    });
  }

  put(chat: IndexedChat): void {
    this.nearSpellings.clear();
    // The types say a source and a time; a row the database holds may lack either, and one such
    // chat must not fail the rebuild of the rest (the columns are NOT NULL).
    const source = chat.source ?? "";
    const timestamp = Number.isFinite(chat.timestamp) ? chat.timestamp : 0;
    this.transaction(() => {
      const known = this.chatKey(chat.id);
      let key: number;
      if (known === undefined) {
        this.db.exec({
          sql: "INSERT INTO docs(chat_id, provider, ts) VALUES (?, ?, ?)",
          bind: [chat.id, source, timestamp],
        });
        key = Number(this.db.selectValue("SELECT last_insert_rowid()"));
      } else {
        key = known;
        this.clearRows(key);
        this.db.exec({
          sql: "UPDATE docs SET provider = ?, ts = ? WHERE id = ?",
          bind: [source, timestamp, key],
        });
      }

      const insert = this.db.prepare(
        "INSERT INTO msgs(rowid, title, body, mid, role, ts, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      try {
        let ordinal = 0;
        const add = (...values: Binding) => {
          insert.bind([this.firstRowid(key) + ordinal++, ...values]).stepReset();
        };
        if (chat.title) add(chat.title, "", "title", "user", null, null);
        // The labels come last, with room kept for them, so that a chat of a million messages
        // still has its models and tags.
        for (const message of chat.messages) {
          if (ordinal >= this.span - 2 * MAX_LABELS) break;
          add(
            "",
            message.text,
            message.id,
            message.role,
            message.timestamp ?? null,
            message.model ?? null,
          );
        }
        for (const label of chat.models.slice(0, MAX_LABELS)) {
          add("", label, LABEL_IDS.model, "user", null, null);
        }
        for (const label of chat.tags.slice(0, MAX_LABELS)) {
          add("", label, LABEL_IDS.tag, "user", null, null);
        }
      } finally {
        insert.finalize();
      }
    });
  }

  remove(chatId: string): void {
    this.nearSpellings.clear();
    this.transaction(() => {
      const key = this.chatKey(chatId);
      if (key === undefined) return;
      this.clearRows(key);
      this.db.exec({ sql: "DELETE FROM docs WHERE id = ?", bind: [key] });
    });
  }

  /**
   * The words of the index within `maxEdits` of `term`, the most common first. Finding them reads
   * the whole vocabulary, so the answer is kept until the next write: the search and the passages
   * of its chats ask the same question.
   */
  variants(term: string, maxEdits: number): string[] {
    const key = `${maxEdits}:${term}`;
    const known = this.nearSpellings.get(key);
    if (known) return known;
    const found = this.scanVariants(term, maxEdits);
    this.nearSpellings.set(key, found);
    return found;
  }

  private scanVariants(term: string, maxEdits: number): string[] {
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
    const matches = buildMatches(plan, (term, max) => this.variants(term, max));
    const { required, optional, excluded } = matches;
    const sources = passageSources(matches);
    if (sources.length === 0) return [];

    // The chats that satisfy every required clause (or any optional one), less the excluded ones.
    // A clause confined to the models or the tags looks only at those rows; any other looks only
    // at the title and the messages.
    const bind: Binding = [];
    const chatsOf = (match: Match): string => {
      bind.push(match.text, ...scopeBinding(match.scope));
      return `SELECT rowid >> ${this.bits} AS c FROM msgs WHERE msgs MATCH ?${rowsOf(match.scope)}`;
    };
    let sets =
      required.length > 0
        ? required.map(chatsOf).join(" INTERSECT ")
        : chatsOf({ text: anyOf(optional) as string });
    const out = anyOf(excluded);
    if (out) sets += ` EXCEPT ${chatsOf({ text: out })}`;
    for (const match of excluded) {
      if (match.scope) sets += ` EXCEPT ${chatsOf(match)}`;
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
    for (const source of sources) {
      this.db.exec({
        sql: `SELECT rowid >> ${this.bits}, bm25(msgs, ${TITLE_WEIGHT}.0, 1.0) FROM msgs WHERE msgs MATCH ?${rowsOf(
          source.scope,
        )}`,
        bind: matchBinding(source),
        rowMode: "array",
        callback: (row: unknown[]) => {
          const hit = hits.get(Number(row[0]));
          if (hit) hit.score -= Number(row[1]);
        },
      });
    }

    return [...hits.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .map(([, hit]) => hit);
  }

  /** What a plan is looked for by when its passages are shown. */
  private sourcesOf(plan: QueryPlan): Source[] {
    return passageSources(buildMatches(plan, (term, max) => this.variants(term, max)));
  }

  /**
   * The rows to show for the chats in `wanted` (their keys): a message is one passage, however
   * many of its rows have a word, so the first row of each, in rowid order (the user's text before
   * the assistant's), up to `limit` of them for a chat. Rows are found for every source, and a row
   * that two of them match belongs to the first. `range` is one chat's rowids, when it is one.
   */
  private findRows(
    sources: Source[],
    wanted: ReadonlySet<number>,
    limit: number,
    range?: number[],
  ): Map<number, ShownRow[]> {
    const found = new Map<number, Map<number, ShownRow>>();
    sources.forEach((source, which) => {
      // A source's own first `limit` messages of a chat are all it can add to what is shown.
      const taken = new Map<number, Set<string>>();
      this.db.exec({
        sql: `SELECT rowid, mid FROM msgs WHERE msgs MATCH ?${rowsOf(source.scope)}${
          range ? " AND rowid BETWEEN ? AND ? ORDER BY rowid" : ""
        }`,
        bind: [...matchBinding(source), ...(range ?? [])],
        rowMode: "array",
        callback: (row: unknown[]) => {
          const rowid = Number(row[0]);
          const key = Math.floor(rowid / this.span);
          if (!wanted.has(key)) return;
          const message = String(row[1]);
          let messages = taken.get(key);
          if (!messages) {
            messages = new Set();
            taken.set(key, messages);
          }
          if (messages.has(message) || (limit >= 0 && messages.size >= limit)) return;
          messages.add(message);
          let rows = found.get(key);
          if (!rows) {
            rows = new Map();
            found.set(key, rows);
          }
          if (!rows.has(rowid)) rows.set(rowid, { rowid, mid: message, source: which });
        },
      });
    });

    const shown = new Map<number, ShownRow[]>();
    for (const [key, rows] of found) {
      const seen = new Set<string>();
      const list: ShownRow[] = [];
      for (const row of [...rows.values()].sort((a, b) => a.rowid - b.rowid)) {
        if (seen.has(row.mid)) continue;
        if (limit >= 0 && list.length >= limit) break;
        seen.add(row.mid);
        list.push(row);
      }
      shown.set(key, list);
    }
    return shown;
  }

  /**
   * The marks of the rows that are shown, and of no others. Without a `range` the unary plus keeps
   * `rowid IN` from becoming one seek for each row; the rows that pass are marked.
   */
  private markRows(
    sources: Source[],
    rows: ShownRow[],
    range?: number[],
  ): Map<number, MarkedPassage> {
    const marked = new Map<number, MarkedPassage>();
    sources.forEach((source, which) => {
      const own = rows.filter((row) => row.source === which).map((row) => row.rowid);
      for (let at = 0; at < own.length; at += SHOWN_PER_QUERY) {
        const list = own.slice(at, at + SHOWN_PER_QUERY).join(",");
        this.db.exec({
          sql: `SELECT rowid, mid, role, ts, model,
                  highlight(msgs, 0, ?, ?), highlight(msgs, 1, ?, ?)
                FROM msgs
                WHERE msgs MATCH ?${rowsOf(source.scope)} AND ${
                  range ? `rowid BETWEEN ? AND ? AND rowid IN (${list})` : `+rowid IN (${list})`
                }`,
          bind: [
            MARK_OPEN,
            MARK_CLOSE,
            MARK_OPEN,
            MARK_CLOSE,
            ...matchBinding(source),
            ...(range ?? []),
          ],
          rowMode: "array",
          callback: (row: unknown[]) => {
            const { text, marks } = readMarks(String(row[5]) || String(row[6]));
            marked.set(Number(row[0]), {
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
    });
    return marked;
  }

  /** The passages of the chats in `chatOf` (key to id), in rowid order for each. */
  private readPassages(
    sources: Source[],
    chatOf: ReadonlyMap<number, string>,
    limit: number,
    range?: number[],
  ): Map<string, MarkedPassage[]> {
    const passages = new Map<string, MarkedPassage[]>();
    if (sources.length === 0) return passages;
    const rows = this.findRows(sources, new Set(chatOf.keys()), limit, range);
    const marked = this.markRows(sources, [...rows.values()].flat(), range);
    for (const [key, list] of rows) {
      const chatId = chatOf.get(key);
      const found = list.flatMap((row) => marked.get(row.rowid) ?? []);
      if (chatId !== undefined && found.length > 0) passages.set(chatId, found);
    }
    return passages;
  }

  passages(plan: QueryPlan, chatId: string, limit: number): MarkedPassage[] {
    const key = this.chatKey(chatId);
    if (key === undefined) return [];
    // The rows are found first, and only the ones that are shown are marked.
    const range = [this.firstRowid(key), this.firstRowid(key + 1) - 1];
    const found = this.readPassages(this.sourcesOf(plan), new Map([[key, chatId]]), limit, range);
    return found.get(chatId) ?? [];
  }

  passagesFor(plan: QueryPlan, chatIds: string[], limit: number): Map<string, MarkedPassage[]> {
    // A few chats are cheaper one by one (a seek in each term's rows); many are cheaper in one pass.
    if (chatIds.length <= SEEK_MAX_CHATS) {
      const found = new Map<string, MarkedPassage[]>();
      for (const chatId of chatIds) {
        const passages = this.passages(plan, chatId, limit);
        if (passages.length > 0) found.set(chatId, passages);
      }
      return found;
    }

    const idOf = new Map<number, string>();
    for (const chatId of chatIds) {
      const key = this.chatKey(chatId);
      if (key !== undefined) idOf.set(key, chatId);
    }
    return this.readPassages(this.sourcesOf(plan), idOf, limit);
  }
}

/** The index on SQLite. The worker makes it through `createSearchIndex`; tests make it directly. */
export class SqliteSearchIndex implements SearchIndex {
  private host: SqliteHost | undefined;
  private live: Slot | undefined;
  private building: Slot | undefined;

  /** `ordinalBits` is for a test that needs a chat to run out of rowids without a million rows. */
  constructor(private readonly ordinalBits = ORDINAL_BITS) {}

  describe(): string {
    return this.host ? `SQLite ${this.host.version}, ${this.host.kind}` : "SQLite, not opened";
  }

  async open(): Promise<boolean> {
    this.close();
    const host = await openSqliteHost();
    this.host = host;

    // Read what each file holds; the live one is the newest of those finished in this format.
    let live: { slot: Slot; generation: number } | undefined;
    const opened: Slot[] = [];
    try {
      for (const name of SLOT_FILES) {
        const slot = this.openSlot(name);
        opened.push(slot);
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
    } catch (e) {
      // A file that could not be read is left as it is, and its handle is let go, so that the
      // next open (in this worker or the next) is not met by a handle that is still held.
      for (const slot of opened) {
        try {
          host.close(slot.db);
        } catch {
          // already closed by a wipe
        }
      }
      this.host = undefined;
      throw e;
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
    return new Slot(name, this.requireHost().open(name), this.ordinalBits);
  }

  /** The generation of a finished index in the current format, or undefined for any other file. */
  private finishedGeneration(slot: Slot): number | undefined {
    try {
      if (!slot.hasSchema()) return undefined;
      if (slot.getMeta("state") !== "live") return undefined;
      if (Number(slot.getMeta("format")) !== INDEX_FORMAT_VERSION) return undefined;
      return Number(slot.getMeta("generation"));
    } catch (e) {
      // Only what says the file is not an index is a reason to wipe it. A read that failed for
      // another reason (the file is busy, memory ran out) may pass, and the index in it is whole.
      if (isNotAnIndex(e)) return undefined;
      throw e;
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
