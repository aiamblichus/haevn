// Gemini Chat Extraction - TypeScript Functions

import { log } from "../../utils/logger";
import { charsOf } from "../../utils/logShape";
import { fetchWithTimeout } from "../../utils/network_utils";
import { detectPlatform } from "../shared/platformDetector";
import { formatLocalTime, generateFallbackId } from "../shared_utils";
import type { GeminiConversationData, GeminiFileInfo, GeminiMessage } from "./model";

// esbuild bundles these two CommonJS packages with require(). Neither ships types and the DOM
// lib has no `require`, so declare the little of each that is used here.
declare function require(id: "turndown"): new () => {
  use(plugin: unknown): void;
  turndown(node: Node | string): string;
};
declare function require(id: "@joplin/turndown-plugin-gfm"): { gfm: unknown };

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
  for (const el of uiElements) el.remove();

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
  for (const el of clone.querySelectorAll(
    "button, mat-icon, [role='button'], canvas-create-button-container",
  )) {
    el.remove();
  }

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

/**
 * Text the page keeps for a screen reader and shows no one. A user turn carries its prompt a
 * second time in one of these, behind the words "You said"; the visible lines are the prompt.
 */
const SCREEN_READER_ONLY = ".cdk-visually-hidden, .screen-reader-user-query-label";

/** The element's text without its screen-reader-only labels. */
function visibleTextOf(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(SCREEN_READER_ONLY).forEach((el) => {
    el.remove();
  });
  return clone.textContent ?? "";
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
  const normalizedPrompt = (firstUserQuery ? visibleTextOf(firstUserQuery) : "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalizedPrompt) {
    return normalizedPrompt.substring(0, 100).trim();
  }

  return "Untitled Gemini Conversation";
}

// Image extraction functions

/**
 * What one extraction may inline as data URLs, in characters. The chat travels from the page to the
 * service worker, and on to the offscreen document, as one message each time: Chrome refuses one
 * past 64 MB, and `messageSafety` counts two bytes a character against 60 MB. 28M characters
 * (about 15 generated images of 1024 px) stays under both with the chat's text beside them.
 *
 * Images past the budget, in page order (so the newest of a long image chat), keep their `blob:`
 * URL: the sync stores that as an `image-url` part that will not load, as it did before inlining
 * existed, and a re-sync does the same. A chat of more images than this needs smaller messages,
 * not a bigger budget.
 */
const INLINE_IMAGE_BUDGET_CHARS = 28 * 1024 * 1024;

/** A blob is local, so a decode that takes longer is stuck; the extraction must not wait on it. */
const IMAGE_DECODE_TIMEOUT_MS = 5000;

interface InlineBudget {
  remaining: number;
}

function contentTypeFromDataUrl(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

function fileTypeOf(src: string): string {
  return src.startsWith("data:") ? contentTypeFromDataUrl(src) || "image/png" : "image";
}

/**
 * The image drawn on a canvas, as a PNG data URL; null when it is not loaded or cannot be drawn.
 * Pixels are the one thing of a `blob:` image still readable from outside the page: its CSP
 * refuses a `fetch` of the blob, and the URL means nothing once the page is gone.
 */
async function drawToDataUrl(img: HTMLImageElement): Promise<string | null> {
  try {
    if (!img.complete) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("decode timed out")), IMAGE_DECODE_TIMEOUT_MS);
      });
      await Promise.race([img.decode(), timedOut]).finally(() => clearTimeout(timer));
    }
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    // A canvas past the browser's size limit answers "data:," (an empty file), not an error
    return dataUrl.startsWith("data:image/png") ? dataUrl : null;
  } catch (error) {
    log.warn("[Gemini] Could not read a blob image from the page:", error);
    return null;
  }
}

/**
 * Where the image's bytes can be had once the page is gone. A `blob:` source becomes a data URL
 * (the sync stores it like any download, with no tab); another source is returned as it is. A blob
 * that cannot be read, or that no longer fits the budget, is returned as it is too: the sync then
 * keeps the URL, as it did before.
 */
async function inlineBlobImage(
  img: HTMLImageElement,
  src: string,
  budget: InlineBudget,
): Promise<string> {
  if (!src.startsWith("blob:")) return src;
  const dataUrl = await drawToDataUrl(img);
  if (!dataUrl) return src;
  if (dataUrl.length > budget.remaining) {
    log.warn("[Gemini] A blob image is left out of the sync: this chat's inline images are full");
    return src;
  }
  budget.remaining -= dataUrl.length;
  return dataUrl;
}

async function extractUserImages(
  element: Element,
  budget: InlineBudget,
): Promise<GeminiFileInfo[]> {
  const files: GeminiFileInfo[] = [];
  for (const imageNode of Array.from(element.querySelectorAll("img"))) {
    const img = imageNode as HTMLImageElement;
    if (!img.src) continue;
    const url = await inlineBlobImage(img, img.src, budget);
    files.push({ url, name: img.alt || undefined, type: fileTypeOf(url) });
  }
  return files;
}

/**
 * Extract images from assistant message using URL-only extraction.
 */
async function extractAssistantImages(
  element: Element,
  budget: InlineBudget,
): Promise<GeminiFileInfo[]> {
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

    const url = await inlineBlobImage(imgElement, src, budget);
    files.push({
      url,
      name: imgElement.alt || "generated-image",
      type: fileTypeOf(url),
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
      const url = await inlineBlobImage(img, src, budget);
      files.push({
        url,
        name: img.alt || undefined,
        type: fileTypeOf(url),
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
    const budget: InlineBudget = { remaining: INLINE_IMAGE_BUDGET_CHARS };
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
        files = await extractUserImages(item, budget);
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
        files = await extractAssistantImages(item, budget);
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
          `[hidden], [aria-hidden='true'], [style*='display: none'], ${SCREEN_READER_ONLY}`,
        );
        hiddenElements.forEach((el) => {
          el.remove();
        });

        // An image is a file of the message (it is stored, and the viewer shows it among the
        // attachments), not text: left in, turndown writes it as `![alt](src)`, and a `blob:`
        // src means nothing outside the page.
        contentClone.querySelectorAll("generated-image, img[src^='blob:']").forEach((el) => {
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
        log.info(`[Gemini] contentText: ${charsOf(contentText)}`);
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

  log.info("Extracted Gemini conversation data:", {
    conversationId: data.conversationId,
    title: charsOf(data.title),
    messageCount: data.messageCount,
  });
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

/**
 * Gemini's chat ids are 16 characters once the "c_" prefix of the attribute is removed (HVN-116).
 * Anything else is not an id: a link to /app/settings is not one.
 */
const GEMINI_CHAT_ID = /^[A-Za-z0-9_-]{16}$/;

/** A conversation id without its "c_" prefix, or null when the text is not one. */
function bareConversationId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.startsWith("c_") ? raw.slice(2) : raw;
  return GEMINI_CHAT_ID.test(id) ? id : null;
}

/**
 * The chat id of one sidebar entry (HVN-116). Gemini puts it on the entry as data-conversation-id
 * ("c_" and the id), and in the /app/<id> link inside the entry. It no longer appears in jslog.
 * Null when neither gives a valid id.
 */
export function geminiChatIdOf(
  entry: Pick<Element, "getAttribute" | "querySelector">,
): string | null {
  const fromAttribute = bareConversationId(entry.getAttribute("data-conversation-id"));
  if (fromAttribute) return fromAttribute;
  const href = entry.querySelector("a[href]")?.getAttribute("href");
  return bareConversationId(href?.match(/\/app\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1]);
}

/**
 * Gemini's own chat-list RPC (HVN-16). The sidebar list is gone (the list now lives in a search
 * modal that loads only in a visible tab), but the batchexecute call that filled it still answers,
 * in a hidden tab too. Undocumented: this block is the one place to edit when Gemini changes it.
 * A page holds up to `pageSize` chats (more is ignored), and the response carries the token of the
 * next page until the last, which has none.
 */
const GEMINI_LIST_RPC = {
  url: "/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp&hl=en&rt=c",
  rpcId: "MaZiqc",
  pageSize: 100,
  // 50 pages of 100 is 5,000 chats.
  maxPages: 50,
  timeoutMs: 30000,
} as const;

/** The anti-forgery token the RPC needs (`at`), as it sits in an inline script of the page. */
const GEMINI_AT_TOKEN = /"SNlM0e":"([^"]+)"/;

/**
 * The `at` token of the page. The content script cannot read the page's WIZ_global_data (isolated
 * world), but the inline script that sets it is in the DOM.
 */
function findGeminiAtToken(): string {
  for (const script of Array.from(document.scripts)) {
    const token = script.textContent?.match(GEMINI_AT_TOKEN)?.[1];
    if (token) return token;
  }
  throw new Error("Gemini's chat list: the request token (SNlM0e) was not found in the page");
}

/** One page of the list: the chat ids in order, and the token of the next page, if any. */
interface GeminiChatListPage {
  ids: string[];
  nextToken: string | null;
}

/**
 * Read a batchexecute response. It is chunk-framed: a )]}' line, then length lines each followed by
 * a JSON array of envelopes. The one for the list RPC is ["wrb.fr", "MaZiqc", "<json string>", ...]
 * and its string is [null, <next token | null>, [entry, ...]], an entry's slot 0 being "c_<id>".
 * Anything else throws: a short list must never look whole (HVN-116).
 */
function parseGeminiChatListPage(text: string): GeminiChatListPage {
  let payload: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("[")) continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk)) continue;
    const envelope = chunk.find(
      (item) => Array.isArray(item) && item[0] === "wrb.fr" && item[1] === GEMINI_LIST_RPC.rpcId,
    );
    if (envelope) {
      payload = envelope[2];
      break;
    }
  }
  if (typeof payload !== "string") {
    throw new Error("Gemini's chat list: the response has no list envelope (wrb.fr MaZiqc)");
  }

  let inner: unknown;
  try {
    inner = JSON.parse(payload);
  } catch {
    throw new Error("Gemini's chat list: the list envelope does not hold JSON");
  }
  if (!Array.isArray(inner) || (inner[2] != null && !Array.isArray(inner[2]))) {
    throw new Error("Gemini's chat list: the list envelope is not [null, token, entries]");
  }

  const entries: unknown[] = inner[2] ?? [];
  const ids: string[] = [];
  for (const entry of entries) {
    const id = bareConversationId(Array.isArray(entry) ? entry[0] : null);
    if (id) ids.push(id);
  }
  if (entries.length > 0 && ids.length === 0) {
    // Entries are there and none gave an id: the shape has moved (HVN-116).
    throw new Error(
      `Gemini's chat list: the response has ${entries.length} entries but none carries a chat id`,
    );
  }
  return { ids, nextToken: typeof inner[1] === "string" ? inner[1] : null };
}

async function fetchGeminiChatListPage(
  atToken: string,
  pageToken: string | null,
): Promise<GeminiChatListPage> {
  const rpcPayload = JSON.stringify([GEMINI_LIST_RPC.pageSize, pageToken, [0, null, 1]]);
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[GEMINI_LIST_RPC.rpcId, rpcPayload, null, "generic"]]]),
    at: atToken,
  });
  const response = await fetchWithTimeout(GEMINI_LIST_RPC.url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
    timeoutMs: GEMINI_LIST_RPC.timeoutMs,
  });
  if (!response.ok) {
    throw new Error(`Gemini's chat list: the list request failed: ${response.status}`);
  }
  return parseGeminiChatListPage(await response.text());
}

/**
 * The chat ids that Gemini's rail shows. The rail holds only the latest chats, so it is a floor for
 * the list, not the list (HVN-16).
 */
function railChatIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of querySelectorAllDeep('[data-test-id="conversation"][data-conversation-id]')) {
    const id = geminiChatIdOf(entry);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Every chat id of the account, from Gemini's list RPC, without its "c_" prefix. Throws when it
 * cannot read a whole list: no token, a failed request, an envelope that is not the list's, or fewer
 * chats than the rail shows.
 */
export async function extractGeminiChatIds(): Promise<string[]> {
  log.info("[Extractor] Listing Gemini chats through the list RPC...");
  const atToken = findGeminiAtToken();

  const chatIds = new Set<string>();
  let pageToken: string | null = null;
  let pages = 0;
  do {
    const page = await fetchGeminiChatListPage(atToken, pageToken);
    pages++;
    for (const id of page.ids) chatIds.add(id);
    log.info(`[Extractor] Page ${pages}: ${page.ids.length} chats, ${chatIds.size} in total`);
    pageToken = page.nextToken;
  } while (pageToken && pages < GEMINI_LIST_RPC.maxPages);

  if (pageToken) {
    log.warn(
      `[Extractor] Gemini's chat list has more than ${pages} pages: stopped at ${chatIds.size} chats.`,
    );
  }

  const rail = railChatIds();
  if (chatIds.size < rail.size) {
    throw new Error(
      `Gemini's chat list: the list holds ${chatIds.size} chats but the sidebar shows ${rail.size}`,
    );
  }
  return Array.from(chatIds);
}
