import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { RateLimiter } from "../../utils/rateLimit";
import { ExportOptions } from "../interfaces";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import type { ChatList, ChatTranscript } from "./model";

// Rate limit: 5 requests per second
const claudeRateLimiter = new RateLimiter(5, 1000);

// Platform Detection
export function isClaudePlatform(): boolean {
  return detectPlatform({
    hostnames: ["claude.ai"],
  });
}

// Organization ID from storage (captured by listener)
async function getOrganizationIdFromStorage(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get("claudeAuthTokens");
    const tokens = result.claudeAuthTokens as
      | { organizationId?: string; capturedAt?: number }
      | undefined;
    return tokens?.organizationId || null;
  } catch (error) {
    log.debug("[Claude Extractor] Failed to read organizationId from storage:", error);
    return null;
  }
}

// Organization ID Extraction from cookies (fallback)
export function extractOrganizationId(): string | null {
  try {
    const cookies = document.cookie.split(";");
    const lastActiveOrgCookie = cookies
      .find((cookie) => cookie.trim().startsWith("lastActiveOrg="))
      ?.trim();

    if (lastActiveOrgCookie) {
      const orgId = lastActiveOrgCookie.split("=")[1];
      return orgId;
    }
    return null;
  } catch (error) {
    log.error("Error extracting organization ID:", error);
    return null;
  }
}

// Get organizationId (try storage first, fallback to cookies)
async function getOrganizationId(): Promise<string | null> {
  // Try storage first (captured by listener)
  let orgId = await getOrganizationIdFromStorage();
  if (orgId) return orgId;

  // Fallback to cookie extraction (for content script context)
  orgId = extractOrganizationId();
  return orgId;
}

// Conversation ID Extraction
export function extractClaudeConversationId(): string {
  const pathname = window.location.pathname;
  try {
    const claudeMatch = pathname.match(/\/chat\/([^/?]+)/);
    return claudeMatch ? claudeMatch[1] : generateFallbackId("claude");
  } catch (error) {
    log.error("Error extracting Claude conversation ID:", error);
    return generateFallbackId("claude");
  }
}

// Fetch full conversation JSON via Claude API
export async function fetchClaudeConversation(
  organizationId: string,
  conversationId: string,
): Promise<ChatTranscript> {
  const apiUrl = `https://claude.ai/api/organizations/${organizationId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const response = await claudeRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeoutMs: 30000,
    }),
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation ${conversationId}: ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  return data as ChatTranscript;
}

export async function extractClaudeConversationData(
  _options: ExportOptions = {},
): Promise<ChatTranscript> {
  if (!isClaudePlatform()) {
    throw new Error("Not on a Claude platform");
  }

  const organizationId = await getOrganizationId();
  if (!organizationId) {
    throw new Error("Could not find organizationId");
  }
  const conversationId = extractClaudeConversationId();

  const transcript = await fetchClaudeConversation(organizationId, conversationId);
  return transcript;
}

/**
 * Validates if a string is a valid UUID format.
 * UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (hexadecimal digits)
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function extractClaudeChatIds(): Promise<string[]> {
  const organizationId = await getOrganizationId();
  if (!organizationId) {
    throw new Error("Could not find organizationId");
  }

  const apiUrl = `https://claude.ai/api/organizations/${organizationId}/chat_conversations`;
  const response = await claudeRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeoutMs: 30000,
    }),
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch chat list: ${response.status} ${response.statusText}`);
  }

  const chatList = (await response.json()) as ChatList;
  const allIds = chatList.map((chat) => chat.uuid);

  // Filter out IDs that start with 'claude_conv_' and only keep valid UUIDs
  const validIds = allIds.filter((id) => {
    // Exclude IDs starting with 'claude_conv_'
    if (id.startsWith("claude_conv_")) {
      return false;
    }
    // Only include valid UUIDs
    return isValidUUID(id);
  });

  if (validIds.length < allIds.length) {
    const filteredCount = allIds.length - validIds.length;
    log.info(
      `[Claude] Filtered out ${filteredCount} invalid chat ID(s) (claude_conv_* or non-UUID format)`,
    );
  }

  return validIds;
}
