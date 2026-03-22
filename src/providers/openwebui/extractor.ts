import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { detectPlatform } from "../shared/platformDetector";
import type {
  OpenWebUIChatResponse,
  OpenWebUIFolderResponse,
  OpenWebUIGetAllChatsResponse,
  OpenWebUIRawExtraction,
} from "./model";

// Detect Open WebUI via meta tag (host can be arbitrary)
export function isOpenWebUIPlatform(): boolean {
  const detected = detectPlatform({
    metaSelectors: [
      'meta[name="apple-mobile-web-app-title"][content="Open WebUI"]',
      'meta[name="description"][content="Open WebUI"]',
    ],
    // Also check for Open WebUI specific DOM elements as a fallback
    customDetector: () => {
      // Check if we have Open WebUI's typical localStorage key
      try {
        if (
          localStorage.getItem("token") !== null &&
          document.title.toLowerCase().includes("open webui")
        ) {
          return true;
        }
      } catch {
        // Ignore localStorage access errors
      }
      return false;
    },
  });

  log.debug("[OpenWebUI] Platform detection result:", detected, {
    url: window.location.href,
    metaApple: !!document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    metaDesc: !!document.querySelector('meta[name="description"]'),
  });

  return detected;
}

// Best-effort: try to extract a chat ID from common path patterns; fall back later
export function extractOpenWebUIConversationId(): string | null {
  const path = window.location.pathname;
  // /c/<id>
  const match = path.match(/\/c\/([^/?#]+)/);
  return match ? match[1] : null;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem("token");
  } catch (err: unknown) {
    log.warn("[OpenWebUI] Failed to get token from localStorage:", err);
    return null;
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  log.debug(`[OpenWebUI] API GET ${path}, token present: ${!!token}`);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetchWithTimeout(path, {
    method: "GET",
    credentials: "include",
    headers,
    timeoutMs: 30000,
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    log.error(`[OpenWebUI] API error ${resp.status}:`, errorText.substring(0, 200));
    throw new Error(`Open WebUI API error ${resp.status}: ${resp.statusText}`);
  }
  const json = (await resp.json()) as T;
  log.debug(`[OpenWebUI] API GET ${path} response:`, json);
  return json;
}

export async function extractOpenWebUIChatIds(): Promise<string[]> {
  if (!isOpenWebUIPlatform()) throw new Error("Not on an Open WebUI site");
  // Use /chats/list for lightweight response (just id, title, timestamps)
  const list = await apiGet<OpenWebUIGetAllChatsResponse>(
    "/api/v1/chats/list?include_folders=true",
  );
  log.info(`[OpenWebUI] Found ${list?.length || 0} chats`);
  return (list || []).map((c) => c.id).filter(Boolean);
}

// Type moved to model.ts

// Fetch conversation by ID directly (for bulk sync - no navigation needed)
export async function fetchOpenWebUIConversation(chatId: string): Promise<OpenWebUIRawExtraction> {
  if (!isOpenWebUIPlatform()) throw new Error("Not on an Open WebUI site");
  const chat = await apiGet<OpenWebUIChatResponse>(`/api/v1/chats/${encodeURIComponent(chatId)}`);
  if (!chat) throw new Error("Chat not found");

  const systemPrompt = chat.system || chat.chat?.system || chat.chat?.params?.system;

  log.debug("[OpenWebUI] Fetched chat raw data:", {
    id: chat.id,
    hasSystemRoot: !!chat.system,
    hasSystemNested: !!chat.chat?.system,
    hasSystemParams: !!chat.chat?.params?.system,
    systemSnippet: systemPrompt?.substring(0, 50),
    folderId: chat.folder_id,
  });

  let folderSystems: string[] = [];
  if (chat.folder_id) {
    try {
      const hierarchy = await getOpenWebUIFolderHierarchy(chat.folder_id);
      log.debug(`[OpenWebUI] Fetched folder hierarchy (${hierarchy.length} levels)`);

      // Collect system prompts from outermost to innermost (hierarchy is innermost to outermost)
      folderSystems = hierarchy
        .reverse()
        .map((f) => {
          const p = f.data?.system_prompt;
          if (p)
            log.debug(`[OpenWebUI] Found system prompt in folder "${f.name}":`, p.substring(0, 50));
          return p;
        })
        .filter((s): s is string => !!s);
    } catch (err) {
      log.warn("[OpenWebUI] Failed to fetch folder hierarchy:", err);
    }
  }

  // Ensure system is at root for transformer if found in nested structures
  if (!chat.system) {
    if (chat.chat?.system) {
      chat.system = chat.chat.system;
    } else if (chat.chat?.params?.system) {
      chat.system = chat.chat.params.system;
    }
  }

  return { chat, folderSystems };
}

async function getOpenWebUIFolderHierarchy(folderId: string): Promise<OpenWebUIFolderResponse[]> {
  const hierarchy: OpenWebUIFolderResponse[] = [];
  let currentFolderId: string | null | undefined = folderId;

  while (currentFolderId) {
    try {
      const folder = await apiGet<OpenWebUIFolderResponse>(
        `/api/v1/folders/${encodeURIComponent(currentFolderId)}`,
      );
      if (!folder) break;
      hierarchy.push(folder);
      currentFolderId = folder.parent_id;
    } catch (err) {
      log.error(`[OpenWebUI] Error fetching folder ${currentFolderId}:`, err);
      break;
    }
  }

  return hierarchy;
}

import type { ExportOptions } from "../../formatters";

export async function extractOpenWebUIConversationData(
  _options: ExportOptions,
): Promise<OpenWebUIRawExtraction> {
  if (!isOpenWebUIPlatform()) throw new Error("Not on an Open WebUI site");

  // If URL contains a chat id, prefer it; otherwise return error
  const id = extractOpenWebUIConversationId();
  if (!id) {
    throw new Error(`No chat ID available in URL`);
  }

  return await fetchOpenWebUIConversation(id);
}
