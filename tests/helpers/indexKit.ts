import {
  openSqliteHost,
  resetMemorySqliteHost,
  type SearchIndex,
  SqliteSearchIndex,
} from "../../src/services/searchIndex";
import { createMapSearchIndex, resetMapSearchIndex, seedMapIndexOfFormat } from "./mapSearchIndex";

/**
 * The two implementations of `SearchIndex` the worker's tests run against: SQLite itself (in
 * memory, from the Node build of `@sqlite.org/sqlite-wasm`), and the Map fixture. Each can start
 * empty, and each can be given an index file of another format, which is what an old release or a
 * newer one leaves behind.
 */
export interface IndexKit {
  name: "sqlite" | "map";
  create(): SearchIndex;
  /** Forget every file: a first run. */
  reset(): void;
  /** Leave a finished index of this format where the next open finds it. */
  seedFormat(format: number): Promise<void>;
}

export const sqliteKit: IndexKit = {
  name: "sqlite",
  create: () => new SqliteSearchIndex(),
  reset: resetMemorySqliteHost,
  async seedFormat(format) {
    const host = await openSqliteHost();
    host.open("/haevn-search-a.db").exec(
      `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
         INSERT INTO meta VALUES ('state', 'live'), ('format', '${format}'), ('generation', '1');`,
    );
  },
};

export const mapKit: IndexKit = {
  name: "map",
  create: createMapSearchIndex,
  reset: resetMapSearchIndex,
  async seedFormat(format) {
    seedMapIndexOfFormat(format);
  },
};

export const kits: IndexKit[] = [sqliteKit, mapKit];
