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
 *   ← { "type": "authError", "message": "…" }  (close + retry later)
 *
 * Normal operation – daemon forwards CLI requests verbatim:
 *   ← { "id": "…", "action": "search", "query": "…", … }
 *
 * Extension replies with the standard response envelope:
 *   → { "id": "…", "success": true, "data": […] }
 *
 * Keepalive – while the SW is alive an in-process timer sends pings every 20 s.
 * A chrome.alarm fires every 30 s to wake a dormant SW and reconnect if needed.
 */

import type { ChatMessage, SearchResult } from "../model/haevn_model";
import { parseClaudeCodeJsonl } from "../providers/claudecode/importer";
import { transformToHaevnChat } from "../providers/claudecode/transformer";
import { ImportService } from "../services/importService";
import { getCliSettings } from "../services/settingsService";
import { SyncService } from "../services/syncService";
import { log } from "../utils/logger";

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
    };

interface WsSearchOptions {
  platform?: string;
  after?: string;
  before?: string;
  limit?: number;
  contextChars?: number;
}

interface WsGetOptions {
  messageId?: string;
  includeMetadata?: boolean;
  includeMedia?: boolean;
}

interface WsListOptions {
  platform?: string;
  limit?: number;
  after?: string;
  sortBy?: "lastSynced" | "title" | "messageCount";
}

interface WsExportOptions {
  includeMedia?: boolean;
}

type WsImportFormat = "claude_code" | "codex";

interface WsImportFilePayload {
  name: string;
  content: string;
}

interface WsImportOptions {
  overwrite?: boolean;
  skipIndex?: boolean;
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the WebSocket bridge.
 * Called once from init.ts on service worker startup.
 * Gracefully no-ops if the daemon is not running.
 */
export function initWsBridge(): void {
  connect();

  chrome.alarms.create(WS_RECONNECT_ALARM, {
    periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES,
  });

  schedulePings();
}

/**
 * Called from the alarm listener in init.ts on every WS_RECONNECT_ALARM tick.
 * Reconnects if the socket has dropped, otherwise sends a ping to keep the SW
 * event loop active and prevent Chrome from terminating it.
 */
export function handleWsReconnectAlarm(): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendJson({ type: "ping" });
  } else {
    connect();
  }
}

/**
 * Drop the current connection and reconnect with fresh settings.
 * Called after the port or API key changes in Settings.
 */
export function resetWsBridge(): void {
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
  connect();
}

// ─── Connection management ────────────────────────────────────────────────────

async function connect(): Promise<void> {
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return; // already alive
  }

  let settings: { port: number; apiKey: string };
  try {
    settings = await getCliSettings();
  } catch (err) {
    log.debug("[WsBridge] Could not read CLI settings:", err);
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

  socket.onclose = () => {
    const wasAuth = authenticated;
    socket = null;
    authenticated = false;
    if (wasAuth) {
      log.info("[WsBridge] Disconnected from daemon");
    }
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
  log.debug(`[WsBridge] Scheduling reconnect in ${delayMs}ms (attempt ${reconnectAttempts})`);
}

// ─── Incoming message dispatch ────────────────────────────────────────────────

function handleIncoming(msg: WsIncoming, _apiKey: string): void {
  if ("type" in msg) {
    if (msg.type === "authOk") {
      authenticated = true;
      log.info("[WsBridge] Authenticated with daemon");
      return;
    }
    if (msg.type === "authError") {
      log.warn("[WsBridge] Auth rejected by daemon:", msg.message);
      socket?.close();
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
      default: {
        const _exhaustive: never = req;
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

  const results = await new Promise<SearchResult[]>((resolve, reject) => {
    const collected: SearchResult[] = [];
    SyncService.searchChatsStreaming(query, {
      streamBatchSize: 50,
      maxChatsToScan: options.limit ?? 1000,
      resultsPerChat: 4,
      filterProvider: options.platform,
      contextChars: options.contextChars,
      onResults: (batch) => collected.push(...batch),
      onComplete: () => resolve(collected),
      onError: reject,
    });
  });

  const afterMs = options.after ? new Date(options.after).getTime() : undefined;
  const beforeMs = options.before ? new Date(options.before).getTime() : undefined;

  const filtered = results.filter((r) => {
    if (afterMs && (r.messageTimestamp ?? 0) < afterMs) return false;
    if (beforeMs && (r.messageTimestamp ?? 0) > beforeMs) return false;
    return true;
  });

  return { id, success: true, data: filtered };
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

  return { id, success: true, data: { chats, total } };
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

async function handleExport(
  id: string,
  req: Extract<WsRequest, { action: "export" }>,
): Promise<WsResponse> {
  const chat = await SyncService.getChatWithMessages(req.chatId);
  if (!chat) {
    return { id, success: false, error: `Chat not found: ${req.chatId}`, code: "NOT_FOUND" };
  }
  return { id, success: true, data: chat };
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

  if (format === "codex") {
    return {
      id,
      success: false,
      error: "Codex import is not implemented yet. Use --format claude_code for now.",
      code: "NOT_IMPLEMENTED",
    };
  }

  if (format !== "claude_code") {
    return {
      id,
      success: false,
      error: `Unsupported import format: ${format}`,
      code: "BAD_REQUEST",
    };
  }

  const summary: WsImportResult = {
    format,
    total: files.length,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
  };

  let bulkIndexingStarted = false;

  try {
    if (!skipIndex) {
      await SyncService.startBulkSyncIndexing();
      bulkIndexingStarted = true;
    }

    for (const file of files) {
      summary.processed++;
      try {
        const extraction = await parseClaudeCodeJsonl(file.content);
        const chat = transformToHaevnChat(extraction);

        if (!overwrite) {
          const existing = await SyncService.getChat(chat.id);
          if (existing) {
            summary.skipped++;
            continue;
          }
        }

        await ImportService.saveImportedChat(chat, extraction, { skipIndexing: true });
        summary.saved++;
      } catch (err) {
        summary.errors++;
        log.warn("[WsBridge] Import skipped due to parsing/transformation error", {
          file: file.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (bulkIndexingStarted) {
      await SyncService.finishBulkSyncIndexing();
    }
  }

  return { id, success: true, data: summary };
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
