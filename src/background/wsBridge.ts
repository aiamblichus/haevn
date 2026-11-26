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
import { roughDateLabelOf } from "../model/roughDate";
import { parseClaudeCodeJsonl } from "../providers/claudecode/importer";
import { transformToHaevnChat } from "../providers/claudecode/transformer";
import { parseCodexJsonl } from "../providers/codex/importer";
import { transformCodexToHaevnChat } from "../providers/codex/transformer";
import type { FragmentPlanEntry } from "../providers/fragment";
import { isImportableRoom, parseOpenRouterExport } from "../providers/openrouter/importer";
import { transformOpenRouterRoomToHaevnChat } from "../providers/openrouter/transformer";
import { parsePiJsonl } from "../providers/pi/importer";
import { transformPiToHaevnChat } from "../providers/pi/transformer";
import {
  type BackupChatPage,
  type BackupSummary,
  backupSummary,
  chatRecordBlob,
  listBackupChats,
  mediaFile,
} from "../services/backup/backupRead";
import { BACKUP_PAGE_MAX, BackupError } from "../services/backup/format";
import type { ChatMetadataRecord } from "../services/db";
import { type LogEntry, type LogFilter, loggerService } from "../services/loggerService";
import * as MetadataRepository from "../services/metadataRepository";
import { generateOnRequest, setManualMetadata } from "../services/metadataService";
import { SearchQueryError } from "../services/searchQuery";
import { getCliSettings } from "../services/settingsService";
import { SyncService } from "../services/syncService";
import type { AllProviderRawData } from "../types/messaging";
import type {
  SearchFilters,
  SearchIndexIncompleteStatus,
  SearchIndexRebuildStatus,
} from "../types/workerMessages";
import { sha256Hex, validateAndNormalizeChat } from "../utils/jsonImporter";
import { log } from "../utils/logger";
import { errorKind, errorShape } from "../utils/logShape";
import { parseMarkdownContent } from "../utils/markdownImporter";
import {
  beginRestore,
  finishRestore,
  isRestoreOpen,
  type RestoreBeginResult,
  type RestoreFinishResult,
  restoreChat,
  restoreEpoch,
  restoreMedia,
} from "./backup/restoreSession";
import { buildTextExportArtifact } from "./export/textExportArtifact";
import { chromeHealthDeps } from "./health/chromeProbe";
import {
  HealthBusyError,
  HealthRequestError,
  type ProviderHealthReport,
  runProviderHealth,
} from "./health/providerHealth";
import { type ImportBatchItem, ImportBusyError, importChatBatch } from "./import/importBatch";
import { importFragments } from "./import/importFragments";
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
  | { id: string; action: "generateMetadata"; chatId: string }
  | { id: string; action: "health"; options?: WsHealthOptions }
  | { id: string; action: "logs"; options?: WsLogsOptions }
  | { id: string; action: "backupInfo" }
  | { id: string; action: "backupList"; after?: string; limit: number }
  | { id: string; action: "backupChat"; chatId: string; pipeId: string }
  | { id: string; action: "backupMedia"; chatId: string; name: string; pipeId: string }
  | { id: string; action: "restoreBegin"; chats: number }
  | {
      id: string;
      action: "restoreMedia";
      chatId: string;
      name: string;
      bytes: number;
      pipeId: string;
    }
  | { id: string; action: "restoreChat"; chatId: string; pipeId: string; index: boolean }
  | { id: string; action: "restoreFinish"; rebuildIndex: boolean };

/** What `haevn health` may ask for; the same fields as the extension's providerHealth message. */
interface WsHealthOptions {
  providers?: string[];
  chats?: number;
  timeoutMs?: number;
  totalMs?: number;
}

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
  /** Chats to skip before the page; the response's hasMore says whether chats follow it. */
  offset?: number;
  after?: string;
  sortBy?: "lastSynced" | "title" | "messageCount";
  /**
   * Metadata keys to include for each chat. The CLI sends a deduplicated list
   * of canonical keys
   */
  includeMetadata?: WsListMetadataKey[];
}

type WsLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/**
 * What `haevn logs` may ask for: the service's filter (the level is that level and above, the
 * context is exact, the match is a case-insensitive substring) and how many of the newest entries
 * to answer.
 */
interface WsLogsOptions {
  limit?: number;
  level?: WsLogLevel;
  context?: string;
  match?: string;
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

type WsImportFormat =
  | "claude_code"
  | "codex"
  | "pi"
  | "openrouter"
  | "haevn_json"
  | "markdown"
  | "fragment";

interface WsImportFilePayload {
  name: string;
  content: string;
}

interface WsImportOptions {
  overwrite?: boolean;
  skipIndex?: boolean;
  /** Fragments only: plan the files and answer the plan, write nothing */
  dryRun?: boolean;
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
  /** The files that were not saved, and why (`errors` counts them) */
  failed: { name: string; message: string }[];
  /** Set when the chats were saved but the search index could not be brought up to date. */
  indexError?: string;
  /** Fragments only: one entry per file, with its state and warnings (the dry run's answer) */
  plan?: FragmentPlanEntry[];
  /** Fragments only: the request was a dry run, and nothing was written */
  dryRun?: boolean;
}

type WsResponse<T = unknown> =
  | {
      id: string;
      success: true;
      data: T;
      /** A search only: more chats matched than the limit let through. */
      hasMore?: boolean;
    }
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

/**
 * A failed request as the log may tell it (HVN-157). The caller gets the error itself in the
 * response; the log must not repeat what the request carried: a search error can quote the query,
 * and a parse error of an import quotes the file's text.
 */
function wsErrorShape(action: string, err: unknown): string {
  return action === "search" ? errorKind(err) : errorShape(err);
}

function handleRequest(req: WsRequest): void {
  const { id, action } = req;
  log.debug(`[WsBridge] Request: ${action} (id=${id})`);

  processRequest(req)
    .then((response) => {
      sendJson(response);
    })
    .catch((err) => {
      log.error(`[WsBridge] Unhandled error for ${action}:`, wsErrorShape(action, err));
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
      case "health":
        return await handleHealth(id, req);
      case "logs":
        return await handleLogs(id, req);
      case "backupInfo":
        return await handleBackupInfo(id);
      case "backupList":
        return await handleBackupList(id, req);
      case "backupChat":
        return await handleBackupChat(id, req);
      case "backupMedia":
        return await handleBackupMedia(id, req);
      case "restoreBegin":
        return await handleRestoreBegin(id, req);
      case "restoreMedia":
        return await handleRestoreMedia(id, req);
      case "restoreChat":
        return await handleRestoreChat(id, req);
      case "restoreFinish":
        return await handleRestoreFinish(id, req);
      default: {
        const _exhaustive: never = req;
        void _exhaustive;
        return { id, success: false, error: `Unknown action`, code: "UNKNOWN_ACTION" };
      }
    }
  } catch (err) {
    log.error(`[WsBridge] Error handling ${req.action}:`, wsErrorShape(req.action, err));
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

  // The date range and the category go down with the search, so the limit is a limit on the chats
  // that pass them; a date that does not parse is no filter, as it always was.
  const afterMs = options.after ? new Date(options.after).getTime() : Number.NaN;
  const beforeMs = options.before ? new Date(options.before).getTime() : Number.NaN;
  const filters: SearchFilters = {
    ...(Number.isFinite(afterMs) ? { after: afterMs } : {}),
    ...(Number.isFinite(beforeMs) ? { before: beforeMs } : {}),
    ...(options.category ? { category: options.category } : {}),
  };

  const { results, wasLimited, queryProblem, indexRebuilding, indexIncomplete } =
    await new Promise<{
      results: SearchResult[];
      wasLimited: boolean;
      queryProblem?: string;
      indexRebuilding?: SearchIndexRebuildStatus;
      indexIncomplete?: SearchIndexIncompleteStatus;
    }>((resolve, reject) => {
      const collected: SearchResult[] = [];
      SyncService.searchChatsStreaming(query, {
        streamBatchSize: 50,
        maxChatsToScan: options.limit ?? 1000,
        resultsPerChat: 4,
        filterProvider: options.platform,
        filters,
        contextChars: options.contextChars,
        onResults: (batch) => collected.push(...batch),
        onComplete: (stats) =>
          resolve({
            results: collected,
            wasLimited: stats.wasLimited,
            indexRebuilding: stats.indexRebuilding,
            indexIncomplete: stats.indexIncomplete,
          }),
        onError: (err) =>
          err instanceof SearchQueryError
            ? resolve({ results: [], wasLimited: false, queryProblem: err.message })
            : reject(err),
      });
    });

  // A query with nothing to look for is the caller's to fix, not an empty answer.
  if (queryProblem) {
    return { id, success: false, error: queryProblem, code: "BAD_QUERY" };
  }

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

  const includeMetadata = options.includeMetadata !== false;
  const uniqueChatIds = [...new Set(results.map((r) => r.chatId))];
  const metaMap =
    includeMetadata && uniqueChatIds.length > 0
      ? await MetadataRepository.getMany(uniqueChatIds)
      : new Map();

  const enriched = includeMetadata
    ? results.map((r) => {
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
    : results;

  // `data` stays the list of results, so a CLI that does not know `hasMore` still reads it.
  return { id, success: true, data: enriched, hasMore: wasLimited };
}

async function handleList(
  id: string,
  req: Extract<WsRequest, { action: "list" }>,
): Promise<WsResponse> {
  const { options = {} } = req;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return {
      id,
      success: false,
      error: "offset must be a whole number, 0 or more",
      code: "BAD_REQUEST",
    };
  }

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
    offset,
    options.limit ?? 50,
    options.platform ?? "all",
    sortBy,
    "desc",
  );
  // The page is the rows from offset on, so chats follow it while those rows end before the
  // total. Counted before the after-date filter below, which can drop some of the page's rows.
  const hasMore = offset + metadata.length < total;

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

  return { id, success: true, data: { chats: enrichedChats, total, hasMore } };
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

/**
 * A chat with a rough date gives its label as `dateLabel` (HVN-171), the one label the archive
 * shows, so the CLI prints it where a time would be: the stored times of such a chat are made up
 * (HVN-163). Any other chat is sent as it is, so an older CLI sees no new key.
 */
function withDateLabel(chat: Chat): Chat & { dateLabel?: string } {
  const dateLabel = roughDateLabelOf(chat);
  return dateLabel === undefined ? chat : { ...chat, dateLabel };
}

async function handleGet(
  id: string,
  req: Extract<WsRequest, { action: "get" }>,
): Promise<WsResponse> {
  const refusal = await SyncService.unmovedRefusal(req.chatId);
  if (refusal) return { id, success: false, error: refusal };
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
      ...withDateLabel(chat),
      messages: toMessageDict(branchMessages),
    },
  };
}

async function handleBranches(
  id: string,
  req: Extract<WsRequest, { action: "branches" }>,
): Promise<WsResponse> {
  const refusal = await SyncService.unmovedRefusal(req.chatId);
  if (refusal) return { id, success: false, error: refusal };
  const chat = await SyncService.getChatWithMessages(req.chatId);
  if (!chat) {
    return { id, success: false, error: `Chat not found: ${req.chatId}`, code: "NOT_FOUND" };
  }
  return { id, success: true, data: withDateLabel(chat) };
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
  const refusal = await SyncService.unmovedRefusal(req.chatId);
  if (refusal) return { id, success: false, error: refusal };
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
  const record = await generateOnRequest(req.chatId);
  return { id, success: true, data: record };
}

/**
 * The same operation as the extension's own `providerHealth` message (haevnDebug.providerHealth):
 * read-only, no chat text, title or id in the reply.
 */
async function handleHealth(
  id: string,
  req: Extract<WsRequest, { action: "health" }>,
): Promise<WsResponse<ProviderHealthReport>> {
  try {
    const report = await runProviderHealth(req.options, chromeHealthDeps());
    return { id, success: true, data: report };
  } catch (err) {
    if (err instanceof HealthBusyError) {
      return { id, success: false, error: err.message, code: "BUSY" };
    }
    if (err instanceof HealthRequestError) {
      return { id, success: false, error: err.message, code: "BAD_REQUEST" };
    }
    throw err;
  }
}

/** The most entries `haevn logs` may ask for: the size of the logger's buffer by default. */
const LOGS_MAX_LIMIT = 1000;
const LOGS_DEFAULT_LIMIT = 200;
const LOG_LEVELS: readonly WsLogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

/**
 * `haevn logs` (HVN-156): the same read as the extension's `getLogs` message (haevnDebug.getLogs),
 * through the same service, then the newest `limit` entries, oldest first. Until HVN-157 some entries
 * carry text (a chat title, a search query, part of a reply), so the answer is as private as the log.
 */
async function handleLogs(
  id: string,
  req: Extract<WsRequest, { action: "logs" }>,
): Promise<WsResponse<LogEntry[]>> {
  const { options = {} } = req;
  const limit = options.limit ?? LOGS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LOGS_MAX_LIMIT) {
    return {
      id,
      success: false,
      error: `limit must be a whole number, 1 to ${LOGS_MAX_LIMIT}`,
      code: "BAD_REQUEST",
    };
  }
  if (options.level !== undefined && !LOG_LEVELS.includes(options.level)) {
    return {
      id,
      success: false,
      error: "level must be DEBUG, INFO, WARN or ERROR",
      code: "BAD_REQUEST",
    };
  }

  const filter: LogFilter = {};
  if (options.level !== undefined) filter.level = options.level;
  if (options.context !== undefined) filter.context = options.context;
  if (options.match !== undefined) filter.match = options.match;

  const entries = loggerService.getLogs(filter);
  return { id, success: true, data: entries.slice(-limit) };
}

/**
 * The answer of a backup action while a restore is open (HVN-143). A backup taken mid-restore can
 * pair a restored media file with the chat row it replaced, so the four backup actions wait for the
 * restore to end. Each one checks this before it reads a row or sends a byte.
 */
function restoreRunningAnswer(id: string): WsResponse<never> {
  return {
    id,
    success: false,
    error: "A restore is running. Try again when it ends.",
    code: "BUSY",
  };
}

/**
 * The backup protocol's first answer: what a run needs to plan itself (HVN-134). The restore
 * counter is what the run compares with its last answer (HVN-144); `BACKUP_PROTOCOL` stays 1.
 */
async function handleBackupInfo(
  id: string,
): Promise<WsResponse<BackupSummary & { haevnVersion: string; restoreEpoch: number }>> {
  if (isRestoreOpen()) return restoreRunningAnswer(id);
  const summary = await backupSummary();
  const haevnVersion = chrome.runtime.getManifest().version || "unknown";
  const epoch = await restoreEpoch();
  return { id, success: true, data: { ...summary, haevnVersion, restoreEpoch: epoch } };
}

async function handleBackupList(
  id: string,
  req: Extract<WsRequest, { action: "backupList" }>,
): Promise<WsResponse<BackupChatPage>> {
  if (isRestoreOpen()) return restoreRunningAnswer(id);
  const { after, limit } = req;
  if (!Number.isInteger(limit) || limit < 1 || limit > BACKUP_PAGE_MAX) {
    return {
      id,
      success: false,
      error: `limit must be a whole number from 1 to ${BACKUP_PAGE_MAX}`,
      code: "BAD_REQUEST",
    };
  }
  if (after !== undefined && typeof after !== "string") {
    return { id, success: false, error: "after must be a chat id", code: "BAD_REQUEST" };
  }
  return { id, success: true, data: await listBackupChats({ after, limit }) };
}

async function handleBackupChat(
  id: string,
  req: Extract<WsRequest, { action: "backupChat" }>,
): Promise<WsResponse<{ bytes: number }>> {
  if (isRestoreOpen()) return restoreRunningAnswer(id);
  try {
    requirePipeId(req.pipeId);
    const bytes = await sendToPipe(req.pipeId, await chatRecordBlob(req.chatId));
    return { id, success: true, data: { bytes } };
  } catch (err) {
    if (err instanceof BackupError) {
      return { id, success: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

async function handleBackupMedia(
  id: string,
  req: Extract<WsRequest, { action: "backupMedia" }>,
): Promise<WsResponse<{ bytes: number }>> {
  if (isRestoreOpen()) return restoreRunningAnswer(id);
  try {
    requirePipeId(req.pipeId);
    const bytes = await sendToPipe(req.pipeId, await mediaFile(req.chatId, req.name));
    return { id, success: true, data: { bytes } };
  } catch (err) {
    if (err instanceof BackupError) {
      return { id, success: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

/**
 * The restore actions (HVN-136). The session behind them (the lock, the idle timer, what happens
 * after each chat) is `./backup/restoreSession`; the write is `services/backup/backupRestore`. The
 * bridge checks the shape of the request and answers.
 */
async function handleRestoreBegin(
  id: string,
  req: Extract<WsRequest, { action: "restoreBegin" }>,
): Promise<WsResponse<RestoreBeginResult>> {
  return answerBackup(id, () => beginRestore({ chats: req.chats }));
}

async function handleRestoreMedia(
  id: string,
  req: Extract<WsRequest, { action: "restoreMedia" }>,
): Promise<WsResponse<{ bytes: number }>> {
  return answerBackup(id, async () => {
    requirePipeId(req.pipeId);
    requireString(req.chatId, "chatId");
    requireString(req.name, "name");
    return restoreMedia({
      chatId: req.chatId,
      name: req.name,
      bytes: req.bytes,
      openBody: () => readFromPipe(req.pipeId),
    });
  });
}

async function handleRestoreChat(
  id: string,
  req: Extract<WsRequest, { action: "restoreChat" }>,
): Promise<WsResponse<{ replaced: boolean }>> {
  return answerBackup(id, async () => {
    requirePipeId(req.pipeId);
    requireString(req.chatId, "chatId");
    return restoreChat({
      chatId: req.chatId,
      index: req.index === true,
      openBody: () => readFromPipe(req.pipeId),
    });
  });
}

async function handleRestoreFinish(
  id: string,
  req: Extract<WsRequest, { action: "restoreFinish" }>,
): Promise<WsResponse<RestoreFinishResult>> {
  return answerBackup(id, () => finishRestore({ rebuildIndex: req.rebuildIndex === true }));
}

/** Runs a backup action and answers its result; a BackupError becomes an error frame with its code. */
async function answerBackup<T>(id: string, work: () => Promise<T>): Promise<WsResponse<T>> {
  try {
    return { id, success: true, data: await work() };
  } catch (err) {
    if (err instanceof BackupError) {
      return { id, success: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new BackupError("BAD_REQUEST", `${field} must be a non-empty string`);
  }
}

/** A pipe id is 128 random bits, in base64url or hex. Nothing else goes into a URL with the key. */
const PIPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requirePipeId(pipeId: string): void {
  if (!PIPE_ID_PATTERN.test(pipeId)) {
    throw new BackupError("BAD_REQUEST", "pipeId is not a pipe id");
  }
}

/**
 * Sends one backup record or media file to the daemon's pipe, and answers its size. The request
 * carries the CLI's Bearer key, as every request to the daemon does. This is the one place the pipe's
 * auth lives: when the pipe lands (HVN-133) it changes here and nowhere else.
 */
async function sendToPipe(pipeId: string, body: Blob): Promise<number> {
  const { port, apiKey } = await getCliSettings();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/pipe/${pipeId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch (err) {
    throw new BackupError("PIPE_FAILED", `the daemon's pipe is not reachable: ${String(err)}`);
  }
  if (!res.ok) {
    throw new BackupError("PIPE_FAILED", `the daemon's pipe answered ${res.status}`);
  }
  return body.size;
}

/**
 * Opens the CLI's upload on the daemon's pipe, for a restore action. The mirror of `sendToPipe`:
 * the same URL, the same Bearer key, and a failure is PIPE_FAILED. The body stays a stream, so a
 * chat of hundreds of megabytes is never held whole.
 */
async function readFromPipe(pipeId: string): Promise<{
  stream: ReadableStream<Uint8Array>;
  bytes: number | null;
}> {
  const { port, apiKey } = await getCliSettings();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/pipe/${pipeId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    throw new BackupError("PIPE_FAILED", `the daemon's pipe is not reachable: ${String(err)}`);
  }
  if (!res.ok || !res.body) {
    throw new BackupError("PIPE_FAILED", `the daemon's pipe answered ${res.status}`);
  }
  const announced = res.headers.get("content-length");
  const bytes = announced !== null && /^\d+$/.test(announced) ? Number(announced) : null;
  return { stream: res.body, bytes };
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
    "openrouter",
    "haevn_json",
    "markdown",
    "fragment",
  ];
  if (!SUPPORTED_FORMATS.includes(format)) {
    return {
      id,
      success: false,
      error: `Unsupported import format: ${format}. Expected one of: ${SUPPORTED_FORMATS.join(", ")}`,
      code: "BAD_REQUEST",
    };
  }

  // A request for a dry run must not be answered with an import: only fragments have a plan
  if (options?.dryRun && format !== "fragment") {
    return {
      id,
      success: false,
      error: `A dry run is only offered for the fragment format, not "${format}"`,
      code: "BAD_REQUEST",
    };
  }

  if (format === "fragment") {
    // The plan is the answer: a refused file is in it, and does not stop the others
    const fragmentFiles = files.map((file) => ({
      name: String(file.name),
      content: typeof file.content === "string" ? file.content : "",
    }));
    try {
      const outcome = await importFragments(fragmentFiles, {
        dryRun: options?.dryRun ?? false,
        overwrite,
        index: !skipIndex,
      });
      const batch = outcome.imported;
      return {
        id,
        success: true,
        data: {
          format,
          total: fragmentFiles.length,
          processed: batch?.processed ?? 0,
          saved: batch?.saved ?? 0,
          skipped: batch?.skipped ?? 0,
          errors: batch?.errors ?? 0,
          failed: batch?.failed ?? [],
          ...(batch?.indexError ? { indexError: batch.indexError } : {}),
          plan: outcome.plan,
          dryRun: options?.dryRun ?? false,
        },
      };
    } catch (err) {
      if (err instanceof ImportBusyError) {
        return { id, success: false, error: err.message, code: "BUSY" };
      }
      throw err;
    }
  }

  // An OpenRouter export file holds many chats (one per room): each room that has a message is an
  // item of the batch, named "<file>#<n>" with n counting those rooms (not the room's place in the file).
  const openRouterItems = (file: WsImportFilePayload): ImportBatchItem[] => {
    let extraction: ReturnType<typeof parseOpenRouterExport>;
    try {
      extraction = parseOpenRouterExport(file.content);
    } catch (err) {
      // The batch counts a throwing item as one error and goes on with the other files.
      return [
        {
          name: file.name,
          load: async () => {
            throw err;
          },
        },
      ];
    }
    return extraction.rooms.filter(isImportableRoom).map((room, index) => ({
      name: `${file.name}#${index + 1}`,
      load: async () => ({
        chat: transformOpenRouterRoomToHaevnChat(room, extraction.version),
        raw: extraction,
      }),
    }));
  };

  const fileItems: ImportBatchItem[] = files.map((file) => ({
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

  // An OpenRouter file is never loaded by the items above (they load lazily): its items are the rooms.
  const items = format === "openrouter" ? files.flatMap(openRouterItems) : fileItems;

  try {
    const outcome = await importChatBatch(items, { overwrite, index: !skipIndex });
    return { id, success: true, data: { format, total: items.length, ...outcome } };
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
