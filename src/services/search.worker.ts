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
import type { SearchWorkerMessage } from "../types/workerMessages";
import { log } from "../utils/logger";
import { HaevnDatabase } from "./db";

// --- Configuration ---
const SEGMENT_SIZE = 200; // Chats per segment
const REBUILD_DEBOUNCE_MS = 2000;
const MAX_CONTENT_LENGTH = 100000; // Increased limit since we segment
const SNIPPET_RADIUS = 60; // Context characters around match

// --- Types ---

interface SearchDoc {
  id: string;
  title: string;
  content: string;
}

type ParsedQuery = {
  phrases: string[];
  terms: string[];
};

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
let _isIndexing = false;
const docCache: Map<string, SearchDoc> = new Map(); // Only for active segment
let bulkMode = false;
let rebuildState: IndexRebuildState | null = null;

// --- Helper: Text Extraction & Mapping ---

function extractTextAndMap(chat: Chat): { doc: SearchDoc; map: SourceMap } | null {
  if (!chat.id) return null;

  const combined: string[] = [];
  const map: SourceMap = [];
  let currentOffset = 0;

  const append = (text: string, msgId: string, role: "user" | "assistant") => {
    if (!text) return;
    const clean = text.replace(/\s+/g, " ");
    if (!clean) return;

    if (currentOffset >= MAX_CONTENT_LENGTH) return;

    const remaining = MAX_CONTENT_LENGTH - currentOffset;
    const finalTxt = clean.length > remaining ? clean.slice(0, remaining) : clean;

    combined.push(finalTxt);
    map.push([currentOffset, finalTxt.length, msgId, role]);

    currentOffset += finalTxt.length + 1;
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

function parseSearchQuery(query: string): ParsedQuery {
  const phrases: string[] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const remainderParts: string[] = [];

  match = quoteRegex.exec(query);
  while (match !== null) {
    const pre = query.slice(lastIndex, match.index).trim();
    if (pre) remainderParts.push(pre);

    const phrase = match[1].trim();
    if (phrase) phrases.push(phrase);
    lastIndex = quoteRegex.lastIndex;
    match = quoteRegex.exec(query);
  }

  const tail = query.slice(lastIndex).trim();
  if (tail) remainderParts.push(tail);

  const cleaned = remainderParts.join(" ").replace(/[+\-~*^:"()]/g, " ");
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const t of cleaned.split(/\s+/)) {
    const trimmed = t.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      terms.push(trimmed);
    }
  }

  return { phrases, terms };
}

function messageMatchesQuery(text: string, parsed: ParsedQuery): boolean {
  const hay = text.toLowerCase();

  if (parsed.phrases.length > 0) {
    const phraseHit = parsed.phrases.some((p) => hay.includes(p.toLowerCase()));
    if (!phraseHit) return false;
  }

  if (parsed.terms.length > 0) {
    const termHit = parsed.terms.some((t) => {
      const needle = t.toLowerCase();
      return hay.includes(needle) || hay.split(/\W+/).some((token) => token.startsWith(needle));
    });
    if (!termHit) return false;
  }

  return parsed.phrases.length > 0 || parsed.terms.length > 0;
}

// --- Segment Management (Identical to previous step) ---

function createNewSegment(id: string): Segment {
  const builder = new lunr.Builder();
  builder.ref("id");
  builder.field("title", { boost: 10 });
  builder.field("content");
  builder.metadataWhitelist = ["position"];

  return {
    id,
    index: builder.build(),
    builder,
    docIds: new Set(),
    dirty: false,
    timestamp: Date.now(),
  };
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

    const segmentKeys = keys.filter((k) => k.startsWith("segment_"));
    if (segmentKeys.length === 0) {
      log.info("[SearchWorker] No indices found. Starting fresh.");
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
 * Checks if the number of indexed documents matches the number of chats in the database.
 * If there is a mismatch, it triggers a rebuild.
 */
async function checkIndexConsistency(): Promise<void> {
  try {
    const actualChatCount = await db.chats.count();
    const indexedDocCount = Array.from(segments.values()).reduce(
      (sum, seg) => sum + seg.docIds.size,
      0,
    );

    log.info(
      `[SearchWorker] Consistency check: ${indexedDocCount} indexed docs, ${actualChatCount} chats in DB`,
    );

    // If more than 5% mismatch or any missing docs, trigger a background rebuild
    if (indexedDocCount < actualChatCount) {
      log.warn(
        `[SearchWorker] Index is incomplete (${indexedDocCount}/${actualChatCount}). Triggering self-healing rebuild...`,
      );
      // Fire and forget build to not block the init response
      rebuildAll(true).catch((e) => log.error("[SearchWorker] Background rebuild failed", e));
    }
  } catch (e) {
    log.error("[SearchWorker] Consistency check failed", e);
  }
}

async function hydrateSegmentBuilder(segment: Segment): Promise<void> {
  const ids = Array.from(segment.docIds);
  if (ids.length === 0) {
    const builder = new lunr.Builder();
    builder.ref("id");
    builder.field("title", { boost: 10 });
    builder.field("content");
    builder.metadataWhitelist = ["position"];
    segment.builder = builder;
    segment.index = builder.build();
    return;
  }

  const chats = await attachMessages((await db.chats.bulkGet(ids)).filter((c): c is Chat => !!c));
  const builder = new lunr.Builder();
  builder.ref("id");
  builder.field("title", { boost: 10 });
  builder.field("content");
  builder.metadataWhitelist = ["position"];

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

function addToIndex(doc: SearchDoc): void {
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
    const builder = new lunr.Builder();
    builder.ref("id");
    builder.field("title");
    builder.field("content");
    builder.metadataWhitelist = ["position"];
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

function rebuildActiveSegment(seg: Segment) {
  if (!seg.builder) return;
  const builder = new lunr.Builder();
  builder.ref("id");
  builder.field("title");
  builder.field("content");
  builder.metadataWhitelist = ["position"];
  for (const doc of docCache.values()) {
    builder.add(doc);
  }
  seg.builder = builder;
  seg.index = builder.build();
  seg.dirty = false;
  log.info(`[SearchWorker] Rebuilt active segment ${seg.id} (${docCache.size} docs)`);
  persistSegment(seg);
}

const debounceTimers = new Map<string, number>();

function scheduleDebouncedRebuild(seg: Segment) {
  if (bulkMode) return;
  if (debounceTimers.has(seg.id)) clearTimeout(debounceTimers.get(seg.id));
  const timer = setTimeout(() => {
    rebuildActiveSegment(seg);
    debounceTimers.delete(seg.id);
  }, REBUILD_DEBOUNCE_MS);
  // @ts-expect-error
  debounceTimers.set(seg.id, timer);
}

async function persistSegment(seg: Segment) {
  if (!seg.index) return;
  try {
    await db.lunrIndex.put({
      id: seg.id,
      index: seg.index.toJSON(),
      meta: {
        docIds: Array.from(seg.docIds),
        timestamp: Date.now(),
      },
    });
    log.info(`[SearchWorker] Persisted segment ${seg.id}`);
  } catch (e) {
    log.error(`[SearchWorker] Failed to save segment ${seg.id}`, e);
  }
}

async function rebuildAll(emitProgress = false) {
  // Check if rebuild is already in progress
  if (rebuildState?.isRebuilding) {
    log.warn("[SearchWorker] Rebuild already in progress");
    return;
  }

  _isIndexing = true;
  segments.clear();
  docCache.clear();
  activeSegmentId = "segment_0";

  try {
    const count = await db.chats.count();
    log.info(`[SearchWorker] Starting FULL REBUILD of ${count} chats...`);

    // Initialize rebuild state for chunked processing
    const chunkSize = 1000; // Process 1000 chats per chunk
    const totalChunks = Math.ceil(count / chunkSize);

    rebuildState = {
      totalChats: count,
      processedChats: 0,
      isRebuilding: true,
      chunkSize,
      currentChunk: 0,
    };

    let currentSeg = createNewSegment("segment_0");
    segments.set("segment_0", currentSeg);
    let processed = 0;
    const FETCH_CHUNK = 50; // Fetch size per DB query

    // Process in large chunks with yielding
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunkStart = chunkIdx * chunkSize;
      const chunkEnd = Math.min(chunkStart + chunkSize, count);

      // Process this chunk
      for (let offset = chunkStart; offset < chunkEnd; offset += FETCH_CHUNK) {
        const limit = Math.min(FETCH_CHUNK, chunkEnd - offset);
        const chats = await attachMessages(await db.chats.offset(offset).limit(limit).toArray());

        for (const chat of chats) {
          const data = extractTextAndMap(chat);
          if (data) {
            currentSeg.builder?.add(data.doc);
            currentSeg.docIds.add(data.doc.id);
            if (currentSeg.docIds.size >= SEGMENT_SIZE) {
              currentSeg.index = currentSeg.builder?.build();
              await persistSegment(currentSeg);
              currentSeg.builder = undefined;
              const nextId = `segment_${segments.size}`;
              currentSeg = createNewSegment(nextId);
              segments.set(nextId, currentSeg);
              activeSegmentId = nextId;
            }
          }
        }
        processed += chats.length;
      }

      // Update rebuild state
      rebuildState.processedChats = processed;
      rebuildState.currentChunk = chunkIdx + 1;

      // Send progress update
      const percentage = Math.round((processed / count) * 100);
      self.postMessage({
        type: "indexRebuildProgress",
        progress: {
          processed,
          total: count,
          percentage,
        },
      });

      if (emitProgress) {
        self.postMessage({ type: "initProgress", processed, total: count, phase: "indexing" });
      }

      // Yield to event loop to allow search requests to process
      await new Promise((r) => setTimeout(r, 0));
    }

    // Finalize last segment
    if (currentSeg.builder) {
      currentSeg.index = currentSeg.builder.build();
      await persistSegment(currentSeg);
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

    log.info("[SearchWorker] Full rebuild complete.");

    // Send completion event
    self.postMessage({
      type: "indexRebuildComplete",
      totalChats: count,
    });

    if (emitProgress) {
      self.postMessage({ type: "initProgress", processed: count, total: count, phase: "complete" });
    }
  } catch (e) {
    log.error("[SearchWorker] Rebuild failed", e);
  } finally {
    _isIndexing = false;
    rebuildState = null;
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
  map: SourceMap,
  positions: [number, number][],
  snippetRadius: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  const _text = map.map((_m) => "").join(""); // Wait, we don't have the full text here?
  // We didn't store the full text in memory. We only have the chat.
  // We need to re-extract the text segments from the Chat using the map indices?
  // Actually, simpler: We re-run extractTextAndMap(chat) which gives us the 'doc' with full content.
  // Optimization: extractTextAndMap is deterministic.

  const extraction = extractTextAndMap(chat);
  if (!extraction) return [];

  const fullText = extraction.doc.content;
  const sourceMap = extraction.map; // [start, length, msgId, role]

  // Group positions by message to avoid duplicates
  // Map<msgId, Set<positionIndex>>
  const msgHits = new Map<string, [number, number][]>();

  for (const [posStart, posLen] of positions) {
    // Find which message this position falls into
    // Binary search is better, but linear scan of map is fine for <50 items
    const entry = sourceMap.find((m) => posStart >= m[0] && posStart < m[0] + m[1]);

    if (entry) {
      const [_mStart, _mLen, mId, _mRole] = entry;
      if (!msgHits.has(mId)) msgHits.set(mId, []);
      msgHits.get(mId)?.push([posStart, posLen]);
    }
  }

  // Generate one result per matching message
  for (const [msgId, hits] of msgHits) {
    // Find map entry for this message
    const entry = sourceMap.find((m) => m[2] === msgId);
    if (!entry) continue;

    const [mStart, mLen, _id, role] = entry;
    const msgText = fullText.slice(mStart, mStart + mLen);

    // Use the first hit to generate the snippet center
    // Relative to message start
    const firstHit = hits[0];
    const hitRelativeStart = firstHit[0] - mStart;

    // Simple snippet generation
    // TODO: Support multiple hits in one snippet or highlighting
    const start = Math.max(0, hitRelativeStart - snippetRadius);
    const end = Math.min(msgText.length, hitRelativeStart + firstHit[1] + snippetRadius);

    let snippet = msgText.slice(start, end);

    // Add Highlights
    // We need to adjust all hits to be relative to the snippet start
    // This is complex for a regex-free approach, but let's try a simple approach:
    // Just mark the specific hit we focused on? No, user wants all highlights.

    // Re-construct snippet with markers
    // This is getting complicated to do perfectly without regex.
    // Let's stick to the main hit for now to ensure stability.
    // Or, since we have the EXACT offsets, we can insert strings.

    // Let's just return the raw snippet for Phase 2.
    // We can use a client-side highlighter (Mark.js) on the snippet if we return the query terms.
    // OR we return {{HIGHLIGHT}}...

    // For now, let's just extract the raw text around the first match.
    snippet = `...${snippet}...`;

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
  // We mimic the Indexing Pipeline: Trimmer -> StopWord -> SearchPipeline (Stemmer)

  const prePipeline = new lunr.Pipeline();
  prePipeline.add(lunr.trimmer, lunr.stopWordFilter);

  const tokens = phraseTerms.map((t) => {
    // 1. Trimmer & StopWord
    let res = prePipeline.run([new lunr.Token(t)]);
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

async function performSearch(
  query: string,
  hydrate: boolean = false,
): Promise<string[] | LunrResult[]> {
  if (!query) return [];

  // Check if rebuild is in progress
  if (rebuildState?.isRebuilding) {
    log.info("[SearchWorker] Search during rebuild, returning empty with status");

    // Send rebuild status to caller
    self.postMessage({
      type: "searchDuringRebuild",
      rebuildProgress: {
        processed: rebuildState.processedChats,
        total: rebuildState.totalChats,
        percentage: Math.round((rebuildState.processedChats / rebuildState.totalChats) * 100),
      },
    });

    // Return empty results - caller can implement fallback if needed
    return [];
  }

  if (segments.size === 0) await loadSegments();

  // 1. Parse Query for Phrases
  let finalQuery = query;
  const phraseConstraints: string[][] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  const parts: string[] = [];
  let lastIndex = 0;
  let hasPhrases = false;

  // Pipeline for filtering stop words from the query string construction
  // (We don't want to add +of to the Lunr query if 'of' is not in the index)
  const stopWordPipeline = new lunr.Pipeline();
  stopWordPipeline.add(lunr.trimmer, lunr.stopWordFilter);

  // Clone query to avoid infinite loop with exec
  match = quoteRegex.exec(query);
  while (match !== null) {
    hasPhrases = true;
    // Text before quote
    const pre = query.slice(lastIndex, match.index).trim();
    if (pre) parts.push(pre);

    const phrase = match[1].trim();
    if (phrase) {
      const terms = phrase.split(/\s+/);
      phraseConstraints.push(terms); // Keep raw terms for gap check

      // Filter stop words for the mandatory query terms
      const filteredTerms = terms.filter((t) => {
        const res = stopWordPipeline.run([new lunr.Token(t)]);
        return res.length > 0;
      });

      if (filteredTerms.length > 0) {
        // Convert to strict AND query terms
        parts.push(filteredTerms.map((t) => `+${t}`).join(" "));
      }
    }
    lastIndex = quoteRegex.lastIndex;
    match = quoteRegex.exec(query);
  }
  const remainder = query.slice(lastIndex).trim();
  if (remainder) parts.push(remainder);

  if (hasPhrases) {
    finalQuery = parts.join(" ");
  } else if (!/[+\-~*^"]/.test(query)) {
    // No operators or quotes — default to AND
    finalQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `+${t}`)
      .join(" ");
  }

  const runSegmentSearch = (queryText: string): LunrResult[] => {
    const found: LunrResult[] = [];
    for (const [id, seg] of segments) {
      try {
        const results = seg.index.search(queryText) as LunrResult[];
        const filtered = hasPhrases
          ? results.filter((r) =>
              phraseConstraints.every((p) =>
                verifyPhrase(r.matchData, p, (seg.index as LunrIndexWithPipeline).pipeline),
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
  let rawResults: LunrResult[] = runSegmentSearch(finalQuery);

  // Relaxed fallback: if strict query returns nothing, retry with prefix matching (OR semantics).
  if (rawResults.length === 0 && !hasPhrases) {
    const relaxedTerms = query
      .split(/\s+/)
      .map((t) => t.trim().replace(/[+\-~*^:"()]/g, ""))
      .filter((t) => t.length >= 3)
      .map((t) => `${t.toLowerCase()}*`);
    if (relaxedTerms.length > 0) {
      rawResults = runSegmentSearch(relaxedTerms.join(" "));
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

  const sortedResults = Array.from(uniqueMap.values()).sort((a, b) => b.score - a.score);

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
      await loadSegments();
      // Perform background consistency check
      checkIndexConsistency();
      self.postMessage({ type: "initComplete", success: true });
      return;
    }

    if (msg.type === "add") {
      if (msg.doc) addToIndex(msg.doc);
      self.postMessage({ type: "addComplete", success: true });
      return;
    }

    if (msg.type === "search") {
      const hydrate = msg.hydrate === true;
      const filterProvider =
        typeof msg.filterProvider === "string" ? msg.filterProvider : undefined;
      const snippetRadius =
        typeof msg.contextChars === "number" && msg.contextChars > 0
          ? Math.min(500, msg.contextChars)
          : SNIPPET_RADIUS;
      // maxResults is used to limit total hydration
      const maxResults = msg.maxResults || 1000;
      const parsedQuery = parseSearchQuery(msg.query);

      const results = await performSearch(msg.query, hydrate);

      const CHUNK = hydrate ? 10 : 50; // Smaller chunks for hydrated data

      if (results.length === 0) {
        self.postMessage({
          type: "searchResultChunk",
          requestId: msg.requestId,
          results: [],
          done: true,
        });
      } else {
        let sentCount = 0;

        // Helper to send chunk
        const sendChunk = (chunk: string[] | SearchResult[], done: boolean) => {
          self.postMessage({
            type: "searchResultChunk",
            requestId: msg.requestId,
            results: chunk,
            done,
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

          for (let i = 0; i < lunrResults.length; i++) {
            if (sentCount >= maxResults) break;

            const r = lunrResults[i];
            const chatId = r.ref;

            // 1. Fetch Chat
            const chat = await loadChatWithMessages(chatId);
            if (chat) {
              if (filterProvider && filterProvider !== "all" && chat.source !== filterProvider) {
                continue;
              }
              // 2. Extract Positions
              const positions = collectMatchPositions(r.matchData);
              // 3. Generate Snippets
              // Optimization: Pre-calculate map if possible, but extractTextAndMap is fast
              const snippets = generateSnippets(chat, [], positions, snippetRadius); // Pass empty map, function generates it

              const filteredSnippets = snippets.filter((snippet) =>
                messageMatchesQuery(snippet.messageContent, parsedQuery),
              );

              currentChunk.push(...filteredSnippets);
              sentCount += filteredSnippets.length; // Count actual results (snippets)
            }

            // Flush chunk
            if (currentChunk.length >= CHUNK) {
              sendChunk(currentChunk, false);
              currentChunk = [];
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          // Final chunk
          sendChunk(currentChunk, true);
        }
      }
      return;
    }

    if (msg.type === "rebuild") {
      await rebuildAll(true); // emitProgress = true
      self.postMessage({ type: "bulkComplete", success: true }); // Reusing bulkComplete for now as a generic completion signal
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
