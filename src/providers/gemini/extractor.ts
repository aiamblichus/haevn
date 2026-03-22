// Gemini Chat Extraction - TypeScript Functions

import { log } from "../../utils/logger";
import { detectPlatform } from "../shared/platformDetector";
import { formatLocalTime, generateFallbackId } from "../shared_utils";
import type { GeminiConversationData, GeminiFileInfo, GeminiMessage } from "./model";

const TurndownService = require("turndown");

export interface ExportOptions {
  customTitle?: string;
  includeMetadata?: boolean;
  includeTimestamps?: boolean;
  format?: "json" | "markdown";
}

const turndownService = new TurndownService();
const turndownPluginGfm = require("@joplin/turndown-plugin-gfm");
const gfm = turndownPluginGfm.gfm;
turndownService.use(gfm);

function normalizeThinkingUiText(text: string): string {
  if (!text) return "";
  return text.replace(/^show thinking[^\n]*\n+/i, "").trim();
}

function normalizeForComparison(text: string): string {
  return normalizeThinkingUiText(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function isLikelyDuplicateThinking(thinking: string, content: string): boolean {
  const normalizedThinking = normalizeForComparison(thinking);
  const normalizedContent = normalizeForComparison(content);

  if (!normalizedThinking || !normalizedContent) return false;

  // Avoid accidental stripping on tiny snippets.
  if (normalizedThinking.length < 40 || normalizedContent.length < 40) return false;

  return (
    normalizedThinking === normalizedContent ||
    normalizedThinking.includes(normalizedContent) ||
    normalizedContent.includes(normalizedThinking)
  );
}

function extractThinkingMarkdown(thinkingEl: HTMLElement): string {
  const expandedContent = thinkingEl.querySelector(
    ".thoughts-content-expanded",
  ) as HTMLElement | null;
  const source = expandedContent || thinkingEl;

  const clone = source.cloneNode(true) as HTMLElement;

  // Strip Gemini UI chrome from the extracted thought text.
  const uiElements = clone.querySelectorAll(
    ".thoughts-header-button-content, button, mat-icon, [role='button'], [aria-label*='thinking']",
  );
  uiElements.forEach((el) => el.remove());

  const markdown = turndownService.turndown(clone).trim();
  if (markdown) return normalizeThinkingUiText(markdown);

  // Fallback to text extraction if markdown conversion is empty.
  const rawText = clone.innerText?.trim() || "";
  return normalizeThinkingUiText(rawText);
}

/**
 * Extract the deep research report markdown from the immersive panel.
 * Gemini renders the full research document in a <deep-research-immersive-panel>
 * sibling to the chat window, separate from the <model-response> elements.
 */
function extractDeepResearchReport(): string {
  const immersivePanel = document.querySelector("deep-research-immersive-panel");
  if (!immersivePanel) return "";

  const markdownEl = immersivePanel.querySelector(
    "structured-content-container message-content .markdown",
  ) as HTMLElement | null;
  if (!markdownEl) return "";

  const clone = markdownEl.cloneNode(true) as HTMLElement;
  // Remove any Gemini UI chrome that may be embedded in the report DOM.
  clone
    .querySelectorAll("button, mat-icon, [role='button'], canvas-create-button-container")
    .forEach((el) => el.remove());

  return turndownService.turndown(clone).trim();
}

// Platform Detection
export function isGeminiPlatform(): boolean {
  return detectPlatform({
    hostnames: ["bard.google.com", "gemini.google.com"],
  });
}

// Conversation ID Extraction
export function extractGeminiConversationId(): string {
  const pathname = window.location.pathname;

  try {
    // Modern Gemini URL pattern: /app/{chatId}
    const geminiMatch = pathname.match(/\/app\/([^/?]+)/);
    return geminiMatch ? geminiMatch[1] : generateFallbackId("gemini");
  } catch (error) {
    log.error("Error extracting Gemini conversation ID:", error);
    return generateFallbackId("gemini");
  }
}

// Title Extraction
export function extractGeminiConversationTitle(): string {
  // Primary: Try conversation-actions header (current Gemini UI)
  const headerTitle = document
    .querySelector("conversation-actions .conversation-title")
    ?.textContent?.trim();
  if (headerTitle) return headerTitle;

  // Secondary: Try sidebar entry matching the current chat ID.
  const chatId = window.location.pathname.match(/\/app\/([^/?]+)/)?.[1];
  if (chatId) {
    const conversationLinks = Array.from(
      document.querySelectorAll('[data-test-id="conversation"][href]'),
    ) as HTMLAnchorElement[];
    const matchedConversation = conversationLinks.find((link) => {
      const href = link.getAttribute("href") || "";
      return href === `/app/${chatId}` || href.endsWith(`/app/${chatId}`);
    });
    const matchedTitle = matchedConversation
      ?.querySelector(".conversation-title")
      ?.textContent?.trim();
    if (matchedTitle) return matchedTitle;
  }

  // Tertiary: Legacy selected selector (older Gemini UIs).
  const legacySelectedTitle = document
    .querySelector('div[data-test-id="conversation"].selected .conversation-title')
    ?.textContent?.trim();
  if (legacySelectedTitle) return legacySelectedTitle;

  // Final fallback: Generate title from first user message (userscript's logic)
  const firstUserQuery = document.querySelector(
    "user-query div.query-content, user-query .query-text",
  );
  const normalizedPrompt = firstUserQuery?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (normalizedPrompt) {
    return normalizedPrompt.substring(0, 100).trim();
  }

  return "Untitled Gemini Conversation";
}

// Wait for title to be populated (used during bulk sync)
async function waitForGeminiTitle(): Promise<void> {
  const maxAttempts = 10;
  const delay = 200; // Reduced from 300ms for faster polling
  let lastTitleText: string | null = null;
  let stableCount = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const titleEl = document.querySelector("div.conversation-title");
    const titleText = titleEl?.textContent?.trim() || null;

    // If we have a title element with text, check if it's stable
    if (titleText !== null) {
      if (titleText === lastTitleText) {
        stableCount++;
        // If the title has been stable for 2 consecutive checks, consider it ready
        if (stableCount >= 2) {
          return;
        }
      } else {
        // Title changed, reset stability counter
        stableCount = 0;
        lastTitleText = titleText;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // If we still don't have a stable title after waiting, proceed anyway
  log.warn("[Gemini] Title not stable after waiting, proceeding with extraction");
}

// Image extraction functions
function extractUserImages(element: Element): GeminiFileInfo[] {
  const files: GeminiFileInfo[] = [];
  const images = element.querySelectorAll("img");
  images.forEach((img) => {
    const src = (img as HTMLImageElement).src;
    if (src) {
      files.push({
        url: src,
        name: (img as HTMLImageElement).alt || undefined,
        type: "image",
      });
    }
  });
  return files;
}

function contentTypeFromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

/**
 * Extract images from assistant message using URL-only extraction.
 */
async function extractAssistantImages(element: Element): Promise<GeminiFileInfo[]> {
  const files: GeminiFileInfo[] = [];
  const seen = new Set<string>();

  // Extract generated image URLs.
  const generatedImages = element.querySelectorAll("generated-image");
  for (const genImg of generatedImages) {
    const imgElement = genImg.querySelector("img") as HTMLImageElement | null;
    if (!imgElement) continue;

    const src = imgElement.currentSrc || imgElement.src;
    if (!src || seen.has(src)) continue;
    seen.add(src);

    files.push({
      url: src,
      name: imgElement.alt || "generated-image",
      type: src.startsWith("data:") ? contentTypeFromDataUrl(src) || "image/png" : "image",
    });
    log.info("[Gemini] Extracted generated image URL");
  }

  // Also check for any other images not in generated-image containers.
  const standaloneImages = element.querySelectorAll("img");
  for (const imageNode of standaloneImages) {
    const img = imageNode as HTMLImageElement;
    const src = img.currentSrc || img.src;
    if (!src || seen.has(src)) continue;

    // Filter out UI icons.
    if (src.includes("data:image/svg") || src.includes("googleusercontent.com/icons")) {
      continue;
    }

    if (!img.closest("generated-image")) {
      seen.add(src);
      files.push({
        url: src,
        name: img.alt || undefined,
        type: src.startsWith("data:") ? contentTypeFromDataUrl(src) || "image/png" : "image",
      });
    }
  }
  return files;
}

// Message Extraction
export async function extractGeminiMessages(): Promise<GeminiMessage[]> {
  try {
    // Use userscript's direct selector approach: user-query, model-response
    const messageItems = Array.from(
      document.querySelectorAll("user-query, model-response"),
    ) as Element[];

    if (messageItems.length === 0) {
      log.warn("[Gemini] No message items found");
      return [];
    }

    const messages: GeminiMessage[] = [];
    let chatIndex = 1;
    // Track whether we've passed a deep-research plan response so we can attach
    // the report to the *completion* response that follows it, not the plan itself.
    let deepResearchPlanSeen = false;

    for (const item of messageItems) {
      const tagName = item.tagName.toLowerCase();
      let author: "user" | "assistant" = "assistant";
      let messageContentElem: HTMLElement | null = null;
      let files: GeminiFileInfo[] = [];

      if (tagName === "user-query") {
        author = "user";
        messageContentElem = item.querySelector("div.query-content") as HTMLElement | null;
        files = extractUserImages(item);
      } else if (tagName === "model-response") {
        author = "assistant";
        // Try multiple selectors for the main content - Gemini's DOM structure varies.
        // Prefer structured-content marked as model response text.
        messageContentElem = item.querySelector(
          "structured-content-container.model-response-text message-content",
        ) as HTMLElement | null;
        // Legacy selector.
        if (!messageContentElem) {
          messageContentElem = item.querySelector(
            "message-content.model-response-text",
          ) as HTMLElement | null;
        }
        // Fallback: choose the largest non-thinking message-content block.
        if (!messageContentElem) {
          const allContent = Array.from(item.querySelectorAll("message-content")) as HTMLElement[];
          const nonThoughtContent = allContent.filter((mc) => !mc.closest("model-thoughts"));
          if (nonThoughtContent.length > 0) {
            messageContentElem = nonThoughtContent.reduce((best, candidate) => {
              const bestLen = best?.innerText?.trim().length || 0;
              const candidateLen = candidate?.innerText?.trim().length || 0;
              return candidateLen > bestLen ? candidate : best;
            }, nonThoughtContent[0]);
          }
        }
        files = await extractAssistantImages(item);
      }

      // Extract thinking content FIRST (assistant only) - do this before skipping
      let thinking: string | undefined;
      if (tagName === "model-response") {
        const thinkingEl = item.querySelector("model-thoughts") as HTMLElement | null;
        if (thinkingEl) {
          const thinkingText = extractThinkingMarkdown(thinkingEl);
          if (thinkingText) {
            thinking = thinkingText;
            log.info(`[Gemini] Extracted thinking block (${thinkingText.length} chars)`);
          }
        }
      }

      // Get content text if we have a content element
      // Clone and remove thinking elements to avoid duplication
      let contentText = "";
      if (messageContentElem) {
        const contentClone = messageContentElem.cloneNode(true) as HTMLElement;
        // Search more broadly for anything related to thoughts/thinking and remove it
        const thoughtsElements = contentClone.querySelectorAll(
          "model-thoughts, .thoughts-container, [class*='thoughts'], [data-test-id*='thoughts']",
        );
        thoughtsElements.forEach((el) => {
          el.remove();
        });

        // Also remove any hidden elements that Gemini might use for metadata or duplication
        const hiddenElements = contentClone.querySelectorAll(
          "[hidden], [aria-hidden='true'], [style*='display: none']",
        );
        hiddenElements.forEach((el) => {
          el.remove();
        });

        contentText = turndownService.turndown(contentClone);
      }

      if (thinking && contentText && isLikelyDuplicateThinking(thinking, contentText)) {
        log.info("[Gemini] Assistant content duplicates thinking block; dropping duplicate text");
        contentText = "";
      }

      // Deep research: Gemini shows the research in two model-responses:
      //   1. Plan response — has `.research-steps` (the research questions/outline)
      //   2. Completion response — no `.research-steps`, follows the plan
      // The actual report lives in <deep-research-immersive-panel>, which is only
      // present after research completes. Attach it to the completion response.
      if (tagName === "model-response") {
        if (item.querySelector(".research-steps")) {
          deepResearchPlanSeen = true;
        } else if (
          deepResearchPlanSeen &&
          document.querySelector("deep-research-immersive-panel")
        ) {
          const reportContent = extractDeepResearchReport();
          if (reportContent) {
            log.info(`[Gemini] Appending deep research report (${reportContent.length} chars)`);
            contentText = contentText ? `${contentText}\n\n---\n\n${reportContent}` : reportContent;
          }
          deepResearchPlanSeen = false; // Reset so follow-up responses are unaffected
        }
      }

      if (contentText) {
        log.info(`[Gemini] contentText: ${contentText.substring(0, 100)}...`);
      }

      // Skip only if ALL content types are empty (no text, no files, no thinking)
      if (!contentText && files.length === 0 && !thinking) {
        log.warn(`[Gemini] Skipping message with no content, files, or thinking`);
        continue;
      }

      const ts = extractMessageTimestamp(item, messages.length);

      messages.push({
        index: chatIndex,
        content: contentText,
        timestamp: ts,
        localTime: formatLocalTime(ts),
        role: author,
        files: files,
        thinking: thinking,
      });

      if (author === "assistant") chatIndex++;
    }

    log.info(
      `[Gemini] Extracted ${messages.length} messages from ${messageItems.length} message items`,
    );
    return messages;
  } catch (error) {
    log.error("Error extracting Gemini messages:", error);
    return [];
  }
}

// Message timestamp extraction
function extractMessageTimestamp(element: Element, index: number): string {
  try {
    const timestampSelectors = [
      "time",
      "[data-timestamp]",
      ".timestamp",
      ".message-time",
      ".time",
      '[title*="AM"], [title*="PM"]',
      '[aria-label*="time"]',
    ];

    let timestampElement: Element | null = null;
    for (const selector of timestampSelectors) {
      timestampElement =
        element.querySelector(selector) ||
        element.closest(".message")?.querySelector(selector) ||
        element.parentElement?.querySelector(selector) ||
        null;
      if (timestampElement) break;
    }

    if (timestampElement) {
      const timeText =
        timestampElement.textContent ||
        timestampElement.getAttribute("datetime") ||
        timestampElement.getAttribute("title");
      if (timeText) {
        const parsed = new Date(timeText);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      }
    }

    // Fallback: generate estimated timestamp
    const baseTime = new Date();
    // We want timestamps to INCREASE with index to maintain proper order when sorted ascending.
    // We start 1 hour ago and add increments for each message.
    baseTime.setHours(baseTime.getHours() - 1);
    baseTime.setMinutes(baseTime.getMinutes() + index * 2);
    return baseTime.toISOString();
  } catch (_error) {
    const now = new Date();
    now.setHours(now.getHours() - 1);
    now.setMinutes(now.getMinutes() + index * 2);
    return now.toISOString();
  }
}

// Main extraction function
export async function extractGeminiConversationData(
  options: ExportOptions = {},
): Promise<GeminiConversationData> {
  if (!isGeminiPlatform()) {
    throw new Error("Not on a Gemini platform");
  }

  await waitForChatMessages();
  // Wait for title to be populated (important for bulk sync when navigating between chats)
  await waitForGeminiTitle();
  // Attempt to load earlier messages by scrolling the chat's infinite scroller upwards
  await loadAllGeminiMessagesUpwards();
  // Expand any collapsed user prompts so we capture full multi-line text
  await expandAllUserQueries();
  // Expand thinking blocks to capture internal reasoning
  await expandAllThinkingBlocks();

  const messages = await extractGeminiMessages();

  // Validation: ensure we actually extracted messages
  if (messages.length === 0) {
    throw new Error(
      "Failed to extract any messages from Gemini conversation. " +
        "The page structure may have changed or the conversation is empty.",
    );
  }

  log.info(`[Gemini] Successfully extracted ${messages.length} messages`);

  const convId = extractGeminiConversationId();
  const title = options.customTitle || extractGeminiConversationTitle();

  const data: GeminiConversationData = {
    platform: "gemini",
    url: window.location.href,
    conversationId: convId,
    title,
    messageCount: messages.length,
    messages,
    extractedAt: new Date().toISOString(),
  };

  log.info("Extracted Gemini conversation data:", data);
  return data;
}

async function waitForChatMessages(): Promise<void> {
  log.info("[Extractor] Waiting for chat messages to appear (with shadow DOM search)...");
  // Wait for user-query or model-response elements (userscript's approach)
  const selector = "user-query, model-response";
  const maxAttempts = 10; // Reduced from 15
  const delay = 500; // Reduced from 1000ms for faster polling

  for (let i = 0; i < maxAttempts; i++) {
    const messages = querySelectorAllDeep(selector);
    if (messages.length > 0) {
      log.info(
        `[Extractor] Found ${messages.length} message elements. Proceeding with extraction.`,
      );
      return;
    }
    log.info(`[Extractor] Attempt ${i + 1}/${maxAttempts}: No messages found yet, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timeout: Chat messages did not appear on the page.");
}

function querySelectorAllDeep(selector: string, root: Document | ShadowRoot = document): Element[] {
  const results: Element[] = [];
  const elements = root.querySelectorAll(selector);
  for (const el of elements) {
    results.push(el);
  }

  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    if (el.shadowRoot) {
      const nestedResults = querySelectorAllDeep(selector, el.shadowRoot);
      for (const nestedEl of nestedResults) {
        results.push(nestedEl);
      }
    }
  }

  return results;
}

// Simple text extraction (fallback method)
export function extractGeminiSimpleText(): string {
  try {
    const geminiMessages = document.querySelectorAll(
      '[data-testid*="message"], .conversation-turn, .message-content',
    );

    return Array.from(geminiMessages)
      .map((el) => el.textContent?.trim() || "")
      .filter((text) => text.length > 0)
      .join("\n\n");
  } catch (error) {
    log.error("Simple Gemini text extraction failed:", error);
    return "";
  }
}

// Removed export/download helpers; formatting is handled elsewhere.

// Identify and scroll the chat window's message scroller upwards to load older messages
async function loadAllGeminiMessagesUpwards(): Promise<void> {
  try {
    // Userscript's approach: Try primary selector first
    let scroller = document.querySelector(
      '[data-test-id="chat-history-container"]',
    ) as HTMLElement | null;

    // Fallback to our current selector
    if (!scroller) {
      scroller = document.querySelector(
        "chat-window-content infinite-scroller",
      ) as HTMLElement | null;
    }

    // Additional fallbacks from userscript
    if (!scroller) {
      scroller = document.querySelector("#chat-history") as HTMLElement | null;
    }
    if (!scroller) {
      scroller = document.querySelector("main") as HTMLElement | null;
    }
    if (!scroller) {
      scroller = document.documentElement;
    }

    if (!scroller) {
      log.warn("[Extractor] Could not find chat scroll container; skipping upward preload.");
      return;
    }

    log.info("[Extractor] Preloading earlier messages by scrolling up in chat scroller...");

    // Initial delay before starting scroll - reduced for faster sync
    await new Promise((resolve) => setTimeout(resolve, 500));

    let previousMessageCount = -1;
    let noChangeAttempts = 0;
    const maxAttempts = 40;
    const delay = 300; // Reduced from 500ms for faster iteration
    const AUTOSCROLL_MAT_PROGRESS_BAR_POLL_INTERVAL = 50;
    const AUTOSCROLL_MAT_PROGRESS_BAR_APPEAR_TIMEOUT = 1500; // Reduced from 3000ms - if no spinner shows in 1.5s, content is likely already loaded
    const AUTOSCROLL_MAT_PROGRESS_BAR_DISAPPEAR_TIMEOUT = 5000; // Keep this timeout to ensure content fully loads

    const waitForElementToAppear = async (
      selector: string,
      timeoutMs: number,
      checkInterval: number = AUTOSCROLL_MAT_PROGRESS_BAR_POLL_INTERVAL,
    ): Promise<Element | null> => {
      const startTime = Date.now();
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          const element = document.querySelector(selector);
          if (element) {
            clearInterval(interval);
            resolve(element);
          } else if (Date.now() - startTime > timeoutMs) {
            clearInterval(interval);
            resolve(null);
          }
        }, checkInterval);
      });
    };

    const waitForElementToDisappear = async (
      selector: string,
      timeoutMs: number,
      checkInterval: number = AUTOSCROLL_MAT_PROGRESS_BAR_POLL_INTERVAL,
    ): Promise<boolean> => {
      const startTime = Date.now();
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          const element = document.querySelector(selector);
          if (
            !element ||
            (element instanceof HTMLElement &&
              element.offsetWidth === 0 &&
              element.offsetHeight === 0)
          ) {
            clearInterval(interval);
            resolve(true);
          } else if (Date.now() - startTime > timeoutMs) {
            clearInterval(interval);
            log.warn(`waitForElementToDisappear: Timeout waiting for '${selector}' to disappear.`);
            resolve(false);
          }
        }, checkInterval);
      });
    };

    for (let i = 0; i < maxAttempts; i++) {
      // Scroll to top
      scroller.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay after scroll

      // Check for progress bar (userscript's approach)
      const progressBarElement = await waitForElementToAppear(
        "mat-progress-bar.mdc-linear-progress--indeterminate",
        AUTOSCROLL_MAT_PROGRESS_BAR_APPEAR_TIMEOUT,
      );

      if (progressBarElement) {
        noChangeAttempts = 0; // Reset retries if progress bar appeared
        // Wait for progress bar to disappear
        const disappeared = await waitForElementToDisappear(
          "mat-progress-bar.mdc-linear-progress--indeterminate",
          AUTOSCROLL_MAT_PROGRESS_BAR_DISAPPEAR_TIMEOUT,
        );
        if (!disappeared) {
          log.warn("[Extractor] mat-progress-bar did not disappear within expected time.");
        }
      } else {
        // If progress bar doesn't appear, increment retry count
        noChangeAttempts++;
        if (noChangeAttempts > 3) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Track message count changes (userscript's approach)
      const currentChatData = await extractGeminiMessages();
      const currentMessageCount = currentChatData ? currentChatData.length : 0;

      if (currentMessageCount > previousMessageCount) {
        previousMessageCount = currentMessageCount;
        noChangeAttempts = 0; // Reset retries if new messages found
      } else {
        // No new messages detected after a scroll attempt
        if (previousMessageCount !== -1) {
          // We had messages before, and now no new ones, it means we reached the top
          log.info("[Extractor] Reached top with no new content; stopping upward preload.");
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    log.info(`[Extractor] Auto-scroll complete. Final message count: ${previousMessageCount}`);
  } catch (err) {
    log.warn("[Extractor] loadAllGeminiMessagesUpwards encountered an error:", err);
  }
}

// Expand collapsed user query bubbles to reveal full text
async function expandAllUserQueries(): Promise<void> {
  try {
    let attempts = 0;
    const maxAttempts = 5;
    const delay = 150; // Reduced from 300ms for faster expansion
    while (attempts < maxAttempts) {
      const collapsedQueries = Array.from(
        document.querySelectorAll("user-query .query-text.collapsed"),
      ) as HTMLElement[];
      const expandButtons = Array.from(
        document.querySelectorAll("user-query .expand-button"),
      ) as HTMLElement[];
      if (collapsedQueries.length === 0 && expandButtons.length === 0) break;

      // Click visible expand buttons associated with collapsed queries first
      let clicked = 0;
      for (const btn of expandButtons) {
        // Only click if its related query looks collapsed
        const query = btn.closest("user-query")?.querySelector(".query-text") as HTMLElement | null;
        if (query?.classList.contains("collapsed")) {
          try {
            btn.click();
            clicked++;
          } catch (err: unknown) {
            log.warn("[Gemini] Failed to click expand button:", err);
          }
        }
      }

      // If no explicit buttons were found, try toggling by clicking the query container
      if (clicked === 0) {
        for (const q of collapsedQueries) {
          try {
            q.click();
            clicked++;
          } catch (err: unknown) {
            log.warn("[Gemini] Failed to click collapsed query:", err);
          }
        }
      }

      if (clicked === 0) break;
      attempts++;
      await new Promise((r) => setTimeout(r, delay));
    }
  } catch (err) {
    log.warn("[Extractor] expandAllUserQueries encountered an error:", err);
  }
}

/**
 * Expand all thinking blocks by clicking their toggle buttons.
 * Gemini uses <model-thoughts> elements with expand/collapse buttons.
 */
async function expandAllThinkingBlocks(): Promise<void> {
  try {
    log.info("[Extractor] Attempting to expand thinking blocks...");
    let attempts = 0;
    const maxAttempts = 3;
    const delay = 150; // Reduced from 300ms for faster expansion

    while (attempts < maxAttempts) {
      const thinkingElements = Array.from(
        document.querySelectorAll("model-thoughts"),
      ) as HTMLElement[];

      if (thinkingElements.length === 0) {
        log.info("[Extractor] No thinking blocks found");
        break;
      }

      let clicked = 0;

      for (const thinkingEl of thinkingElements) {
        // Check if already expanded (has collapse icon)
        const collapseIcon = thinkingEl.querySelector('mat-icon[fonticon="expand_less"]');
        if (collapseIcon) {
          continue; // Already expanded
        }

        // Find and click expand button
        const expandButton = thinkingEl.querySelector("button") as HTMLElement | null;
        if (expandButton) {
          try {
            expandButton.click();
            clicked++;
          } catch (err) {
            log.warn("[Extractor] Failed to click thinking button:", err);
          }
        }
      }

      if (clicked === 0) break; // No more collapsed blocks

      attempts++;
      await new Promise((r) => setTimeout(r, delay));
    }

    log.info("[Extractor] Thinking block expansion complete");
  } catch (err) {
    log.warn("[Extractor] expandAllThinkingBlocks encountered an error:", err);
  }
}

export async function extractGeminiChatIds(): Promise<string[]> {
  log.info("[Extractor] Starting chat ID extraction process...");

  const findSidebarHistoryScroller = (): HTMLElement | null => {
    // Prefer the scroller that actually wraps the Chats list.
    const conversationsRoot = querySelectorAllDeep('[data-test-id="all-conversations"]')[0];
    if (conversationsRoot) {
      const scopedScroller = conversationsRoot.closest("infinite-scroller") as HTMLElement | null;
      if (scopedScroller) return scopedScroller;
    }

    // Fallback: choose the infinite-scroller that contains conversation entries.
    const candidates = Array.from(document.querySelectorAll("infinite-scroller")) as HTMLElement[];
    const byContent = candidates.find((el) =>
      Boolean(
        el.querySelector('[data-test-id="all-conversations"], [data-test-id="conversation"]'),
      ),
    );
    if (byContent) return byContent;

    return candidates[0] || null;
  };

  // The scrollable container in Gemini's sidebar is <infinite-scroller>,
  // but there can be multiple scrollers in the page. We must pick the one
  // containing the conversation history list.
  let scrollContainer = findSidebarHistoryScroller();

  // If not found, try to open the sidebar first
  if (!scrollContainer) {
    const menuButton = (document.querySelector('[data-test-id="side-nav-menu-button"]') ||
      document.querySelector("button.main-menu-button")) as HTMLElement | null;
    if (menuButton) {
      log.info("[Extractor] Sidebar may be closed. Clicking menu button to open it.");
      menuButton.click();
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for sidebar animation
      scrollContainer = findSidebarHistoryScroller();
    }
  }

  if (!scrollContainer) {
    log.error("[Extractor] Could not find the scrollable container.");
    return [];
  }
  log.info(
    "[Extractor] Using scroll container:",
    scrollContainer.tagName,
    scrollContainer.className || scrollContainer.id || "",
  );

  const waitForSidebarGrowth = async (
    previousScrollHeight: number,
    previousVisibleEntryCount: number,
    timeoutMs: number = 2500,
  ): Promise<void> => {
    const startTime = Date.now();
    const pollInterval = 100;

    // Give Gemini a brief moment to schedule lazy-loading work.
    await new Promise((resolve) => setTimeout(resolve, 200));

    while (Date.now() - startTime < timeoutMs) {
      const currentScrollHeight = scrollContainer.scrollHeight;
      const currentVisibleEntryCount = querySelectorAllDeep('[data-test-id="conversation"]').length;

      if (
        currentScrollHeight > previousScrollHeight ||
        currentVisibleEntryCount > previousVisibleEntryCount
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  };

  const chatIds = new Set<string>();
  let lastIdCount = 0;
  let attempts = 0;
  let noNewIdsAttempts = 0;
  let stableScrollHeightAttempts = 0;
  const maxAttempts = 100; // Generous attempt limit for large histories
  const scrollDelay = 300; // Reduced from 500ms for faster scrolling

  log.info("[Extractor] Starting patient scroll loop...");

  while (attempts < maxAttempts) {
    // Extract any visible conversation entries for IDs embedded in jslog
    // Use deep selector to find elements in shadow DOMs
    const entries = querySelectorAllDeep('[data-test-id="conversation"]');
    log.debug(`[Extractor] Attempt ${attempts + 1}: Found ${entries.length} conversation entries`);

    let newIdsThisIteration = 0;
    entries.forEach((entry, index) => {
      const jslog = entry.getAttribute("jslog") || "";
      log.debug(
        `[Extractor] Entry ${index + 1}: jslog="${jslog.substring(0, 100)}${
          jslog.length > 100 ? "..." : ""
        }"`,
      );

      // Extract chat ID from jslog
      // Chat IDs appear in BardVeMetadataKey array like: ["c_ecf1933591324c9...",null,0,111]
      // We need to avoid matching "c_click" from "generic_click"
      // Strategy: First try to find ID in BardVeMetadataKey context, then fallback to general search
      // IMPORTANT: Strip 'c_' prefix immediately - real IDs never have the prefix
      let foundId = false;
      const falsePositives = new Set(["c_click", "c_track", "c_generic", "c_action"]);

      // Try to find ID in BardVeMetadataKey array context (more reliable)
      // Pattern: BardVeMetadataKey:[...,[\"c_...\",...]]
      // Look for ["c_ pattern after BardVeMetadataKey
      const bardIndex = jslog.indexOf("BardVeMetadataKey:");
      if (bardIndex !== -1) {
        const afterBard = jslog.substring(bardIndex);
        // More robust regex: require c_ prefix, allow underscores in ID
        const arrayMatch = afterBard.match(/\["c_([a-zA-Z0-9_]{8,})"/);
        if (arrayMatch?.[1]) {
          const id = arrayMatch[1]; // ID without c_ prefix
          const rawId = `c_${id}`; // Reconstruct for validation
          if (id.length >= 8 && !falsePositives.has(rawId)) {
            const wasNew = !chatIds.has(id);
            chatIds.add(id);
            if (wasNew) {
              newIdsThisIteration++;
              log.debug(`[Extractor] ✓ Extracted new ID from BardVeMetadataKey: ${id}`);
              foundId = true;
            } else {
              log.debug(`[Extractor] - Skipped duplicate ID: ${id}`);
              foundId = true;
            }
          }
        }
      }

      // Fallback: general pattern matching if BardVeMetadataKey didn't work
      if (!foundId) {
        // More robust pattern: c_ followed by alphanumeric + underscores
        const matches = jslog.matchAll(/c_([a-zA-Z0-9_]{8,})/g);
        for (const match of matches) {
          const id = match[1]; // ID without c_ prefix
          const rawId = `c_${id}`;
          // Filter out known false positives and require minimum reasonable length
          if (id.length >= 8 && !falsePositives.has(rawId)) {
            const wasNew = !chatIds.has(id);
            chatIds.add(id);
            if (wasNew) {
              newIdsThisIteration++;
              log.debug(`[Extractor] ✓ Extracted new ID: ${id}`);
              foundId = true;
            } else {
              log.debug(`[Extractor] - Skipped duplicate ID: ${id}`);
              foundId = true;
            }
            break; // Take the first valid match
          }
        }
      }

      if (!foundId) {
        log.debug(`[Extractor] ✗ No valid chat ID found in jslog for entry ${index + 1}`);
      }
    });

    const currentIdCount = chatIds.size;
    log.info(
      `[Extractor] Attempt ${
        attempts + 1
      }/${maxAttempts}: Total IDs=${currentIdCount}, New this iteration=${newIdsThisIteration}, NoNewIdsTries=${noNewIdsAttempts}`,
    );

    // Check if we're making progress (finding new IDs)
    if (currentIdCount === lastIdCount) {
      noNewIdsAttempts++;
      log.info("[Extractor] No new IDs found. Incrementing noNewIdsAttempts.");
    } else {
      noNewIdsAttempts = 0; // Reset counter if we found new IDs
      lastIdCount = currentIdCount;
    }

    // Scroll to bottom to trigger more content loading
    const previousScrollHeight = scrollContainer.scrollHeight;
    const previousScrollTop = scrollContainer.scrollTop;
    const previousVisibleEntryCount = entries.length;
    try {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    } catch (err: unknown) {
      log.warn("[Gemini] Failed to scroll chat list container:", err);
    }
    attempts++;

    // Gemini's loading spinner element may remain mounted continuously.
    // Wait for concrete signals instead: sidebar growth or additional entries.
    await waitForSidebarGrowth(previousScrollHeight, previousVisibleEntryCount, 2500);

    // Additional delay to ensure DOM is updated
    await new Promise((resolve) => setTimeout(resolve, scrollDelay));

    const currentScrollHeight = scrollContainer.scrollHeight;
    const currentScrollTop = scrollContainer.scrollTop;
    const scrollHeightChanged = currentScrollHeight > previousScrollHeight;
    const scrollMoved = currentScrollTop > previousScrollTop;

    if (scrollHeightChanged) {
      stableScrollHeightAttempts = 0;
      noNewIdsAttempts = 0;
    } else {
      stableScrollHeightAttempts++;
    }

    // Stop only after both signals stall: no new IDs and no growth in scrollable content.
    if (noNewIdsAttempts >= 6 && stableScrollHeightAttempts >= 4 && !scrollMoved) {
      log.info(
        "[Extractor] No new IDs and no scroll growth for multiple attempts. Ending scroll loop.",
      );
      break;
    }
  }

  log.info(`[Extractor] Finished scrolling after ${attempts} attempts.`);
  log.info(`[Extractor] Extracted a total of ${chatIds.size} unique chat IDs.`);

  const finalIds = Array.from(chatIds);
  if (finalIds.length > 0) {
    log.info(`[Extractor] Found chat IDs:`, finalIds);
  } else {
    log.warn("[Extractor] Warning: No chat IDs were extracted.");
    // Final attempt to find entries without scrolling
    log.info("[Extractor] Performing final scan of all conversation entries...");
    const finalEntries = querySelectorAllDeep('[data-test-id="conversation"]');
    log.debug(`[Extractor] Final scan found ${finalEntries.length} conversation entries`);
    finalEntries.forEach((entry, index) => {
      const jslog = entry.getAttribute("jslog") || "";
      log.debug(`[Extractor] Final entry ${index + 1}: jslog="${jslog}"`);
      // Use the same improved extraction logic with normalization
      const falsePositives = new Set(["c_click", "c_track", "c_generic"]);

      // Try BardVeMetadataKey context first
      // Pattern: BardVeMetadataKey:[...,["c_...",...]]
      const bardIndex = jslog.indexOf("BardVeMetadataKey:");
      if (bardIndex !== -1) {
        const afterBard = jslog.substring(bardIndex);
        const arrayMatch = afterBard.match(/\["([c_][a-zA-Z0-9]{8,})"/);
        if (arrayMatch?.[1]) {
          const rawId = arrayMatch[1];
          // Strip 'c_' prefix to get the real ID
          const id = rawId.startsWith("c_") ? rawId.substring(2) : rawId;
          if (id.length >= 8 && !falsePositives.has(rawId)) {
            chatIds.add(id);
            log.debug(
              `[Extractor] Final scan extracted from BardVeMetadataKey: ${id} (normalized from ${rawId})`,
            );
          }
        }
      } else {
        // Fallback to general pattern
        const matches = jslog.matchAll(/c_[a-zA-Z0-9]{8,}/g);
        for (const match of matches) {
          const rawId = match[0];
          // Strip 'c_' prefix to get the real ID
          const id = rawId.startsWith("c_") ? rawId.substring(2) : rawId;
          if (id.length >= 8 && !falsePositives.has(rawId)) {
            chatIds.add(id);
            log.debug(`[Extractor] Final scan extracted: ${id} (normalized from ${rawId})`);
            break; // Take the first valid match
          }
        }
      }
    });
    const finalFinalIds = Array.from(chatIds);
    log.info(`[Extractor] After final scan: ${finalFinalIds.length} total IDs`);
    return finalFinalIds;
  }

  return finalIds;
}
