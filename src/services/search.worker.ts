// Search Worker - Segmented Architecture with Positional Metadata and Hydration
import lunr from "lunr";
import type {
  Chat,
  ChatMessage,
  SearchResult,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";
import type {
  SearchFilters,
  SearchIndexIncompleteStatus,
  SearchIndexRebuildStatus,
  SearchWorkerMessage,
} from "../types/workerMessages";
import { log } from "../utils/logger";
import { HaevnDatabase } from "./db";
import { inCategory, inDateRange, needsCategory } from "./searchFilters";
import {
  createIndexBuilder,
  createQueryTermPipeline,
  INDEX_FORMAT_VERSION,
} from "./searchPipeline";
import { normalizeSearchText, type ParsedQuery, parseSearchQuery } from "./searchQuery";
import { buildSnippet, lowerCaseRangeMapper, type TextRange, trimToWord } from "./searchSnippet";
import { buildSearchResultsForChat } from "./searchTextMatch";
import {
  applyClauses,
  buildQueryPlan,
  buildRelaxedPlan,
  type PhraseConstraint,
  type QueryClause,
  queryNeedsExactPhrasePath,
} from "./searchWorkerQuery";

// --- Configuration ---
const SEGMENT_SIZE = 200; // Chats per segment
const REBUILD_DEBOUNCE_MS = 2000;
const SNIPPET_RADIUS = 60; // Context characters around match
const DEFAULT_MAX_CHATS = 1000; // Chats a hydrated search returns when the caller names no limit
// The record in `lunrIndex` that says which format the segments are in (HVN-65). A rebuild
// removes it with the segments and writes it back as its last step, so only a pass that ended
// well leaves it.
const FORMAT_RECORD_ID = "format";

// --- Types ---

interface SearchDoc {
  id: string;
  title: string;
  content: string;
}

// [start, length, messageId, role]
type SourceMapEntry = [number, number, string, "user" | "assistant"];
type SourceMap = SourceMapEntry[];

// Lunr types (not exported by lunr.js)
interface LunrMatchMetadata {
  [term: string]: {
    [field: string]: {
      position?: [number, number][];
    };
  };
}

interface LunrMatchData {
  metadata: LunrMatchMetadata;
}

interface LunrResult {
  ref: string;
  score: number;
  matchData: LunrMatchData;
}

interface LunrIndexWithPipeline extends lunr.Index {
  pipeline: lunr.Pipeline;
}

interface IndexRebuildState {
  totalChats: number;
  processedChats: number;
  isRebuilding: boolean;
  chunkSize: number;
  currentChunk: number;
}

interface Segment {
  id: string;
  index: lunr.Index;
  builder?: lunr.Builder; // Only present for the active (mutable) segment
  docIds: Set<string>; // Fast lookup for deletions
  dirty: boolean;
  timestamp: number;
}

const db = new HaevnDatabase();

function toMessageDict(rows: ChatMessage[]): Record<string, ChatMessage> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

async function attachMessages(chats: Chat[]): Promise<Chat[]> {
  const chatIds = chats.map((chat) => chat.id).filter((id): id is string => !!id);
  if (chatIds.length === 0) return chats;

  const rows = await db.chatMessages.where("chatId").anyOf(chatIds).toArray();
  if (rows.length === 0) {
    return chats;
  }

  const byChatId = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    const current = byChatId.get(row.chatId);
    if (current) {
      current.push(row);
    } else {
      byChatId.set(row.chatId, [row]);
    }
  }

  return chats.map((chat) => {
    const migratedRows = chat.id ? byChatId.get(chat.id) : undefined;
    if (!migratedRows || migratedRows.length === 0) {
      return chat;
    }
    return {
      ...chat,
      messages: toMessageDict(migratedRows),
    };
  });
}

async function loadChatWithMessages(chatId: string): Promise<Chat | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  const migratedRows = await db.chatMessages.where("chatId").equals(chatId).toArray();
  if (migratedRows.length === 0) {
    return chat;
  }
  return {
    ...chat,
    messages: toMessageDict(migratedRows),
  };
}

// --- Global State ---
const segments: Map<string, Segment> = new Map();
let activeSegmentId: string = "segment_0";
let rebuildTimer: number | undefined;
const docCache: Map<string, SearchDoc> = new Map(); // Only for active segment
let bulkMode = false;
let rebuildState: IndexRebuildState | null = null;
// The run that is rebuilding now (every pass of it), so a second request can join it.
let rebuildRun: Promise<RebuildOutcome> | null = null;
// Set by a request that arrives during a run: the run goes once more, so chats written after
// the running pass read its `count()` are indexed (HVN-50).
let rebuildAgain = false;
// Chats an `add` named while a pass ran (HVN-54). The pass owns the segments, so the add only
// leaves its id here; the pass indexes these from the database before it ends.
const addedDuringRebuild = new Set<string>();
// The format version the stored segments carry, or undefined when none is on record (an index
// from before versions, or a rebuild that has not ended). The consistency check compares it with
// INDEX_FORMAT_VERSION.
let storedFormat: number | undefined;
// Set when the last rebuild pass failed; the index is then part-built until a rebuild succeeds.
let rebuildFailure: string | null = null;
// A failed pass is retried by `init` once per worker lifetime, so a failure that never goes away
// costs one more full read per browser session, not one per service worker wake.
let failureRetried = false;

interface RebuildOutcome {
  /** Why the last pass failed; absent when it succeeded. */
  error?: string;
}

// --- Helper: Text Extraction & Mapping ---

/**
 * The one place that decides what text of a chat is searchable: the index is built from `doc`,
 * and a snippet is cut from the same `doc` by the positions the index kept, so every site that
 * indexes a chat, and the one that shows a hit, goes through here (HVN-76). Nothing is cut off:
 * the text of a long chat is searchable to its end.
 */
function extractTextAndMap(chat: Chat): { doc: SearchDoc; map: SourceMap } | null {
  if (!chat.id) return null;

  const combined: string[] = [];
  const map: SourceMap = [];
  let currentOffset = 0;

  const append = (text: string, msgId: string, role: "user" | "assistant") => {
    if (!text) return;
    const clean = text.replace(/\s+/g, " ");
    if (!clean) return;

    combined.push(clean);
    map.push([currentOffset, clean.length, msgId, role]);

    currentOffset += clean.length + 1;
  };

  if (chat.title) append(chat.title, "title", "user");
  if (chat.system) append(chat.system, "system", "user");

  const messages = Object.values(chat.messages || {});

  for (const cm of messages) {
    if (!cm.message) continue;

    for (const mm of cm.message) {
      if (mm.kind === "request") {
        for (const part of mm.parts || []) {
          if (part.part_kind === "user-prompt") {
            const up = part as UserPromptPart;
            if (typeof up.content === "string") {
              append(up.content, cm.id, "user");
            } else if (Array.isArray(up.content)) {
              for (const c of up.content) {
                if (typeof c === "string") append(c, cm.id, "user");
              }
            }
          } else if (part.part_kind === "system-prompt") {
            const sp = part as SystemPromptPart;
            if (typeof sp.content === "string") {
              append(sp.content, cm.id, "user");
            }
          }
        }
      } else if (mm.kind === "response") {
        for (const part of mm.parts || []) {
          if (part.part_kind === "text") {
            const tp = part as TextPart;
            if (typeof tp.content === "string") {
              append(tp.content, cm.id, "assistant");
            }
          } else if (part.part_kind === "thinking") {
            const tp = part as ThinkingPart;
            if (typeof tp.content === "string") {
              append(tp.content, cm.id, "assistant");
            }
          }
        }
      }
    }
  }

  return {
    doc: {
      id: chat.id,
      title: chat.title || "Untitled",
      content: combined.join(" "),
    },
    map,
  };
}

function messageMatchesQuery(text: string, parsed: ParsedQuery): boolean {
  // A word typed with `~` matches a spelling the text has, not the one typed: only the index
  // knows which, and it has already placed the match in this message.
  if (parsed.required.some((term) => term.editDistance)) return true;

  const hay = text.toLowerCase();

  if (parsed.phrases.length > 0) {
    const phraseHit = parsed.phrases.some((p) => hay.includes(p));
    if (!phraseHit) return false;
  }

  if (parsed.terms.length > 0) {
    const termHit = parsed.terms.some((t) => {
      return hay.includes(t) || hay.split(/\W+/).some((token) => token.startsWith(t));
    });
    if (!termHit) return false;
  }

  return parsed.phrases.length > 0 || parsed.terms.length > 0;
}

// --- Segment Management (Identical to previous step) ---

function createNewSegment(id: string): Segment {
  const builder = createIndexBuilder();

  return {
    id,
    index: builder.build(),
    builder,
    docIds: new Set(),
    dirty: false,
    timestamp: Date.now(),
  };
}

/** Record that the segments written from now on are in the current format. */
async function writeIndexFormat(): Promise<void> {
  await db.lunrIndex.put({ id: FORMAT_RECORD_ID, format: INDEX_FORMAT_VERSION });
  storedFormat = INDEX_FORMAT_VERSION;
}

/** `writeIndexFormat` outside a rebuild: a failure only means the next start rebuilds once. */
async function stampIndexFormat(): Promise<void> {
  try {
    await writeIndexFormat();
  } catch (e) {
    log.warn("[SearchWorker] Could not record the index format version", e);
  }
}

async function loadSegments(): Promise<void> {
  try {
    const keys = await db.lunrIndex.toCollection().primaryKeys();

    if (keys.includes("main_index") && keys.length === 1) {
      log.warn("[SearchWorker] Legacy monolithic index found. Nuking to force segmented rebuild.");
      await db.lunrIndex.clear();
      await rebuildAll();
      return;
    }

    storedFormat = keys.includes(FORMAT_RECORD_ID)
      ? (await db.lunrIndex.get(FORMAT_RECORD_ID))?.format
      : undefined;

    const segmentKeys = keys.filter((k) => k.startsWith("segment_"));
    if (segmentKeys.length === 0) {
      log.info("[SearchWorker] No indices found. Starting fresh.");
      // Nothing is stored in an old format, so a first run needs no rebuild for it; a chat that
      // exists without an index is found by the count check.
      await stampIndexFormat();
      activeSegmentId = "segment_0";
      segments.set("segment_0", createNewSegment("segment_0"));
      return;
    }

    if (storedFormat !== INDEX_FORMAT_VERSION) {
      // The consistency check forces a rebuild for this, and the rebuild clears what is stored:
      // deserializing the segments and rehydrating the active one would only spend the time of
      // init's window on a large archive (HVN-71). Start empty; the format record is left as it
      // is, so the check still sees it stale.
      log.info(
        `[SearchWorker] ${segmentKeys.length} stored segments are in format ${storedFormat ?? "unrecorded"}, not ${INDEX_FORMAT_VERSION}. Not loading them; a rebuild replaces them.`,
      );
      activeSegmentId = "segment_0";
      segments.set("segment_0", createNewSegment("segment_0"));
      return;
    }

    log.info(`[SearchWorker] Loading ${segmentKeys.length} segments...`);

    for (const key of segmentKeys) {
      const record = await db.lunrIndex.get(key);
      if (record?.index) {
        const idx = lunr.Index.load(record.index as object);

        let recoveredIds: string[] = [];
        try {
          // @ts-expect-error
          recoveredIds = Object.keys(idx.documentStore?.docStore || {});
        } catch {
          /* ignore */
        }

        const metaIds = record.meta?.docIds;
        const finalIds = new Set<string>(metaIds || recoveredIds);

        segments.set(key, {
          id: key,
          index: idx,
          builder: undefined,
          docIds: finalIds,
          dirty: false,
          timestamp: Date.now(),
        });
      }
    }

    segmentKeys.sort();
    const lastKey = segmentKeys[segmentKeys.length - 1];

    const lastSeg = segments.get(lastKey);
    if (lastSeg && lastSeg.docIds.size < SEGMENT_SIZE) {
      log.info(
        `[SearchWorker] last segment ${lastKey} is not full (${lastSeg.docIds.size}). Rehydrating as active...`,
      );
      activeSegmentId = lastKey;
      await hydrateSegmentBuilder(lastSeg);
    } else {
      const nextId = `segment_${segmentKeys.length}`;
      log.info(`[SearchWorker] Creating new active segment: ${nextId}`);
      activeSegmentId = nextId;
      segments.set(nextId, createNewSegment(nextId));
    }
  } catch (err) {
    log.error("[SearchWorker] Error loading segments:", err);
    await db.lunrIndex.clear();
    await rebuildAll();
  }
}

/**
 * The chats the index is to hold: every one that is not soft-deleted. A rebuild leaves the
 * deleted ones out (they are gone for the user, and the Janitor removes them within the hour), so
 * the count the rebuild reports and the consistency check compares against is this one (HVN-74).
 */
async function countLiveChats(): Promise<number> {
  const [all, deleted] = await Promise.all([
    db.chats.count(),
    db.chats.where("deleted").equals(1).count(),
  ]);
  return all - deleted;
}

/**
 * Checks if the number of indexed documents matches the number of chats in the database.
 * If there is a mismatch, it triggers a rebuild.
 */
async function checkIndexConsistency(): Promise<void> {
  // A rebuild running is the cure this check would start; its segments are empty or part-built.
  if (rebuildRun) return;
  try {
    const actualChatCount = await countLiveChats();
    const indexedDocCount = Array.from(segments.values()).reduce(
      (sum, seg) => sum + seg.docIds.size,
      0,
    );

    log.info(
      `[SearchWorker] Consistency check: ${indexedDocCount} indexed docs, ${actualChatCount} chats in DB`,
    );

    // An index built before the current format holds terms the search no longer asks for (HVN-65)
    const formatStale = storedFormat !== INDEX_FORMAT_VERSION;
    if (formatStale) {
      log.warn(
        `[SearchWorker] Index format is ${storedFormat ?? "unrecorded"}, the current one is ${INDEX_FORMAT_VERSION}.`,
      );
    }

    // Missing docs, a stale format, or a rebuild that failed and left the index part-built:
    // rebuild in the background
    if (rebuildFailure !== null || formatStale || indexedDocCount < actualChatCount) {
      if (rebuildFailure !== null) {
        if (failureRetried) {
          log.warn(
            `[SearchWorker] Index is incomplete (${indexedDocCount}/${actualChatCount}); the retry after the last rebuild failure (${rebuildFailure}) was used. Not rebuilding again until the worker restarts or a rebuild is requested.`,
          );
          return;
        }
        failureRetried = true;
      }
      log.warn(
        `[SearchWorker] Index is incomplete or out of date (${indexedDocCount}/${actualChatCount}${
          formatStale ? ", format out of date" : ""
        }${
          rebuildFailure !== null ? `, last rebuild failed: ${rebuildFailure}` : ""
        }). Triggering self-healing rebuild...`,
      );
      // Fire and forget build to not block the init response (rebuildAll does not reject)
      void rebuildAll(true);
    }
  } catch (e) {
    log.error("[SearchWorker] Consistency check failed", e);
  }
}

async function hydrateSegmentBuilder(segment: Segment): Promise<void> {
  const ids = Array.from(segment.docIds);
  if (ids.length === 0) {
    const builder = createIndexBuilder();
    segment.builder = builder;
    segment.index = builder.build();
    return;
  }

  const chats = await attachMessages((await db.chats.bulkGet(ids)).filter((c): c is Chat => !!c));
  const builder = createIndexBuilder();

  for (const chat of chats) {
    const data = extractTextAndMap(chat);
    if (data) {
      builder.add(data.doc);
      docCache.set(data.doc.id, data.doc);
    }
  }
  segment.builder = builder;
  segment.index = builder.build();
}

/**
 * Index one chat, read from the database as it is now. The caller has written the row before it
 * asks (a save, a bulk sync's post-processing), and the worker makes the text itself, so a chat
 * added on its own is indexed exactly as a rebuild would index it (HVN-76). During a rebuild the
 * pass owns the segments (it replaces them and keeps its own handle on the one it fills), so an
 * add only records the chat; the pass indexes it before it ends, reading the row as it is then
 * (HVN-54).
 */
async function addToIndex(chatId: string): Promise<void> {
  if (rebuildRun) {
    addedDuringRebuild.add(chatId);
    return;
  }
  const chat = await loadChatWithMessages(chatId);
  const data = chat && extractTextAndMap(chat);
  // A rebuild that began while the chat was read has taken the segments; it reads this chat
  // from the database itself.
  if (rebuildRun) {
    addedDuringRebuild.add(chatId);
    return;
  }
  if (data) indexDocument(data.doc);
}

function indexDocument(doc: SearchDoc): void {
  let activeSeg = segments.get(activeSegmentId);
  if (!activeSeg) {
    activeSeg = createNewSegment(activeSegmentId);
    segments.set(activeSegmentId, activeSeg);
  }

  if (activeSeg.docIds.size >= SEGMENT_SIZE && !activeSeg.docIds.has(doc.id)) {
    log.info(`[SearchWorker] Segment ${activeSegmentId} full. Rotating...`);
    persistSegment(activeSeg);
    const nextId = `segment_${segments.size}`;
    activeSegmentId = nextId;
    activeSeg = createNewSegment(nextId);
    segments.set(nextId, activeSeg);
    docCache.clear();
  }

  if (!activeSeg.builder) {
    const builder = createIndexBuilder();
    activeSeg.builder = builder;
  }

  if (activeSeg.docIds.has(doc.id)) {
    docCache.set(doc.id, doc);
    activeSeg.dirty = true;
    scheduleDebouncedRebuild(activeSeg);
  } else {
    docCache.set(doc.id, doc);
    activeSeg.builder.add(doc);
    activeSeg.index = activeSeg.builder.build();
    activeSeg.docIds.add(doc.id);
    activeSeg.dirty = true;
    scheduleDebouncedRebuild(activeSeg);
  }
}

/** Rebuild the active segment from the document cache, in memory. */
function refreshActiveSegment(seg: Segment) {
  if (!seg.builder) return;
  const builder = createIndexBuilder();
  for (const doc of docCache.values()) {
    builder.add(doc);
  }
  seg.builder = builder;
  seg.index = builder.build();
  seg.dirty = false;
  log.info(`[SearchWorker] Rebuilt active segment ${seg.id} (${docCache.size} docs)`);
}

function rebuildActiveSegment(seg: Segment) {
  refreshActiveSegment(seg);
  if (seg.builder) persistSegment(seg);
}

const debounceTimers = new Map<string, number>();

function clearDebounceTimers() {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

function scheduleDebouncedRebuild(seg: Segment) {
  // A rebuild replaces every segment; a timer on an old one would persist it over the new ones.
  if (bulkMode || rebuildRun) return;
  if (debounceTimers.has(seg.id)) clearTimeout(debounceTimers.get(seg.id));
  const timer = setTimeout(() => {
    rebuildActiveSegment(seg);
    debounceTimers.delete(seg.id);
  }, REBUILD_DEBOUNCE_MS);
  debounceTimers.set(seg.id, timer);
}

/** Write a segment to storage; rejects when the write fails (a rebuild counts that as failing). */
async function writeSegment(seg: Segment) {
  if (!seg.index) return;
  await db.lunrIndex.put({
    id: seg.id,
    index: seg.index.toJSON(),
    meta: {
      docIds: Array.from(seg.docIds),
      timestamp: Date.now(),
    },
  });
  log.info(`[SearchWorker] Persisted segment ${seg.id}`);
}

/** Write a segment outside a rebuild: a failure is logged, the in-memory index stays whole. */
async function persistSegment(seg: Segment) {
  try {
    await writeSegment(seg);
  } catch (e) {
    log.error(`[SearchWorker] Failed to save segment ${seg.id}`, e);
  }
}

/**
 * Rebuild the whole index. Never rejects: the outcome says whether the last pass failed.
 * A request that arrives while a rebuild runs joins it and makes it run once more, so what it
 * was asked to include is read by a pass that starts after the request.
 */
function rebuildAll(emitProgress = false): Promise<RebuildOutcome> {
  if (rebuildRun) {
    log.warn("[SearchWorker] Rebuild already in progress; it will run again when it ends");
    rebuildAgain = true;
    return rebuildRun;
  }

  // Marked before the first await (the run is entered synchronously): from here until the run
  // ends the index is not searchable, and a search must say so instead of answering from a
  // half-built index.
  const run = (async (): Promise<RebuildOutcome> => {
    try {
      let outcome: RebuildOutcome;
      do {
        rebuildAgain = false;
        outcome = await rebuildPass(emitProgress);
      } while (rebuildAgain);
      return outcome;
    } finally {
      rebuildState = null;
      rebuildRun = null;
    }
  })();
  rebuildRun = run;
  return run;
}

/**
 * Index the chats an add named during the pass, from the database, into the segments the pass
 * has just built. An add can name a chat the pass had already read past (an update) or one it
 * will never read (written after it counted), so the pass cannot rely on its own reads. Adds
 * that arrive while this reads join the loop; the last check is synchronous, so none can slip
 * in between it and the end of the run.
 */
async function indexChatsAddedDuringRebuild(): Promise<void> {
  while (addedDuringRebuild.size > 0) {
    const ids = Array.from(addedDuringRebuild);
    addedDuringRebuild.clear();
    const chats = await attachMessages((await db.chats.bulkGet(ids)).filter((c): c is Chat => !!c));
    for (const chat of chats) {
      const data = extractTextAndMap(chat);
      if (data) indexDocument(data.doc);
    }
    // The debounce is off during a run, so rebuild the active segment and write it now: an
    // update of a chat it holds only changes the cache until then. A failed write fails the pass,
    // like the pass's own writes (HVN-50).
    const active = segments.get(activeSegmentId);
    if (active?.builder) {
      refreshActiveSegment(active);
      await writeSegment(active);
    }
  }
}

async function rebuildPass(emitProgress: boolean): Promise<RebuildOutcome> {
  rebuildFailure = null;
  clearDebounceTimers();

  const chunkSize = 1000; // Process 1000 chats per chunk
  rebuildState = {
    totalChats: 0,
    processedChats: 0,
    isRebuilding: true,
    chunkSize,
    currentChunk: 0,
  };

  segments.clear();
  docCache.clear();
  activeSegmentId = "segment_0";

  try {
    // Storage follows the pass: segments of the old index would otherwise outlive a failed pass
    // and make a restarted worker count a full index and skip the rebuild. A pass that dies
    // leaves a short index, which the next init rebuilds.
    storedFormat = undefined;
    await db.lunrIndex.clear();
    const count = await countLiveChats();
    log.info(`[SearchWorker] Starting FULL REBUILD of ${count} chats...`);

    rebuildState.totalChats = count;

    let currentSeg = createNewSegment("segment_0");
    segments.set("segment_0", currentSeg);
    let processed = 0;
    const FETCH_CHUNK = 50; // Fetch size per DB query

    // Page through the chats by key, not by position, until none is left: a row written or
    // deleted while the pass runs moves the positions after it, and a position-based page would
    // read one row twice or skip one (HVN-54). `count` only says how far the progress has to go.
    let lastKey: string | undefined;
    let exhausted = false;
    let chunkIdx = 0;

    // Process in large chunks with yielding
    while (!exhausted) {
      let chunkRead = 0;

      // Process this chunk
      while (chunkRead < chunkSize && !exhausted) {
        const limit = Math.min(FETCH_CHUNK, chunkSize - chunkRead);
        const page =
          lastKey === undefined ? db.chats.toCollection() : db.chats.where(":id").above(lastKey);
        const rows = await page.limit(limit).toArray();
        if (rows.length > 0) lastKey = rows[rows.length - 1].id;
        // A soft-deleted chat is paged past, not indexed: a search hides it anyway, and it is not
        // in the count (HVN-74).
        const chats = await attachMessages(rows.filter((row) => row.deleted !== 1));
        if (rows.length < limit) exhausted = true;
        chunkRead += rows.length;

        for (const chat of chats) {
          const data = extractTextAndMap(chat);
          if (data) {
            currentSeg.builder?.add(data.doc);
            currentSeg.docIds.add(data.doc.id);
            if (currentSeg.docIds.size >= SEGMENT_SIZE && currentSeg.builder) {
              currentSeg.index = currentSeg.builder.build();
              await writeSegment(currentSeg);
              currentSeg.builder = undefined;
              const nextId = `segment_${segments.size}`;
              currentSeg = createNewSegment(nextId);
              segments.set(nextId, currentSeg);
              activeSegmentId = nextId;
            }
          }
        }
        processed += chats.length;
        // A search asked mid-chunk reports these. Chats written after the count grow the total.
        rebuildState.processedChats = processed;
        rebuildState.totalChats = Math.max(count, processed);
      }

      if (chunkRead === 0) break; // the last page was the end of the previous chunk

      const total = rebuildState.totalChats;
      rebuildState.currentChunk = ++chunkIdx;

      // Send progress update
      const percentage = Math.round((processed / total) * 100);
      self.postMessage({
        type: "indexRebuildProgress",
        progress: {
          processed,
          total,
          percentage,
        },
      });

      if (emitProgress) {
        self.postMessage({ type: "initProgress", processed, total, phase: "indexing" });
      }

      // Yield to event loop to allow search requests to process
      await new Promise((r) => setTimeout(r, 0));
    }

    // Finalize last segment
    if (currentSeg.builder) {
      currentSeg.index = currentSeg.builder.build();
      await writeSegment(currentSeg);
      const lastIds = Array.from(currentSeg.docIds);
      if (lastIds.length > 0) {
        const chats = await attachMessages(
          (await db.chats.bulkGet(lastIds)).filter((c): c is Chat => !!c),
        );
        chats.forEach((c) => {
          const d = extractTextAndMap(c);
          if (d) docCache.set(d.doc.id, d.doc);
        });
      }
    }

    await indexChatsAddedDuringRebuild();
    // Last, so that a pass that dies on the way leaves no record and the next start rebuilds. A
    // failed write fails the pass, like a failed segment write.
    await writeIndexFormat();

    log.info("[SearchWorker] Full rebuild complete.");

    // Send completion event
    self.postMessage({
      type: "indexRebuildComplete",
      totalChats: count,
    });

    if (emitProgress) {
      self.postMessage({ type: "initProgress", processed: count, total: count, phase: "complete" });
    }
    failureRetried = false; // the next failure gets its retry
    return {};
  } catch (e) {
    log.error("[SearchWorker] Rebuild failed", e);
    // The segments were cleared at the start and are part-built now: say so until a rebuild succeeds.
    rebuildFailure = e instanceof Error ? e.message : String(e);
    // The archive's rebuild notice stops at its last percentage unless it is told the pass ended.
    self.postMessage({ type: "indexRebuildFailed", error: rebuildFailure });
    return { error: rebuildFailure };
  }
}

// --- Hydration & Snippet Logic ---

/**
 * Extracts raw positions from Lunr match data.
 * Returns sorted array of [start, length] tuples.
 */
function collectMatchPositions(matchData: LunrMatchData): [number, number][] {
  const positions: [number, number][] = [];
  if (!matchData || !matchData.metadata) return positions;

  // Lunr structure: metadata[term][field].position array
  Object.values(matchData.metadata).forEach((termData) => {
    if (termData.content?.position) {
      termData.content.position.forEach((pos: [number, number]) => {
        positions.push(pos); // [start, length]
      });
    }
  });

  // Sort by start index
  positions.sort((a, b) => a[0] - b[0]);
  return positions;
}

/**
 * Generates snippets by mapping positions to messages.
 */
function generateSnippets(
  chat: Chat,
  positions: [number, number][],
  snippetRadius: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  // The index keeps no full text, only the chat has it: re-run extractTextAndMap(chat), which is
  // deterministic, to get the doc's content.

  const extraction = extractTextAndMap(chat);
  if (!extraction) return [];

  const fullText = extraction.doc.content;
  const sourceMap = extraction.map; // [start, length, msgId, role]

  // One result per message. A message can have several parts (a prompt and a reply, two text
  // blocks), each with its own entry in the map: the result takes the part of the first hit and
  // marks the hits that fall in that part.
  const msgHits = new Map<string, { entry: SourceMapEntry; hits: TextRange[] }>();

  // The positions are in the lower-cased text; the source map and the snippet are in the text as
  // written, and the two differ in length for an "İ" (HVN-57).
  const toWritten = lowerCaseRangeMapper(fullText);

  for (const [lowerStart, lowerLen] of positions) {
    const { start: posStart, length: posLen } = toWritten
      ? toWritten({ start: lowerStart, length: lowerLen })
      : { start: lowerStart, length: lowerLen };
    const entry = sourceMap.find((m) => posStart >= m[0] && posStart < m[0] + m[1]);
    if (!entry) continue;
    const found = msgHits.get(entry[2]);
    if (found && found.entry !== entry) continue;
    const hit = { start: posStart - entry[0], length: posLen };
    if (found) found.hits.push(hit);
    else msgHits.set(entry[2], { entry, hits: [hit] });
  }

  for (const [msgId, { entry, hits }] of msgHits) {
    const [mStart, mLen, _id, role] = entry;
    const msgText = fullText.slice(mStart, mStart + mLen);
    const words = hits.map((hit) => trimToWord(msgText, hit));
    const snippet = buildSnippet(msgText, words, { radius: snippetRadius });

    results.push({
      chatId: chat.id || "",
      chatTitle: chat.title || "Untitled",
      source: chat.source,
      messageId: msgId,
      messageContent: msgText, // Full message content (might be large?)
      messageSnippet: snippet,
      messageRole: role,
      messageTimestamp: chat.timestamp, // Approximation
      model: chat.messages[msgId]?.model || undefined,
      params: chat.params,
    });
  }

  return results;
}

// --- Search Logic ---

// --- Phrase Search Helpers ---

function verifyPhrase(
  matchData: LunrMatchData,
  phraseTerms: string[],
  searchPipeline: lunr.Pipeline,
): boolean {
  // We mimic what a query term goes through: trim, drop stop words, then the index's pipeline

  const prePipeline = createQueryTermPipeline();

  const tokens = phraseTerms.map((t) => {
    // 1. Trimmer & StopWord
    // Lunr query tokenization lowercases input before pipelines run.
    // We must mirror that here, otherwise quoted terms with capitals
    // (e.g. "Fisherman") won't match lowercase matchData keys.
    let res = prePipeline.run([new lunr.Token(t.toLowerCase(), {})]);
    if (res.length === 0) return null; // Stop word identified

    // 2. Search Pipeline (Stemmer)
    res = searchPipeline.run(res);

    return res.length > 0 ? res[0].toString() : null;
  });

  // 2. Get all positions for each existing token
  // If a token is significant (not null) but missing from matchData, it's a fail
  // (though the main AND query should have filtered these out, we are safe)
  const positionsByIdx: ([number, number][] | null)[] = tokens.map((t) => {
    if (!t) return null; // Stop word
    // matchData keys are stemmed
    if (!matchData.metadata[t]) return [];
    // matchData positions: [[start, len], ...]
    return matchData.metadata[t].content?.position || [];
  });

  // 3. Recursive sequence finder
  const matchSequence = (tIdx: number, prevStart: number, prevLen: number): boolean => {
    // All terms matched
    if (tIdx >= positionsByIdx.length) return true;

    const positions = positionsByIdx[tIdx];

    // If current term is a stop word (gap), just move to next
    if (positions === null) {
      return matchSequence(tIdx + 1, prevStart, prevLen);
    }

    if (positions.length === 0) return false; // Required term missing

    // Check occurrences
    for (const [start, len] of positions) {
      // First term (or first real term after stop words at start) can be anywhere
      if (prevStart === -1) {
        if (matchSequence(tIdx + 1, start, len)) return true;
        continue;
      }

      // Check relation to previous term
      // We need to look back to find if there was a gap since the last distinct term.
      const isGap = tIdx > 0 && tokens[tIdx - 1] === null;

      if (isGap) {
        // Loose: just must be after
        if (start > prevStart + prevLen) {
          if (matchSequence(tIdx + 1, start, len)) return true;
        }
      } else {
        // Strict: Must be adjacent (+1 for space)
        if (start === prevStart + prevLen + 1) {
          if (matchSequence(tIdx + 1, start, len)) return true;
        }
      }
    }

    return false;
  };

  return matchSequence(0, -1, 0);
}

// --- performSearch ---

async function filterResultsByTextPhrases(
  results: LunrResult[],
  phraseConstraints: PhraseConstraint[],
): Promise<LunrResult[]> {
  if (results.length === 0 || phraseConstraints.length === 0) {
    return results;
  }

  const chatIds = Array.from(new Set(results.map((result) => result.ref)));
  const chats = await attachMessages(
    (await db.chats.bulkGet(chatIds)).filter((chat): chat is Chat => !!chat),
  );
  const searchableTextByChatId = new Map<string, string>();

  for (const chat of chats) {
    const data = extractTextAndMap(chat);
    if (!data) continue;
    searchableTextByChatId.set(data.doc.id, normalizeSearchText(data.doc.content));
  }

  return results.filter((result) => {
    const searchableText = searchableTextByChatId.get(result.ref);
    if (!searchableText) return false;

    return phraseConstraints.every((constraint) =>
      searchableText.includes(constraint.normalizedPhrase),
    );
  });
}

/**
 * Ids of the soft-deleted chats. The index keeps a chat until the Janitor hard-deletes it (up to
 * about 35 minutes after the delete), and a Lunr index cannot drop one document, so a search
 * leaves these out of what it returns. The database is the truth: a chat that is synced again
 * comes back to life without touching the index.
 */
async function softDeletedChatIds(): Promise<Set<string>> {
  const ids = await db.chats.where("deleted").equals(1).primaryKeys();
  return new Set(ids.map(String));
}

/**
 * Whether a chat is inside the date range and the category a search asked for. These run on each
 * chat before it counts toward the limit, so a filtered search is cut from the chats that pass,
 * not from all that matched (HVN-77). The date is the chat's, as it has always been for results.
 */
async function chatPassesFilters(chat: Chat, filters: SearchFilters): Promise<boolean> {
  if (!inDateRange(chat.timestamp, filters)) return false;
  if (needsCategory(filters) && chat.id) {
    return inCategory(await db.chatMetadata.get(chat.id), filters.category);
  }
  return true;
}

/**
 * The rebuild's progress while one is running, otherwise undefined. A rebuild empties the index
 * and refills it, so it cannot answer queries until it ends. Keeping the previous index to answer
 * from would double the index's memory for the length of the rebuild (HVN-40).
 */
function currentRebuildStatus(): SearchIndexRebuildStatus | undefined {
  if (!rebuildState?.isRebuilding) return undefined;
  const { processedChats: processed, totalChats: total } = rebuildState;
  return {
    processed,
    total,
    percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
  };
}

/**
 * Set on the last chunk of every search answered after a failed rebuild: the index is
 * part-built, so a short or empty answer may be missing chats.
 */
function currentIndexIncomplete(): { indexIncomplete: SearchIndexIncompleteStatus } | undefined {
  return rebuildFailure === null ? undefined : { indexIncomplete: { error: rebuildFailure } };
}

async function performSearch(
  parsed: ParsedQuery,
  hydrate: boolean = false,
  options: { exactTextFilter?: boolean } = {},
): Promise<string[] | LunrResult[]> {
  if (segments.size === 0) await loadSegments();

  // 1. What to ask the index for. The query text never reaches Lunr's own parser (HVN-78).
  const { clauses, hasPhrases, phraseConstraints } = buildQueryPlan(parsed);
  const metadataPhraseConstraints = phraseConstraints.filter(
    (constraint) => !constraint.requiresTextVerification,
  );
  const textPhraseConstraints = phraseConstraints.filter(
    (constraint) => constraint.requiresTextVerification,
  );

  if (clauses.length === 0) {
    return [];
  }

  const runSegmentSearch = (queryClauses: QueryClause[]): LunrResult[] => {
    const found: LunrResult[] = [];
    for (const [id, seg] of segments) {
      try {
        const results = seg.index.query((q) => applyClauses(q, queryClauses)) as LunrResult[];
        const filtered = hasPhrases
          ? results.filter((r) =>
              metadataPhraseConstraints.every((constraint) =>
                verifyPhrase(
                  r.matchData,
                  constraint.terms,
                  (seg.index as LunrIndexWithPipeline).pipeline,
                ),
              ),
            )
          : results;
        found.push(...filtered);
      } catch (e) {
        log.warn(`[SearchWorker] Error searching segment ${id}:`, e);
      }
    }
    return found;
  };

  // 2. Search (Get IDs and Metadata)
  let rawResults: LunrResult[] = runSegmentSearch(clauses);

  // Relaxed fallback: if strict query returns nothing, retry with prefix matching (OR semantics).
  if (rawResults.length === 0 && !hasPhrases) {
    const relaxed = buildRelaxedPlan(parsed);
    if (relaxed) {
      rawResults = runSegmentSearch(relaxed.clauses);
    }
  }

  // Deduplicate by ref (chatId) - keep highest score
  const uniqueMap = new Map<string, LunrResult>();
  for (const r of rawResults) {
    const existing = uniqueMap.get(r.ref);
    if (!existing || existing.score < r.score) {
      uniqueMap.set(r.ref, r);
    }
  }

  if (uniqueMap.size > 0) {
    for (const deletedId of await softDeletedChatIds()) uniqueMap.delete(deletedId);
  }

  let sortedResults = Array.from(uniqueMap.values()).sort((a, b) => b.score - a.score);

  const shouldApplyExactTextFilter = options.exactTextFilter ?? false;
  if (textPhraseConstraints.length > 0 && shouldApplyExactTextFilter) {
    sortedResults = await filterResultsByTextPhrases(sortedResults, textPhraseConstraints);
  }

  if (!hydrate) {
    return sortedResults.map((r) => r.ref);
  }

  // 3. Hydrate (Worker Side)
  // Return LunrResult objects for the handler to convert to SearchResult
  return sortedResults;
}

// --- Message Handling ---

self.onmessage = async (event: MessageEvent<SearchWorkerMessage>) => {
  const msg = event.data;

  try {
    if (msg.type === "init") {
      // Mid-rebuild the segments are the rebuild's own: loading the stored ones would replace
      // them, and the check would see an empty index and ask for another pass.
      if (!rebuildRun) await loadSegments();
      // The consistency check reads the chat count and, if the index is short or the last
      // rebuild failed, starts a rebuild (not awaited). Answer init after that, so a search
      // sent on the heels of it is told about the rebuild instead of searching a short index.
      await checkIndexConsistency();
      self.postMessage({ type: "initComplete", success: true });
      return;
    }

    if (msg.type === "add") {
      await addToIndex(msg.chatId);
      self.postMessage({ type: "addComplete", success: true });
      return;
    }

    if (msg.type === "search") {
      const rebuilding = currentRebuildStatus();
      if (rebuilding) {
        log.info("[SearchWorker] Search during rebuild: reporting the rebuild instead of results");
        self.postMessage({
          type: "searchResultChunk",
          requestId: msg.requestId,
          results: [],
          done: true,
          indexRebuilding: rebuilding,
        });
        return;
      }

      const incomplete = currentIndexIncomplete();
      const hydrate = msg.hydrate === true;
      const filterProvider =
        typeof msg.filterProvider === "string" ? msg.filterProvider : undefined;
      const snippetRadius =
        typeof msg.contextChars === "number" && msg.contextChars > 0
          ? Math.min(500, msg.contextChars)
          : SNIPPET_RADIUS;
      // The limit is a number of chats (HVN-77); a chat sends at most `passagesPerChat` passages.
      const maxChats = msg.maxChats && msg.maxChats > 0 ? msg.maxChats : DEFAULT_MAX_CHATS;
      const passagesPerChat =
        msg.passagesPerChat && msg.passagesPerChat > 0 ? msg.passagesPerChat : Infinity;
      const filters = msg.filters ?? {};
      const parsedQuery = parseSearchQuery(msg.query);
      if (parsedQuery.problem) {
        // Nothing to look for is not "no results": say why, so the caller can tell the reader.
        self.postMessage({
          type: "searchResultChunk",
          requestId: msg.requestId,
          results: [],
          done: true,
          queryProblem: parsedQuery.problem,
          ...incomplete,
        });
        return;
      }
      const needsExactPhraseHydration = queryNeedsExactPhrasePath(parsedQuery);

      const results = await performSearch(parsedQuery, hydrate, {
        exactTextFilter: !hydrate && needsExactPhraseHydration,
      });

      const CHUNK = hydrate ? 10 : 50; // Smaller chunks for hydrated data

      if (results.length === 0) {
        self.postMessage({
          type: "searchResultChunk",
          requestId: msg.requestId,
          results: [],
          done: true,
          ...incomplete,
        });
      } else {
        // Helper to send chunk. The last one says whether more chats matched than were sent.
        const sendChunk = (chunk: string[] | SearchResult[], done: boolean, wasLimited = false) => {
          self.postMessage({
            type: "searchResultChunk",
            requestId: msg.requestId,
            results: chunk,
            done,
            ...(done && hydrate ? { wasLimited } : {}),
            ...(done ? incomplete : {}),
          });
        };

        if (!hydrate) {
          // Legacy ID mode
          for (let i = 0; i < results.length; i += CHUNK) {
            const chunk = results.slice(i, i + CHUNK) as string[];
            sendChunk(chunk, i + CHUNK >= results.length);
            await new Promise((r) => setTimeout(r, 0));
          }
        } else {
          // Hydration Loop
          // 'results' is array of Lunr Result objects with matchData
          const lunrResults = results as LunrResult[];
          let currentChunk: SearchResult[] = [];
          let chatsSent = 0;
          let wasLimited = false;

          for (const r of lunrResults) {
            const chat = await loadChatWithMessages(r.ref);
            if (!chat) continue;
            if (filterProvider && filterProvider !== "all" && chat.source !== filterProvider) {
              continue;
            }
            if (!(await chatPassesFilters(chat, filters))) continue;

            const snippets = needsExactPhraseHydration
              ? buildSearchResultsForChat(chat, parsedQuery, { radius: snippetRadius })
              : generateSnippets(chat, collectMatchPositions(r.matchData), snippetRadius).filter(
                  (snippet) => messageMatchesQuery(snippet.messageContent, parsedQuery),
                );
            // A chat counts when it has a passage to show, so a chat after the limit that has
            // none is not "more results". The first one that has one is the proof there are more.
            if (snippets.length === 0) continue;
            if (chatsSent >= maxChats) {
              wasLimited = true;
              break;
            }

            currentChunk.push(...snippets.slice(0, passagesPerChat));
            chatsSent++;

            // Flush chunk
            if (currentChunk.length >= CHUNK) {
              sendChunk(currentChunk, false);
              currentChunk = [];
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          // Final chunk
          sendChunk(currentChunk, true, wasLimited);
        }
      }
      return;
    }

    if (msg.type === "rebuild") {
      const outcome = await rebuildAll(true); // emitProgress = true
      // Reusing bulkComplete for now as a generic completion signal
      self.postMessage(
        outcome.error === undefined
          ? { type: "bulkComplete", success: true }
          : { type: "bulkComplete", success: false, error: outcome.error },
      );
      return;
    }

    if (msg.type === "startBulk") {
      bulkMode = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      self.postMessage({ type: "bulkComplete", success: true });
    }

    if (msg.type === "endBulk") {
      bulkMode = false;
      const active = segments.get(activeSegmentId);
      if (active) await persistSegment(active);
      self.postMessage({ type: "bulkComplete", success: true });
    }

    if (msg.type === "remove" || msg.type === "removeMany") {
      self.postMessage({ type: "removeComplete", success: true });
    }
  } catch (e) {
    log.error("[SearchWorker] Message error:", e);
    const requestId = "requestId" in msg ? msg.requestId : undefined;
    self.postMessage({ type: "error", error: String(e), requestId });
  }
};
