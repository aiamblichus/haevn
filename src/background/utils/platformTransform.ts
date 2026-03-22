// Platform detection and transformer selection logic

import type { Chat } from "../../model/haevn_model";
import { aistudioProvider } from "../../providers/aistudio/provider";
import { chatgptProvider } from "../../providers/chatgpt/provider";
import { claudeProvider } from "../../providers/claude/provider";
import { deepseekProvider } from "../../providers/deepseek/provider";
import { geminiProvider } from "../../providers/gemini/provider";
import { grokProvider } from "../../providers/grok/provider";
import { openwebuiProvider } from "../../providers/openwebui/provider";
import { poeProvider } from "../../providers/poe/provider";
import type { Provider } from "../../providers/provider";
import { qwenProvider } from "../../providers/qwen/provider";
import type { AllProviderRawData } from "../../types/messaging";

/**
 * Transforms raw platform data into HAEVN.Chat format based on platform detection
 * @param rawData Raw platform-specific data
 * @param platformName Platform name from content script detection (optional)
 * @param hostname Hostname from URL (used as fallback)
 * @param tabId Optional tab ID where the chat was extracted from (for media fetching)
 * @returns Array of Chat objects (some platforms like Poe can return multiple chats)
 */
export async function transformRawDataToHaevn(
  rawData: AllProviderRawData,
  platformName: string | undefined,
  hostname: string,
  tabId?: number,
): Promise<Chat[]> {
  // Get the provider based on platform name or hostname
  const provider = getProviderByPlatform(platformName, hostname);

  if (!provider) {
    throw new Error(`Unsupported platform for sync: ${hostname}`);
  }

  // Use the provider's transformer - type-safe, no casts needed
  // Cast to unknown first to satisfy interface compatibility if strict types differ
  // Pass tabId to transformer if it supports it
  return await provider.transformer.transform(rawData as unknown, tabId);
}

/**
 * Get provider instance based on platform name or hostname
 */
function getProviderByPlatform(
  platformName: string | undefined,
  hostname: string,
): Provider | null {
  // Check platform name first, then fall back to hostname matching
  if (
    platformName === "gemini" ||
    hostname.includes("gemini.google.com") ||
    hostname.includes("bard.google.com")
  ) {
    return geminiProvider;
  } else if (platformName === "claude" || hostname.includes("claude.ai")) {
    return claudeProvider;
  } else if (platformName === "poe" || hostname.includes("poe.com")) {
    return poeProvider;
  } else if (
    platformName === "chatgpt" ||
    hostname.includes("chat.openai.com") ||
    hostname.includes("chatgpt.com")
  ) {
    return chatgptProvider;
  } else if (platformName === "openwebui") {
    return openwebuiProvider;
  } else if (platformName === "qwen" || hostname.includes("chat.qwen.ai")) {
    return qwenProvider;
  } else if (platformName === "aistudio" || hostname.includes("aistudio.google.com")) {
    return aistudioProvider;
  } else if (platformName === "deepseek" || hostname.includes("chat.deepseek.com")) {
    return deepseekProvider;
  } else if (
    platformName === "grok" ||
    hostname.includes("grok.com") ||
    hostname.includes("x.ai")
  ) {
    return grokProvider;
  }

  return null;
}
