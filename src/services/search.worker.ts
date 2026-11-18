// Search Worker: the full-text index (SQLite FTS5 behind `SearchIndex`), its rebuilds and its queries
import type { Chat, ChatMessage, SearchResult } from "../model/haevn_model";
import type {
  SearchFilters,
  SearchIndexIncompleteStatus,
  SearchIndexRebuildStatus,
  SearchWorkerMessage,
} from "../types/workerMessages";
import { log } from "../utils/logger";
import { HaevnDatabase } from "./db";
import { extractIndexedChat } from "./searchDocument";
import { inCategory, needsCategory } from "./searchFilters";
import {
  createSearchIndex,
  type IndexBuild,
  type IndexFilters,
  type MarkedPassage,
  type RankedChat,
  type SearchIndex,
} from "./searchIndex";
import { type ParsedQuery, parseSearchQuery } from "./searchQuery";
import { buildSnippet } from "./searchSnippet";
import { buildQueryPlan, buildRelaxedPlan, type QueryPlan } from "./searchWorkerQuery";

// --- Configuration ---
const SNIPPET_RADIUS = 60; // Context characters around match
const DEFAULT_MAX_CHATS = 1000; // Chats a hydrated search returns when the caller names no limit
const CATCH_UP_MARGIN_MS = 1000; // Clock slack when a bulk operation's chats are found by their save time

interface IndexRebuildState {
  totalChats: number;
  processedChats: number;
  isRebuilding: boolean;
  chunkSize: number;
  currentChunk: number;
}

const db = new HaevnDatabase();

function toMessageDict(rows: ChatMessage[]): Record<string, ChatMessage> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/**
 * The chats with their messages from the `chatMessages` table. A row's own `messages` is never
 * read: a chat with none in the table has none (HVN-31).
 */
async function attachMessages(chats: Chat[]): Promise<Chat[]> {
  const chatIds = chats.map((chat) => chat.id).filter((id): id is string => !!id);
  if (chatIds.length === 0) return chats.map((chat) => ({ ...chat, messages: {} }));

  const rows = await db.chatMessages.where("chatId").anyOf(chatIds).toArray();
  const byChatId = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    const current = byChatId.get(row.chatId);
    if (current) {
      current.push(row);
    } else {
      byChatId.set(row.chatId, [row]);
    }
  }

  return chats.map((chat) => ({
    ...chat,
    messages: toMessageDict(chat.id ? (byChatId.get(chat.id) ?? []) : []),
  }));
}

/** The chat row, with its messages from the `chatMessages` table (see attachMessages). */
async function attachMessageRows(chat: Chat): Promise<Chat> {
  const rows = await db.chatMessages
    .where("chatId")
    .equals(chat.id as string)
    .toArray();
  return { ...chat, messages: toMessageDict(rows) };
}

async function loadChatWithMessages(chatId: string): Promise<Chat | undefined> {
  const chat = await db.chats.get(chatId);
  return chat ? attachMessageRows(chat) : undefined;
}

// --- Global State ---

/** The index, once it has been opened; undefined until then and when it cannot be opened. */
let index: SearchIndex | undefined;
/** The open in flight, so that two callers wait for one. */
let opening: Promise<void> | undefined;
/** Why the index could not be opened, when it could not; search says so until an open works. */
let openFailure: string | null = null;
/**
 * Whether the index has a finished file to answer from. A first run, an index of another format
 * and an unfinished rebuild have none, and a search says the index is being rebuilt.
 */
let hasLiveIndex = false;
/** When the bulk operation that is running began; null when none is. */
let bulkSince: number | null = null;
let rebuildState: IndexRebuildState | null = null;
// The run that is rebuilding now (every pass of it), so a second request can join it.
let rebuildRun: Promise<RebuildOutcome> | null = null;
// Set by a request that arrives during a run: the run goes once more, so chats written after
// the running pass read its `count()` are indexed (HVN-50).
let rebuildAgain = false;
// Chats an `add` or a `remove` named while a pass ran (HVN-54). The pass writes a file of its own;
// it brings these up to date from the database before it ends, so what happened behind its cursor
// is in the new index too.
const touchedDuringRebuild = new Set<string>();
// Set when the last rebuild pass failed; the index may be missing chats until a rebuild succeeds.
let rebuildFailure: string | null = null;
// A failed pass is retried by `init` once per worker lifetime, so a failure that never goes away
// costs one more full read per browser session, not one per service worker wake.
let failureRetried = false;

interface RebuildOutcome {
  /** Why the last pass failed; absent when it succeeded. */
  error?: string;
}

// --- The index: opening it ---

/**
 * Open the index (once; the open that is in flight is shared). A failure is kept as the reason a
 * search gives (`indexIncomplete`); the open itself has already been tried a second time, so a
 * handle that a worker from before an extension reload still held has had its pause.
 */
async function openIndex(): Promise<void> {
  if (index) return;
  opening ??= (async () => {
    const next = createSearchIndex();
    try {
      hasLiveIndex = await next.open();
      index = next;
      openFailure = null;
      log.info(
        `[SearchWorker] ${next.describe()} opened: ${
          hasLiveIndex ? `${next.chats()} chats indexed` : "no index to read yet"
        }`,
      );
    } catch (e) {
      openFailure = e instanceof Error ? e.message : String(e);
      log.error("[SearchWorker] The search index could not be opened", e);
    }
  })().finally(() => {
    opening = undefined;
  });
  await opening;
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
 * Checks that the index can answer: it has a finished file, and it holds as many chats as the
 * database has. If not, it triggers a rebuild; an archive with no chats needs none, only an empty
 * index.
 */
async function checkIndexConsistency(): Promise<void> {
  // A rebuild running is the cure this check would start.
  if (rebuildRun) return;
  if (!index) {
    log.warn(`[SearchWorker] No index to check: ${openFailure ?? "it is not open"}`);
    return;
  }
  try {
    const actualChatCount = await countLiveChats();
    const indexedDocCount = index.chats();

    log.info(
      `[SearchWorker] Consistency check: ${indexedDocCount} indexed docs, ${actualChatCount} chats in DB`,
    );

    if (!hasLiveIndex && actualChatCount === 0 && rebuildFailure === null) {
      // A first run on an empty archive: an empty index in the current format, so that the chats
      // that arrive are indexed one by one and the next start has nothing to rebuild.
      index.beginRebuild().commit();
      hasLiveIndex = true;
      return;
    }

    // No index of the current format, missing docs, or a rebuild that failed: rebuild in the
    // background
    if (rebuildFailure !== null || !hasLiveIndex || indexedDocCount < actualChatCount) {
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
          hasLiveIndex ? "" : ", no index of the current format"
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

// --- Writing to the index ---

/**
 * Index one chat, read from the database as it is now. The caller has written the row before it
 * asks (a save, a bulk sync's post-processing), and the worker makes the text itself, so a chat
 * added on its own is indexed exactly as a rebuild would index it (HVN-76). During a rebuild the
 * index that answers is the old one, which is written too, and the chat is noted for the new file,
 * which the pass brings up to date before it ends (HVN-54).
 */
async function addToIndex(chatId: string): Promise<void> {
  if (rebuildRun) touchedDuringRebuild.add(chatId);
  if (!index || !hasLiveIndex) return;
  const chat = await loadChatWithMessages(chatId);
  // A rebuild that began while the chat was read reads this chat from the database itself, but
  // may already have gone past it.
  if (rebuildRun) touchedDuringRebuild.add(chatId);
  const data = chat && extractIndexedChat(chat);
  if (!index || !hasLiveIndex) return;
  if (data) index.put(data);
  else index.remove(chatId);
}

function removeFromIndex(chatIds: string[]): void {
  if (rebuildRun) for (const id of chatIds) touchedDuringRebuild.add(id);
  if (!index || !hasLiveIndex) return;
  const live = index;
  live.transaction(() => {
    for (const id of chatIds) live.remove(id);
  });
}

/**
 * Bring the chats a bulk operation saved into the index: the ones saved since it began, found by
 * their save time. The bulk paths save without indexing, and this takes the place of the full
 * rebuild that used to close them.
 */
async function catchUpSince(since: number): Promise<void> {
  if (!index || !hasLiveIndex) return;
  if (rebuildRun) {
    // The pass may have read these chats before they were saved: it goes once more.
    await rebuildAll(false);
    return;
  }
  try {
    const keys = await db.chats.where("lastSyncedTimestamp").aboveOrEqual(since).primaryKeys();
    const ids = keys.map(String);
    log.info(`[SearchWorker] Catching up ${ids.length} chats saved by the bulk operation`);
    for (let at = 0; at < ids.length; at += 50) {
      const rows = (await db.chats.bulkGet(ids.slice(at, at + 50))).filter(
        (chat): chat is Chat => !!chat && chat.deleted !== 1,
      );
      const chats = await attachMessages(rows);
      if (!index || !hasLiveIndex) return;
      const live = index;
      live.transaction(() => {
        for (const chat of chats) {
          const data = extractIndexedChat(chat);
          if (data) live.put(data);
        }
      });
    }
  } catch (e) {
    log.error("[SearchWorker] Catching up after a bulk operation failed", e);
    rebuildFailure = e instanceof Error ? e.message : String(e);
  }
}

// --- Rebuild ---

/**
 * Rebuild the whole index into a new file, and make it the index when it is whole. Never rejects:
 * the outcome says whether the last pass failed. A request that arrives while a rebuild runs joins
 * it and makes it run once more, so what it was asked to include is read by a pass that starts
 * after the request.
 */
function rebuildAll(emitProgress = false): Promise<RebuildOutcome> {
  if (rebuildRun) {
    log.warn("[SearchWorker] Rebuild already in progress; it will run again when it ends");
    rebuildAgain = true;
    return rebuildRun;
  }

  // Marked before the first await (the run is entered synchronously): from here until the run
  // ends a search with no old index to answer from has to say so instead of answering from nothing.
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
 * Bring the new file up to date for the chats an add or a remove named during the pass, from the
 * database. An add can name a chat the pass had already read past (an update) or one it will never
 * read (written after it counted), and a remove a chat it had already indexed, so the pass cannot
 * rely on its own reads. Adds that arrive while this reads join the loop; the last check is
 * synchronous, so none can slip in between it and the end of the run.
 */
async function reconcileTouched(build: IndexBuild): Promise<void> {
  while (touchedDuringRebuild.size > 0) {
    const ids = Array.from(touchedDuringRebuild);
    touchedDuringRebuild.clear();
    const rows = await db.chats.bulkGet(ids);
    const chats = await attachMessages(rows.filter((c): c is Chat => !!c && c.deleted !== 1));
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    build.transaction(() => {
      for (const id of ids) {
        const chat = byId.get(id);
        const data = chat && extractIndexedChat(chat);
        if (data) build.put(data);
        else build.remove(id);
      }
    });
  }
}

async function rebuildPass(emitProgress: boolean): Promise<RebuildOutcome> {
  rebuildFailure = null;

  const chunkSize = 1000; // Process 1000 chats per chunk
  rebuildState = {
    totalChats: 0,
    processedChats: 0,
    isRebuilding: true,
    chunkSize,
    currentChunk: 0,
  };

  let build: IndexBuild | undefined;
  try {
    // The file is written beside the one that answers, and replaces it at the end; a pass that
    // dies leaves the old one, and a file that was never finished is never read.
    await openIndex();
    if (!index) throw new Error(openFailure ?? "The search index could not be opened");
    const written = index.beginRebuild();
    build = written;
    touchedDuringRebuild.clear();
    const count = await countLiveChats();
    log.info(`[SearchWorker] Starting FULL REBUILD of ${count} chats...`);

    rebuildState.totalChats = count;

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

        written.transaction(() => {
          for (const chat of chats) {
            const data = extractIndexedChat(chat);
            if (data) written.put(data);
          }
        });
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

    await reconcileTouched(written);
    // The swap: the new file is the index from here, and the old one is gone. A failed write
    // before this fails the pass, and the old index keeps answering.
    written.commit();
    build = undefined;
    // Ready from the swap on: an add that arrives from here goes into the new file, and nothing
    // awaits between the flag and the completion message.
    hasLiveIndex = true;

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
    // Last, and after the index answers: clearing the old rows takes seconds at a big archive.
    await freeLunrRows();
    return {};
  } catch (e) {
    log.error("[SearchWorker] Rebuild failed", e);
    try {
      build?.discard();
    } catch (discardError) {
      log.warn("[SearchWorker] Could not discard the file of the failed rebuild", discardError);
    }
    // The file that was being written is gone; what answers is what answered before, which may
    // be missing chats. Say so until a rebuild succeeds.
    rebuildFailure = e instanceof Error ? e.message : String(e);
    // The archive's rebuild notice stops at its last percentage unless it is told the pass ended.
    self.postMessage({ type: "indexRebuildFailed", error: rebuildFailure });
    return { error: rebuildFailure };
  }
}

/**
 * The index lived in the `lunrIndex` table before SQLite. Once the first good file exists those
 * rows are dead weight (148 MB at αιamblichus's size); the table itself goes in a later schema
 * version. A failure to clear it costs space only.
 */
async function freeLunrRows(): Promise<void> {
  try {
    await db.lunrIndex.clear();
  } catch (e) {
    log.warn("[SearchWorker] Could not clear the old Lunr index rows", e);
  }
}

// --- Search Logic ---

/**
 * Ids of the soft-deleted chats. The index keeps a chat until the Janitor hard-deletes it (up to
 * about 35 minutes after the delete), so a search leaves these out of what it returns. The database
 * is the truth: a chat that is synced again comes back to life without touching the index.
 */
async function softDeletedChatIds(): Promise<Set<string>> {
  const ids = await db.chats.where("deleted").equals(1).primaryKeys();
  return new Set(ids.map(String));
}

/**
 * Whether a chat is in the category a search asked for. The date range and the source are cut in
 * the index, and the category lives in the metadata table, which the index does not know; this
 * runs on each chat before it counts toward the limit, so a filtered search is cut from the chats
 * that pass, not from all that matched (HVN-77).
 */
async function chatPassesCategory(chat: Chat, filters: SearchFilters): Promise<boolean> {
  if (needsCategory(filters) && chat.id) {
    return inCategory(await db.chatMetadata.get(chat.id), filters.category);
  }
  return true;
}

/**
 * The rebuild's progress while a search cannot be answered because of it: a rebuild runs and
 * there is no earlier index to answer from. A rebuild into a new file does not stop search when
 * the old file is there (HVN-87).
 */
function currentRebuildStatus(): SearchIndexRebuildStatus | undefined {
  if (!rebuildState?.isRebuilding || hasLiveIndex) return undefined;
  const { processedChats: processed, totalChats: total } = rebuildState;
  return {
    processed,
    total,
    percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
  };
}

/**
 * Set on the last chunk of every search answered after a failed rebuild, and when the index cannot
 * be opened: the answer may be missing chats.
 */
function currentIndexIncomplete(): { indexIncomplete: SearchIndexIncompleteStatus } | undefined {
  const error = rebuildFailure ?? openFailure;
  return error === null ? undefined : { indexIncomplete: { error } };
}

/** The chats a query matches, best first, and the plan that found them (for the passages). */
async function performSearch(
  parsed: ParsedQuery,
  filters: IndexFilters,
): Promise<{ chats: RankedChat[]; plan: QueryPlan }> {
  const plan = buildQueryPlan(parsed);
  if (!index && !openFailure) await openIndex();
  if (!index || !hasLiveIndex || plan.clauses.length === 0) return { chats: [], plan };

  // What to ask the index for: the query text never reaches it as typed (HVN-78).
  let used = plan;
  let chats = index.search(plan, filters);

  // Relaxed fallback: if strict query returns nothing, retry with prefix matching (OR semantics).
  if (chats.length === 0) {
    const relaxed = buildRelaxedPlan(parsed);
    if (relaxed) {
      used = relaxed;
      chats = index.search(relaxed, filters);
    }
  }

  if (chats.length > 0) {
    const deleted = await softDeletedChatIds();
    if (deleted.size > 0) chats = chats.filter((chat) => !deleted.has(chat.chatId));
  }
  return { chats, plan: used };
}

/** The passages of one chat, as the results a caller shows. */
function resultsOf(chat: Chat, found: MarkedPassage[], radius: number): SearchResult[] {
  return found.map((passage) => ({
    chatId: chat.id as string,
    chatTitle: chat.title || "Untitled",
    source: chat.source,
    messageId: passage.messageId,
    messageContent: passage.text,
    messageSnippet: buildSnippet(passage.text, passage.marks, { radius }),
    messageRole: passage.role,
    messageTimestamp: passage.timestamp ?? chat.timestamp,
    model: passage.model,
    params: chat.params,
  }));
}

// --- Message Handling ---

self.onmessage = async (event: MessageEvent<SearchWorkerMessage>) => {
  const msg = event.data;

  try {
    if (msg.type === "init") {
      // A failed open is tried again here, once for each start of the service worker.
      if (!index) await openIndex();
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
        msg.passagesPerChat && msg.passagesPerChat > 0 ? msg.passagesPerChat : -1;
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
          ...currentIndexIncomplete(),
        });
        return;
      }

      // The filters of a hydrated search cut the chats in the index, before the limit counts them.
      const indexFilters: IndexFilters = hydrate
        ? {
            ...(filters.after !== undefined ? { after: filters.after } : {}),
            ...(filters.before !== undefined ? { before: filters.before } : {}),
            ...(filterProvider && filterProvider !== "all" ? { provider: filterProvider } : {}),
            ...(msg.chatId ? { chatId: msg.chatId } : {}),
          }
        : {};
      const { chats: ranked, plan } = await performSearch(parsedQuery, indexFilters);
      // After the search: a search that opened the file learns here that it could not.
      const incomplete = currentIndexIncomplete();

      const CHUNK = hydrate ? 10 : 50; // Smaller chunks for hydrated data

      if (ranked.length === 0) {
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
          const ids = ranked.map((chat) => chat.chatId);
          for (let i = 0; i < ids.length; i += CHUNK) {
            sendChunk(ids.slice(i, i + CHUNK), i + CHUNK >= ids.length);
            await new Promise((r) => setTimeout(r, 0));
          }
        } else {
          // Hydration Loop
          let currentChunk: SearchResult[] = [];
          let chatsSent = 0;
          let wasLimited = false;

          // The passages are read for a batch of chats at a time: the limit and one more, which is
          // all there is to read unless a category or a missing row turns some of them away.
          const BATCH = maxChats + 1;
          let found = new Map<string, MarkedPassage[]>();
          for (const [at, r] of ranked.entries()) {
            if (at % BATCH === 0 && index) {
              found = index.passagesFor(
                plan,
                ranked.slice(at, at + BATCH).map((chat) => chat.chatId),
                passagesPerChat,
              );
            }
            // The row and the metadata say whether the chat is a result; the passages come from
            // the index, which holds the text, so no message is read from the database.
            const row = await db.chats.get(r.chatId);
            if (!row) continue;
            if (!(await chatPassesCategory(row, filters))) continue;

            const snippets = resultsOf(row, found.get(r.chatId) ?? [], snippetRadius);
            // A chat counts when it has a passage to show, so a chat after the limit that has
            // none is not "more results". The first one that has one is the proof there are more.
            if (snippets.length === 0) continue;
            if (chatsSent >= maxChats) {
              wasLimited = true;
              break;
            }

            currentChunk.push(...snippets);
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
      // A resumed operation keeps the window it began with (bulk sync calls this again on resume).
      bulkSince ??= Date.now() - CATCH_UP_MARGIN_MS;
      self.postMessage({ type: "bulkComplete", success: true });
      return;
    }

    if (msg.type === "endBulk") {
      const since = bulkSince;
      bulkSince = null;
      // The chats the operation saved are indexed in the background; search answers meanwhile.
      if (since !== null) void catchUpSince(since);
      self.postMessage({ type: "bulkComplete", success: true });
      return;
    }

    if (msg.type === "remove" || msg.type === "removeMany") {
      removeFromIndex(msg.type === "remove" ? [msg.chatId] : msg.chatIds);
      self.postMessage({ type: "removeComplete", success: true });
    }
  } catch (e) {
    log.error("[SearchWorker] Message error:", e);
    const requestId = "requestId" in msg ? msg.requestId : undefined;
    self.postMessage({ type: "error", error: String(e), requestId });
  }
};
