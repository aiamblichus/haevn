// The search index's one door to SQLite: the only module that imports `@sqlite.org/sqlite-wasm`
// (a lint rule says so). It hides the engine, the file and the query language from the search
// worker.

import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

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

const PROBE_FILE = "/haevn-search-probe.db";

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

/** What an open of the database found: the version and whether FTS5 is in the build. */
export interface SqliteProbe {
  kind: SqliteHost["kind"];
  version: string;
  fts5: boolean;
}

/**
 * Open the database and say what it is, or throw why it cannot be opened. The search worker calls
 * this at init and logs the answer, so a machine on which the file cannot be opened (a locked
 * handle, a quota, an old Chrome) shows up in the log before search depends on it.
 */
export async function probeSqlite(): Promise<SqliteProbe> {
  const host = await openSqliteHost();
  const db = host.open(PROBE_FILE);
  try {
    const options = db.selectValues("PRAGMA compile_options") as string[];
    return {
      kind: host.kind,
      version: host.version,
      fts5: options.includes("ENABLE_FTS5"),
    };
  } finally {
    host.close(db);
    host.unlink(PROBE_FILE);
  }
}
