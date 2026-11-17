/**
 * WebSocket bridge for the HAEVN CLI daemon.
 *
 * The extension opens an OUTBOUND WebSocket connection to the daemon process.
 * This is the inverse of native messaging (where Chrome spawned the daemon):
 * the daemon runs independently and the extension reconnects to it whenever
 * the service worker wakes up.
 *
 *   CLI client  ──HTTP──▶  daemon (localhost:PORT)
 *                               ◀──WS──  extension (here)
 *
 * Protocol
 * ─────────
 * On connect, the extension sends an auth frame:
 *   → { "type": "auth", "apiKey": "…" }
 *
 * Daemon responds:
 *   ← { "type": "authOk" }             (proceed)
 *   ← { "type": "authError", "message": "…" }  (the key is wrong: stop, see below)
 *
 * Normal operation – daemon forwards CLI requests verbatim:
 *   ← { "id": "…", "action": "search", "query": "…", … }
 *
 * Extension replies with the standard response envelope:
 *   → { "id": "…", "success": true, "data": […] }
 *
 * Keepalive – while the SW is alive an in-process timer sends pings every 20 s.
 * A chrome.alarm fires every 30 s to wake a dormant SW and reconnect if needed.
 *
 * Two closes get special treatment (see wsBridgeClose.ts). A newer extension connection
 * replacing this one (4002) is final: two extensions sharing a key would otherwise replace each
 * other for ever, so the bridge stops (no alarm, no timers) until the user enables it or changes
 * a setting. A rejected key (4001) is retried slowly (30 s, doubling to 5 min, while the service
 * worker stays awake; the backoff is in memory, so after the worker idles out the 30 s alarm
 * retries at the base rate), because the fix is usually a daemon restart the extension cannot see.
 */

import type { Chat, ChatMessage, SearchResult } from "../model/haevn_model";
import { parseClaudeCodeJsonl } from "../providers/claudecode/importer";
import { transformToHaevnChat } from "../providers/claudecode/transformer";
import { parseCodexJsonl } from "../providers/codex/importer";
import { transformCodexToHaevnChat } from "../providers/codex/transformer";
import { parsePiJsonl } from "../providers/pi/importer";
import { transformPiToHaevnChat } from "../providers/pi/transformer";
import type { ChatMetadataRecord } from "../services/db";
import * as MetadataRepository from "../services/metadataRepository";
import { generateForChat, setManualMetadata } from "../services/metadataService";
import { getCliSettings } from "../services/settingsService";
import { SyncService } from "../services/syncService";
import type { AllProviderRawData } from "../types/messaging";
import type {
  SearchIndexIncompleteStatus,
  SearchIndexRebuildStatus,
} from "../types/workerMessages";
import { sha256Hex, validateAndNormalizeChat } from "../utils/jsonImporter";
import { log } from "../utils/logger";
import { parseMarkdownContent } from "../utils/markdownImporter";
import { buildTextExportArtifact } from "./export/textExportArtifact";
import { type ImportBatchItem, ImportBusyError, importChatBatch } from "./import/importBatch";
import {
  isKeyRejected,
  rejectedRetryDelayMs,
  terminalCloseReason,
  WS_REASON_UNAUTHORIZED,
} from "./wsBridgeClose";

// ─── Protocol types ────────────────────────────────────────────────────────────

type WsIncoming = { type: "authOk" } | { type: "authError"; message: string } | WsRequest;

/** A CLI request forwarded by the daemon – same shape as the NM protocol. */
type WsRequest =
  | { id: string; action: "search"; query: string; options?: WsSearchOptions }
  | { id: string; action: "get"; chatId: string; options?: WsGetOptions }
  | { id: string; action: "list"; options?: WsListOptions }
  | { id: string; action: "branches"; chatId: string }
  | { id: string; action: "export"; chatId: string; options?: WsExportOptions }
  | {
      id: string;
      action: "import";
      format: WsImportFormat;
      files: WsImportFilePayload[];
      options?: WsImportOptions;
    }
  | { id: string; action: "getMetadata"; chatId: string }
  | { id: string; action: "setMetadata"; chatId: string; metadata: WsMetadataUpdate }
  | { id: string; action: "generateMetadata"; chatId: string };

interface WsSearchOptions {
  platform?: string;
  category?: string;
  after?: string;
  before?: string;
  limit?: number;
  contextChars?: number;
  includeMetadata?: boolean;
}

interface WsGetOptions {
  messageId?: string;
  includeMetadata?: boolean;
  includeMedia?: boolean;
}

type WsListMetadataKey = "description" | "synopsis" | "categories" | "keywords";

interface WsListOptions {
  platform?: string;
  limit?: number;
  after?: string;
  sortBy?: "lastSynced" | "title" | "messageCount";
  /**
   * Metadata keys to include for each chat. The CLI sends a deduplicated list
   * of canonical keys
   */
  includeMetadata?: WsListMetadataKey[];
}

type WsExporterId = "haevn_json" | "haevn_markdown" | "pi_session_jsonl";

interface WsExportOptions {
  includeMedia?: boolean;
  /** Markdown only: write every branch, not only the current one. */
  allBranches?: boolean;
  exporterId?: WsExporterId;
  format?:
    | "json"
    | "markdown"
    | "md"
    | "pi"
    | "jsonl"
    | "haevn_json"
    | "haevn_markdown"
    | "pi_session_jsonl";
}

type WsImportFormat = "claude_code" | "codex" | "pi" | "haevn_json" | "markdown";

interface WsImportFilePayload {
  name: string;
  content: string;
}

interface WsImportOptions {
  overwrite?: boolean;
  skipIndex?: boolean;
}

interface WsMetadataUpdate {
  title?: string;
  description?: string;
  synopsis?: string;
  categories?: string[];
  keywords?: string[];
}

interface WsImportResult {
  format: WsImportFormat;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
}

type WsResponse<T = unknown> =
  | { id: string; success: true; data: T }
  | { id: string; success: false; error: string; code?: string };

function toMessageDict<T extends { id: string }>(messages: T[]): Record<string, T> {
  return Object.fromEntries(messages.map((m) => [m.id, m]));
}

function stripBinaryFromMessage(message: ChatMessage): ChatMessage {
  const cloned = structuredClone(message) as ChatMessage;

  for (const modelMessage of cloned.message || []) {
    if (modelMessage.kind === "request") {
      for (const part of modelMessage.parts || []) {
        if (part.part_kind !== "user-prompt" || !Array.isArray(part.content)) continue;
        part.content = part.content.map((entry) => {
          if (
            typeof entry === "object" &&
            entry !== null &&
            "kind" in entry &&
            (entry as { kind?: string }).kind === "binary"
          ) {
            const binary = entry as {
              kind: "binary";
              media_type: string;
              identifier?: string;
              vendor_metadata?: Record<string, unknown>;
            };
            return {
              kind: "binary",
              data: "[binary omitted]",
              media_type: binary.media_type,
              identifier: binary.identifier,
              vendor_metadata: binary.vendor_metadata,
            };
          }
          return entry;
        });
      }
      continue;
    }

    for (const part of modelMessage.parts || []) {
      if (
        !(
          part.part_kind === "image-response" ||
          part.part_kind === "video-response" ||
          part.part_kind === "audio-response" ||
          part.part_kind === "document-response"
        )
      ) {
        continue;
      }

      if (
        typeof part.content === "object" &&
        part.content !== null &&
        "kind" in part.content &&
        (part.content as { kind?: string }).kind === "binary"
      ) {
        const binary = part.content as {
          kind: "binary";
          media_type: string;
          identifier?: string;
          vendor_metadata?: Record<string, unknown>;
        };
        part.content = {
          kind: "binary",
          data: "[binary omitted]",
          media_type: binary.media_type,
          identifier: binary.identifier,
          vendor_metadata: binary.vendor_metadata,
        };
      }
    }
  }

  return cloned;
}

function maybeStripBinary(
  messages: ChatMessage[],
  includeMedia: boolean | undefined,
): ChatMessage[] {
  if (includeMedia) return messages;
  return messages.map(stripBinaryFromMessage);
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Alarm name used to wake a dormant SW and attempt reconnection. */
export const WS_RECONNECT_ALARM = "haevn-ws-reconnect";

/** How often the alarm fires (minimum allowed since Chrome 105 is 0.5 min). */
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;

/** How often (ms) a ping is sent while the SW is active. */
const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// ─── Module state ─────────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let authenticated = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
/** Why the bridge gave up (a final close, see wsBridgeClose.ts); null while it should connect. */
let haltedReason: string | null = null;
let haltedLoad: Promise<void> | null = null;
/** After a rejected key: no connection before this time (ms since the epoch), and tries so far. */
let retryNotBefore = 0;
let rejectedAttempts = 0;

/**
 * The stop outlives a service worker restart (it would otherwise reconnect the moment the
 * worker woke) but not the browser session, so a restarted browser tries again.
 */
const HALTED_STORAGE_KEY = "haevn.cli.bridgeHalted";

/** Read the stop once per service worker; every caller waits for that one read. */
function loadHalted(): Promise<void> {
  haltedLoad ??= (async () => {
    try {
      const stored = await chrome.storage.session.get(HALTED_STORAGE_KEY);
      const reason = stored?.[HALTED_STORAGE_KEY];
      if (typeof reason === "string" && haltedReason === null) haltedReason = reason;
    } catch {
      // No session storage: the stop lasts as long as this service worker.
    }
  })();
  return haltedLoad;
}

async function setHalted(reason: string | null): Promise<void> {
  haltedReason = reason;
  haltedLoad ??= Promise.resolve(); // what is stored no longer matters: this is newer
  try {
    if (reason === null) await chrome.storage.session.remove(HALTED_STORAGE_KEY);
    else await chrome.storage.session.set({ [HALTED_STORAGE_KEY]: reason });
  } catch {
    // See loadHalted.
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the WebSocket bridge.
 * Called once from init.ts on service worker startup.
 * Gracefully no-ops if the daemon is not running.
 */
export function initWsBridge(): void {
  applyWsBridgeSettings().catch((err) => {
    log.warn("[WsBridge] Failed to initialize bridge settings:", err);
  });
}

/**
 * Called from the alarm listener in init.ts on every WS_RECONNECT_ALARM tick.
 * Reconnects if the socket has dropped, otherwise sends a ping to keep the SW
 * event loop active and prevent Chrome from terminating it.
 */
export function handleWsReconnectAlarm(): void {
  applyWsBridgeSettings().catch((err) => {
    log.warn("[WsBridge] Failed to apply bridge settings on reconnect alarm:", err);
  });
}

/**
 * Drop the current connection and reconnect with fresh settings, also after the bridge gave up.
 * Called after the port, the API key or the switch changes in Settings.
 */
export async function resetWsBridge(): Promise<void> {
  await setHalted(null); // an explicit change of settings is a reason to try again
  retryNotBefore = 0;
  rejectedAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (socket) {
    socket.onclose = null; // prevent auto-reconnect log noise
    socket.close();
    socket = null;
    authenticated = false;
  }
  await applyWsBridgeSettings();
}

export async function applyWsBridgeSettings(): Promise<void> {
  let settings: { enabled: boolean };
  try {
    settings = await getCliSettings();
  } catch (err) {
    log.debug("[WsBridge] Could not read CLI settings:", err);
    return;
  }

  if (!settings.enabled) {
    stopWsBridge();
    return;
  }

  await loadHalted();
  if (haltedReason !== null) return; // gave up; only resetWsBridge resumes

  chrome.alarms.create(WS_RECONNECT_ALARM, {
    periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES,
  });
  schedulePings();

  if (socket && socket.readyState === WebSocket.OPEN) {
    sendJson({ type: "ping" });
    return;
  }
  if (Date.now() < retryNotBefore) return; // the key was rejected; wait out the slow backoff
  await connect();
}

// ─── Connection management ────────────────────────────────────────────────────

function stopWsBridge(): void {
  chrome.alarms.clear(WS_RECONNECT_ALARM).catch(() => {});
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
    authenticated = false;
  }
}

async function connect(): Promise<void> {
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return; // already alive
  }

  let settings: { enabled: boolean; port: number; apiKey: string };
  try {
    settings = await getCliSettings();
  } catch (err) {
    log.debug("[WsBridge] Could not read CLI settings:", err);
    return;
  }
  if (!settings.enabled) {
    return;
  }

  const url = `ws://localhost:${settings.port}/ws`;
  log.debug("[WsBridge] Connecting to", url);

  try {
    socket = new WebSocket(url);
  } catch (err) {
    log.debug("[WsBridge] WebSocket constructor failed:", err);
    socket = null;
    return;
  }

  socket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    log.info("[WsBridge] Connected to daemon");
    sendJson({ type: "auth", apiKey: settings.apiKey });
  };

  socket.onmessage = (event: MessageEvent<string>) => {
    let msg: WsIncoming;
    try {
      msg = JSON.parse(event.data) as WsIncoming;
    } catch {
      log.warn("[WsBridge] Received non-JSON message");
      return;
    }
    handleIncoming(msg, settings.apiKey);
  };

  socket.onerror = () => {
    // Daemon not running — suppress noisy error; onclose will follow.
    log.debug("[WsBridge] Socket error (daemon may not be running)");
  };

  socket.onclose = (event: CloseEvent) => {
    const wasAuth = authenticated;
    socket = null;
    authenticated = false;
    if (wasAuth) {
      log.info("[WsBridge] Disconnected from daemon");
    }
    const reason = terminalCloseReason(event.code);
    if (reason !== null) {
      haltWsBridge(reason);
      return;
    }
    if (isKeyRejected(event.code)) {
      retryAfterRejectedKey();
      return;
    }
    scheduleReconnect();
  };
}

/**
 * Stop for good until settings change: no reconnect timer, no alarm, no pings. The warning is
 * the only trace (the settings page shows no bridge status).
 */
function haltWsBridge(reason: string): void {
  log.warn(
    `[WsBridge] Bridge stopped: ${reason}. It will not reconnect until the bridge is switched on again or the port or API key is changed in Settings.`,
  );
  stopWsBridge();
  void setHalted(reason);
}

/**
 * The daemon refused the key. Keep the alarm (a daemon restarted with the right key is found
 * again) but connect no more often than the slow backoff allows; one warning per try.
 */
function retryAfterRejectedKey(): void {
  const delayMs = rejectedRetryDelayMs(rejectedAttempts++);
  retryNotBefore = Date.now() + delayMs;
  log.warn(
    `[WsBridge] Cannot connect: ${WS_REASON_UNAUTHORIZED}. Trying again in ${Math.round(delayMs / 1000)} s.`,
  );
  scheduleReconnect(delayMs);
}

function scheduleReconnect(delayOverrideMs?: number): void {
  if (reconnectTimer) return;
  const delayMs =
    delayOverrideMs ?? Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  if (delayOverrideMs === undefined) reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    applyWsBridgeSettings().catch((err) => {
      log.warn("[WsBridge] Failed to apply bridge settings during reconnect:", err);
    });
  }, delayMs);
  log.debug(`[WsBridge] Scheduling reconnect in ${delayMs}ms (attempt ${reconnectAttempts})`);
}

// ─── Incoming message dispatch ────────────────────────────────────────────────

function handleIncoming(msg: WsIncoming, _apiKey: string): void {
  if ("type" in msg) {
    if (msg.type === "authOk") {
      authenticated = true;
      retryNotBefore = 0;
      rejectedAttempts = 0;
      log.info("[WsBridge] Authenticated with daemon");
      return;
    }
    if (msg.type === "authError") {
      log.debug("[WsBridge] Auth rejected by daemon:", msg.message);
      // The daemon follows with close code 4001, but a client-initiated close can race it:
      // take the socket down here, so that one rejection is one try, not two.
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
        authenticated = false;
      }
      retryAfterRejectedKey();
      return;
    }
    // Unknown control frame — ignore.
    return;
  }

  // No `type` field → it's a CLI request forwarded by the daemon.
  if (!authenticated) {
    log.warn("[WsBridge] Received request before auth — ignoring");
    return;
  }

  handleRequest(msg as WsRequest);
}

// ─── Request handling (mirrors nativeMessaging.ts logic) ─────────────────────

function handleRequest(req: WsRequest): void {
  const { id, action } = req;
  log.debug(`[WsBridge] Request: ${action} (id=${id})`);

  processRequest(req)
    .then((response) => {
      sendJson(response);
    })
    .catch((err) => {
      log.error(`[WsBridge] Unhandled error for ${action}:`, err);
      sendJson({
        id,
        success: false,
        error: err instanceof Error ? err.message : "Internal error",
        code: "INTERNAL_ERROR",
      } satisfies WsResponse);
    });
}

async function processRequest(req: WsRequest): Promise<WsResponse> {
  const { id } = req;

  try {
    switch (req.action) {
      case "search":
        return await handleSearch(id, req);
      case "list":
        return await handleList(id, req);
      case "get":
        return await handleGet(id, req);
      case "branches":
        return await handleBranches(id, req);
      case "export":
        return await handleExport(id, req);
      case "import":
        return await handleImport(id, req);
      case "getMetadata":
        return await handleGetMetadata(id, req);
      case "setMetadata":
        return await handleSetMetadata(id, req);
      case "generateMetadata":
        return await handleGenerateMetadata(id, req);
      default: {
        const _exhaustive: never = req;
        void _exhaustive;
        return { id, success: false, error: `Unknown action`, code: "UNKNOWN_ACTION" };
      }
    }
  } catch (err) {
    log.error(`[WsBridge] Error handling ${req.action}:`, err);
    return {
      id,
      success: false,
      error: err instanceof Error ? err.message : "Internal error",
      code: "INTERNAL_ERROR",
    };
  }
}

async function handleSearch(
  id: string,
  req: Extract<WsRequest, { action: "search" }>,
): Promise<WsResponse<SearchResult[]>> {
  const { query, options = {} } = req;

  if (!query?.trim()) {
    return { id, success: false, error: "Query is required", code: "BAD_REQUEST" };
  }

  const { results, indexRebuilding, indexIncomplete } = await new Promise<{
    results: SearchResult[];
    indexRebuilding?: SearchIndexRebuildStatus;
    indexIncomplete?: SearchIndexIncompleteStatus;
  }>((resolve, reject) => {
    const collected: SearchResult[] = [];
    SyncService.searchChatsStreaming(query, {
      streamBatchSize: 50,
      maxChatsToScan: options.limit ?? 1000,
      resultsPerChat: 4,
      filterProvider: options.platform,
      contextChars: options.contextChars,
      onResults: (batch) => collected.push(...batch),
      onComplete: (stats) =>
        resolve({
          results: collected,
          indexRebuilding: stats.indexRebuilding,
          indexIncomplete: stats.indexIncomplete,
        }),
      onError: reject,
    });
  });

  // An empty list during a rebuild is not "no matches": say so, so the caller can retry.
  if (indexRebuilding) {
    return {
      id,
      success: false,
      error: `Search index is rebuilding (${indexRebuilding.percentage}%). Try again shortly.`,
      code: "INDEX_REBUILDING",
    };
  }

  // The last rebuild failed and the index is part-built: a short or empty list may be missing
  // chats, and a script cannot tell. Fail rather than answer.
  if (indexIncomplete) {
    log.warn("[WsBridge] Search refused: the index is incomplete:", indexIncomplete.error);
    return {
      id,
      success: false,
      error:
        "Search index is incomplete: the last rebuild failed, so a search may miss chats. Reload the extension to rebuild it.",
      code: "INDEX_INCOMPLETE",
    };
  }

  const afterMs = options.after ? new Date(options.after).getTime() : undefined;
  const beforeMs = options.before ? new Date(options.before).getTime() : undefined;

  const filtered = results.filter((r) => {
    if (afterMs && (r.messageTimestamp ?? 0) < afterMs) return false;
    if (beforeMs && (r.messageTimestamp ?? 0) > beforeMs) return false;
    return true;
  });

  const includeMetadata = options.includeMetadata !== false;
  const category = options.category;
  const needsMetadataLookup = includeMetadata || (!!category && category !== "all");

  const uniqueChatIds = [...new Set(filtered.map((r) => r.chatId))];
  const metaMap =
    needsMetadataLookup && uniqueChatIds.length > 0
      ? await MetadataRepository.getMany(uniqueChatIds)
      : new Map();

  const enriched = includeMetadata
    ? filtered.map((r) => {
        const meta = metaMap.get(r.chatId);
        if (!meta) return r;
        return {
          ...r,
          ...(meta.title ? { metaTitle: meta.title } : {}),
          metadata: {
            title: meta.title,
            description: meta.description,
            synopsis: meta.synopsis,
            categories: meta.categories,
            keywords: meta.keywords,
            source: meta.source,
            generatedAt: meta.generatedAt,
            updatedAt: meta.updatedAt,
          },
        };
      })
    : filtered;

  // Apply category filter if requested
  const categoryFiltered =
    category && category !== "all"
      ? enriched.filter((r) => {
          const meta = metaMap.get(r.chatId);
          if (category === "_unset") return !meta || meta.source === "unset";
          return Array.isArray(meta?.categories) && meta.categories.includes(category);
        })
      : enriched;

  return { id, success: true, data: categoryFiltered };
}

async function handleList(
  id: string,
  req: Extract<WsRequest, { action: "list" }>,
): Promise<WsResponse> {
  const { options = {} } = req;

  const sortByMap: Record<string, string> = {
    lastSynced: "lastSyncedTimestamp",
    title: "title",
    messageCount: "messageCount",
  };
  const sortBy = (sortByMap[options.sortBy ?? "lastSynced"] ?? "lastSyncedTimestamp") as
    | "lastSyncedTimestamp"
    | "title"
    | "messageCount";

  const { metadata, total } = await SyncService.getChatsMetadata(
    0,
    options.limit ?? 50,
    options.platform ?? "all",
    sortBy,
    "desc",
  );

  const afterMs = options.after ? new Date(options.after).getTime() : undefined;
  const filtered = afterMs
    ? metadata.filter((c) => (c.lastSyncedTimestamp ?? 0) >= afterMs)
    : metadata;

  const chats = await Promise.all(
    filtered.map(async (chat) => {
      const chatId = chat.id;
      if (!chatId) return chat;

      try {
        const messages = await SyncService.getChatMessages(chatId);
        const messageValues = Object.values(messages);
        const messageCount = messageValues.length;
        const branchCount = messageValues.filter((m) => (m.childrenIds || []).length === 0).length;
        return {
          ...chat,
          messageCount,
          branchCount,
        };
      } catch {
        return chat;
      }
    }),
  );

  const chatIds = chats.map((c) => c.id).filter(Boolean) as string[];
  const includeMetadataKeys = options.includeMetadata ?? [];
  const needsFullMeta = includeMetadataKeys.length > 0;
  const metaMap = chatIds.length > 0 ? await MetadataRepository.getMany(chatIds) : new Map();
  const enrichedChats = chats.map((chat) => {
    if (!chat.id) return chat;
    const meta = metaMap.get(chat.id);
    let next: Record<string, unknown> = chat;
    if (meta?.title) {
      next = { ...next, metaTitle: meta.title };
    }
    if (needsFullMeta) {
      next = { ...next, metadata: pickListMetadata(meta, includeMetadataKeys) };
    }
    return next;
  });

  return { id, success: true, data: { chats: enrichedChats, total } };
}

/**
 * Project a chat's metadata record onto the requested keys, defaulting a
 * missing record or field to "" (text) or [] (lists) so JSON consumers see
 * a stable shape.
 */
function pickListMetadata(
  meta: ChatMetadataRecord | undefined,
  keys: WsListMetadataKey[],
): Partial<Record<WsListMetadataKey, string | string[]>> {
  const out: Partial<Record<WsListMetadataKey, string | string[]>> = {};
  for (const key of keys) {
    const isText = key === "description" || key === "synopsis";
    out[key] = meta?.[key] ?? (isText ? "" : []);
  }
  return out;
}

async function handleGet(
  id: string,
  req: Extract<WsRequest, { action: "get" }>,
): Promise<WsResponse> {
  const chat = await SyncService.getChat(req.chatId);
  if (!chat) {
    return { id, success: false, error: `Chat not found: ${req.chatId}`, code: "NOT_FOUND" };
  }
  const requestedLeaf = req.options?.messageId;
  const rawBranchMessages = requestedLeaf
    ? await SyncService.getBranchMessages(req.chatId, requestedLeaf)
    : await SyncService.getPrimaryBranchMessages(req.chatId);

  if (requestedLeaf && rawBranchMessages.length === 0) {
    return {
      id,
      success: false,
      error: `Message not found in chat: ${requestedLeaf}`,
      code: "NOT_FOUND",
    };
  }

  const branchMessages = maybeStripBinary(rawBranchMessages, req.options?.includeMedia);
  return {
    id,
    success: true,
    data: {
      ...chat,
      messages: toMessageDict(branchMessages),
    },
  };
}

async function handleBranches(
  id: string,
  req: Extract<WsRequest, { action: "branches" }>,
): Promise<WsResponse> {
  const chat = await SyncService.getChatWithMessages(req.chatId);
  if (!chat) {
    return { id, success: false, error: `Chat not found: ${req.chatId}`, code: "NOT_FOUND" };
  }
  return { id, success: true, data: chat };
}

function resolveWsExporterId(options?: WsExportOptions): WsExporterId {
  const explicit = options?.exporterId;
  if (explicit) {
    return explicit;
  }

  const format = options?.format;
  if (!format) {
    return "haevn_json";
  }

  if (format === "haevn_markdown" || format === "markdown" || format === "md") {
    return "haevn_markdown";
  }

  if (format === "pi_session_jsonl" || format === "pi" || format === "jsonl") {
    return "pi_session_jsonl";
  }

  return "haevn_json";
}

async function handleExport(
  id: string,
  req: Extract<WsRequest, { action: "export" }>,
): Promise<WsResponse> {
  const chat = await SyncService.getChatWithMessages(req.chatId);
  if (!chat) {
    return { id, success: false, error: `Chat not found: ${req.chatId}`, code: "NOT_FOUND" };
  }

  const exporterId = resolveWsExporterId(req.options);
  const includeMedia = req.options?.includeMedia === true;
  const messageRows = maybeStripBinary(Object.values(chat.messages), includeMedia);
  const artifact = await buildTextExportArtifact(
    {
      ...chat,
      messages: toMessageDict(messageRows),
    },
    {
      exporterId,
      format: exporterId === "haevn_markdown" ? "markdown" : "json",
      includeMetadata: true,
      includeTimestamps: true,
      allBranches: req.options?.allBranches === true,
    },
  );

  return {
    id,
    success: true,
    data: {
      format: exporterId,
      ...artifact,
    },
  };
}

async function handleGetMetadata(
  id: string,
  req: Extract<WsRequest, { action: "getMetadata" }>,
): Promise<WsResponse> {
  const record = await MetadataRepository.get(req.chatId);
  return { id, success: true, data: record };
}

async function handleSetMetadata(
  id: string,
  req: Extract<WsRequest, { action: "setMetadata" }>,
): Promise<WsResponse> {
  await setManualMetadata(req.chatId, req.metadata);
  const record = await MetadataRepository.get(req.chatId);
  return { id, success: true, data: record };
}

async function handleGenerateMetadata(
  id: string,
  req: Extract<WsRequest, { action: "generateMetadata" }>,
): Promise<WsResponse> {
  const record = await generateForChat(req.chatId);
  return { id, success: true, data: record };
}

async function handleImport(
  id: string,
  req: Extract<WsRequest, { action: "import" }>,
): Promise<WsResponse<WsImportResult>> {
  const { format, files, options } = req;
  const overwrite = options?.overwrite ?? true;
  const skipIndex = options?.skipIndex ?? false;

  if (!Array.isArray(files) || files.length === 0) {
    return { id, success: false, error: "At least one file is required", code: "BAD_REQUEST" };
  }

  const SUPPORTED_FORMATS: WsImportFormat[] = [
    "claude_code",
    "codex",
    "pi",
    "haevn_json",
    "markdown",
  ];
  if (!SUPPORTED_FORMATS.includes(format)) {
    return {
      id,
      success: false,
      error: `Unsupported import format: ${format}. Expected one of: ${SUPPORTED_FORMATS.join(", ")}`,
      code: "BAD_REQUEST",
    };
  }

  const items: ImportBatchItem[] = files.map((file) => ({
    name: file.name,
    load: async () => {
      let chat: Chat;
      let raw: AllProviderRawData | undefined;
      if (format === "codex") {
        const extraction = await parseCodexJsonl(file.content);
        chat = transformCodexToHaevnChat(extraction);
        raw = extraction;
      } else if (format === "pi") {
        const extraction = await parsePiJsonl(file.content);
        chat = transformPiToHaevnChat(extraction);
        raw = extraction;
      } else if (format === "haevn_json") {
        const contentHash = await sha256Hex(file.content);
        chat = validateAndNormalizeChat(JSON.parse(file.content), contentHash);
      } else if (format === "markdown") {
        chat = await parseMarkdownContent(file.content);
      } else {
        const extraction = await parseClaudeCodeJsonl(file.content);
        chat = transformToHaevnChat(extraction);
        raw = extraction;
      }

      return { chat, raw };
    },
  }));

  try {
    const outcome = await importChatBatch(items, { overwrite, index: !skipIndex });
    return { id, success: true, data: { format, total: files.length, ...outcome } };
  } catch (err) {
    if (err instanceof ImportBusyError) {
      return { id, success: false, error: err.message, code: "BUSY" };
    }
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(value: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch (err) {
    log.warn("[WsBridge] Failed to send message:", err);
  }
}

function schedulePings(): void {
  if (pingTimer !== null) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      sendJson({ type: "ping" });
    }
  }, PING_INTERVAL_MS);
}
