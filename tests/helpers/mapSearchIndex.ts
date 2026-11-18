// A `SearchIndex` kept in plain Maps: no SQLite, no query language, a tokenizer that is a regular
// expression and a fold. The worker's tests run against it as well as against the real index, so
// that a test which passes only on SQLite shows the seam leaks (HVN-87). It is as faithful as the
// tests need: words are cut where the real tokenizer cuts them, folded the same way, and a
// passage's marks are the tokens the query matched.

import type { IndexedChat } from "../../src/services/searchDocument";
import { foldText } from "../../src/services/searchFold";
import {
  INDEX_FORMAT_VERSION,
  type IndexBuild,
  type IndexFilters,
  type MarkedPassage,
  type RankedChat,
  type SearchIndex,
} from "../../src/services/searchIndex";
import { editDistanceWithin } from "../../src/services/searchMatch";
import type { QueryClause, QueryPlan } from "../../src/services/searchWorkerQuery";

interface Token {
  word: string;
  start: number;
  end: number;
}

const TOKEN = /[\p{L}\p{N}\p{Co}\p{So}\p{M}_]+/gu;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ word: foldText(match[0]), start, end: start + match[0].length });
  }
  return tokens;
}

interface Row {
  id: string;
  role: "user" | "assistant";
  text: string;
  title: boolean;
  timestamp?: number;
  model?: string;
  tokens: Token[];
}

interface Doc {
  chatId: string;
  source: string;
  timestamp: number;
  rows: Row[];
}

interface File {
  format: number;
  docs: Map<string, Doc>;
}

/** The files of the fixture: they outlive a "worker restart", as a file in OPFS does. */
const STORE = Symbol.for("haevn.test.mapSearchIndex");
function store(): { live?: File } {
  const holder = globalThis as unknown as Record<symbol, { live?: File } | undefined>;
  const state = holder[STORE] ?? {};
  holder[STORE] = state;
  return state;
}

export function resetMapSearchIndex(): void {
  (globalThis as unknown as Record<symbol, unknown>)[STORE] = undefined;
}

/** Leave an index of another format where the next open finds it. */
export function seedMapIndexOfFormat(format: number): void {
  store().live = { format, docs: new Map() };
}

function rowsOf(chat: IndexedChat): Row[] {
  const rows: Row[] = [];
  if (chat.title) {
    rows.push({
      id: "title",
      role: "user",
      text: chat.title,
      title: true,
      tokens: tokenize(chat.title),
    });
  }
  for (const message of chat.messages) {
    rows.push({ ...message, title: false, tokens: tokenize(message.text) });
  }
  return rows;
}

/** The words of a clause as the index would cut them. */
function clauseWords(clause: QueryClause): string[] {
  return tokenize(clause.term).map((token) => token.word);
}

type Matcher = (row: Row) => { start: number; end: number }[];

function vocabulary(file: File): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of file.docs.values()) {
    for (const row of doc.rows) {
      for (const token of new Set(row.tokens.map((t) => t.word))) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function matcherFor(clause: QueryClause, file: File): Matcher {
  const words = clauseWords(clause);
  if (words.length === 0) return () => [];

  if (clause.editDistance && !clause.phrase) {
    const [word] = words;
    const near = new Set(
      [...vocabulary(file).keys()].filter(
        (term) =>
          editDistanceWithin(word, term, clause.editDistance as number) <=
          (clause.editDistance as number),
      ),
    );
    near.add(word);
    return (row) =>
      row.tokens.filter((t) => near.has(t.word)).map((t) => ({ start: t.start, end: t.end }));
  }

  return (row) => {
    const found: { start: number; end: number }[] = [];
    for (let i = 0; i + words.length <= row.tokens.length; i++) {
      const fits = words.every((word, k) => {
        const token = row.tokens[i + k].word;
        return clause.prefix && k === words.length - 1 ? token.startsWith(word) : token === word;
      });
      if (fits)
        found.push({ start: row.tokens[i].start, end: row.tokens[i + words.length - 1].end });
    }
    return found;
  };
}

function passesFilters(doc: Doc, filters: IndexFilters): boolean {
  if (filters.after !== undefined && doc.timestamp < filters.after) return false;
  if (filters.before !== undefined && doc.timestamp > filters.before) return false;
  if (filters.provider !== undefined && doc.source !== filters.provider) return false;
  if (filters.chatId !== undefined && doc.chatId !== filters.chatId) return false;
  return true;
}

class MapWriter {
  constructor(protected file: File) {}

  put(chat: IndexedChat): void {
    this.file.docs.set(chat.id, {
      chatId: chat.id,
      source: chat.source ?? "",
      timestamp: Number.isFinite(chat.timestamp) ? chat.timestamp : 0,
      rows: rowsOf(chat),
    });
  }

  remove(chatId: string): void {
    this.file.docs.delete(chatId);
  }

  transaction<T>(fn: () => T): T {
    const before = new Map(this.file.docs);
    try {
      return fn();
    } catch (error) {
      this.file.docs.clear();
      for (const [id, doc] of before) this.file.docs.set(id, doc);
      throw error;
    }
  }

  chats(): number {
    return this.file.docs.size;
  }
}

class MapSearchIndex extends MapWriter implements SearchIndex {
  private opened = false;
  private building: File | undefined;

  constructor() {
    super({ format: INDEX_FORMAT_VERSION, docs: new Map() });
  }

  describe(): string {
    return "Map fixture";
  }

  async open(): Promise<boolean> {
    this.opened = true;
    const live = store().live;
    if (live && live.format === INDEX_FORMAT_VERSION) {
      this.file = live;
      return true;
    }
    // Another format is not read; the next rebuild replaces it.
    this.file = { format: -1, docs: new Map() };
    return false;
  }

  private ready(): boolean {
    return this.opened && this.file.format === INDEX_FORMAT_VERSION;
  }

  put(chat: IndexedChat): void {
    if (!this.ready()) throw new Error("The search index has no live file");
    super.put(chat);
  }

  search(plan: QueryPlan, filters: IndexFilters = {}): RankedChat[] {
    if (!this.ready()) return [];
    const required = plan.clauses.filter((c) => c.presence === "required");
    const optional = plan.clauses.filter((c) => c.presence === "optional");
    const excluded = plan.clauses.filter((c) => c.presence === "excluded");
    const positive = [...required, ...optional].map((c) => matcherFor(c, this.file));
    const must = required.map((c) => matcherFor(c, this.file));
    const never = excluded.map((c) => matcherFor(c, this.file));
    const any = (matchers: Matcher[], doc: Doc) =>
      matchers.some((m) => doc.rows.some((r) => m(r).length > 0));

    const ranked: RankedChat[] = [];
    for (const doc of this.file.docs.values()) {
      if (!passesFilters(doc, filters)) continue;
      if (must.length > 0 && !must.every((m) => any([m], doc))) continue;
      if (must.length === 0 && !any(positive, doc)) continue;
      if (never.length > 0 && any(never, doc)) continue;
      // Hits count, short text counts for more, the title ten times: the shape of bm25, not its numbers.
      let score = 0;
      for (const row of doc.rows) {
        const hits = positive.reduce((n, m) => n + m(row).length, 0);
        score += (hits * (row.title ? 10 : 1)) / (1 + row.tokens.length / 100);
      }
      ranked.push({ chatId: doc.chatId, score });
    }
    return ranked.sort((a, b) => b.score - a.score);
  }

  passagesFor(plan: QueryPlan, chatIds: string[], limit = -1): Map<string, MarkedPassage[]> {
    const found = new Map<string, MarkedPassage[]>();
    for (const chatId of chatIds) {
      const passages = this.passages(plan, chatId, limit);
      if (passages.length > 0) found.set(chatId, passages);
    }
    return found;
  }

  passages(plan: QueryPlan, chatId: string, limit = -1): MarkedPassage[] {
    const doc = this.ready() ? this.file.docs.get(chatId) : undefined;
    if (!doc) return [];
    const matchers = plan.clauses
      .filter((c) => c.presence !== "excluded")
      .map((c) => matcherFor(c, this.file));
    const passages: MarkedPassage[] = [];
    const seen = new Set<string>();
    for (const row of doc.rows) {
      if (seen.has(row.id)) continue;
      const spans = matchers.flatMap((m) => m(row)).sort((a, b) => a.start - b.start);
      if (spans.length === 0) continue;
      seen.add(row.id);
      passages.push({
        messageId: row.id,
        role: row.role,
        text: row.text,
        marks: spans.map((s) => ({ start: s.start, length: s.end - s.start })),
        ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
        ...(row.model === undefined ? {} : { model: row.model }),
      });
      if (limit >= 0 && passages.length >= limit) break;
    }
    return passages;
  }

  beginRebuild(): IndexBuild {
    if (this.building) throw new Error("A rebuild of the search index is already writing");
    const file: File = { format: -1, docs: new Map() };
    this.building = file;
    const writer = new MapWriter(file);
    return {
      put: (chat) => writer.put(chat),
      remove: (id) => writer.remove(id),
      transaction: (fn) => writer.transaction(fn),
      chats: () => writer.chats(),
      commit: () => {
        file.format = INDEX_FORMAT_VERSION;
        store().live = file;
        this.file = file;
        this.building = undefined;
      },
      discard: () => {
        this.building = undefined;
      },
    };
  }

  close(): void {
    this.opened = false;
  }
}

export function createMapSearchIndex(): SearchIndex {
  return new MapSearchIndex();
}
