/**
 * Poe Conversation Extractor
 * Uses Poe's GraphQL API for fast, reliable extraction
 */

import { log } from "../../utils/logger";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import * as api from "./api";
import type { PoeConversationData } from "./model";

// ============================================================================
// Platform Detection
// ============================================================================

export function isPoePlatform(): boolean {
  return detectPlatform({
    hostnames: ["poe.com"],
  });
}

// ============================================================================
// Conversation ID Extraction
// ============================================================================

/**
 * Extract conversation slug from URL
 */
export function extractPoeConversationId(): string {
  const pathname = window.location.pathname;
  try {
    const match = pathname.match(/chat\/([^/?]+)/);
    return match ? match[1] : generateFallbackId("poe");
  } catch (error) {
    log.error("[Poe Extractor] Error extracting conversation ID:", error);
    return generateFallbackId("poe");
  }
}

// ============================================================================
// Single Chat Extraction
// ============================================================================

/**
 * Extract conversation data using Poe's GraphQL API
 * Returns the full conversation with all messages
 */
export async function getPoeChatData(
  chatId: string, // This corresponds to the `chatCode` for Poe
  _baseUrl: string,
): Promise<PoeConversationData> {
  // Check if we have valid tokenss
  const hasTokens = await api.hasValidTokens();
  if (!hasTokens) {
    log.warn("[Poe Extractor] No valid API tokens available");
    throw new Error("No valid API tokens available");
  }

  const chatInfo = await api.fetchChat(chatId);

  const title = chatInfo.chatOfCode.title;
  const botName = chatInfo.chatOfCode.defaultBotObject?.displayName;
  const poeId = chatInfo.chatOfCode.id;
  const edges = chatInfo.chatOfCode.messagesConnection.edges;
  const systemPrompt = chatInfo.chatOfCode.defaultBotObject?.promptPlaintext;
  let pageInfo = { ...chatInfo.chatOfCode.messagesConnection.pageInfo };
  const messages = edges.map((edge) => edge.node);

  // Now call fetchPaginatedMessages in a loop to get the rest of the messages
  while (pageInfo.hasPreviousPage) {
    const nextMessages = await api.fetchPaginatedMessages(100, pageInfo.startCursor, poeId);
    messages.push(...nextMessages.node.messagesConnection.edges.map((edge) => edge.node));
    pageInfo = {
      ...nextMessages.node.messagesConnection.pageInfo,
    };
  }

  log.info("[Poe Extractor] Extraction complete", {
    messageCount: messages.length,
  });

  return {
    chatId: chatId,
    chatCode: chatId,
    messages,
    systemPrompt,
    title: title ?? "Untitled",
    botName: botName ?? "Unknown Bot",
    extractedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Bulk Sync - Get All Chat IDs
// ============================================================================

/**
 * Get all Poe chat IDs using the GraphQL API
 * Used for bulk sync operations
 */
export async function getPoeChatIds(): Promise<string[]> {
  if (!isPoePlatform()) {
    throw new Error("Not on Poe");
  }

  const hasTokens = await api.hasValidTokens();
  if (!hasTokens) {
    throw new Error(
      "No valid Poe API tokens available. Please refresh the Poe page to capture authentication tokens.",
    );
  }

  log.info("[Poe Extractor] Fetching chat IDs via GraphQL API");

  const history = await api.fetchHistory();
  const chats = history.chats.edges.map((edge) => edge.node);
  let pageInfo = { ...history.chats.pageInfo };

  // Now call fetchPaginatedHistory in a loop to get the rest of the chat codes
  while (pageInfo.hasNextPage) {
    const nextChats = await api.fetchPaginatedHistory(50, pageInfo.endCursor);
    chats.push(...nextChats.chats.edges.map((edge) => edge.node));
    pageInfo = { ...nextChats.chats.pageInfo };
  }

  log.info(`[Poe Extractor] Found ${chats.length} chats`);

  return chats.map((chat) => chat.chatCode);
}
