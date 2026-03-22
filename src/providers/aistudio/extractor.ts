// AI Studio Chat Extraction
// NOTE: AI Studio uses virtualized rendering and lazy-loaded content.
// The extractor must scroll turns into view and expand collapsed panels to access content.

import { log } from "../../utils/logger";
import { detectPlatform } from "../shared/platformDetector";
import type {
  AIStudioCodeBlock,
  AIStudioConversationData,
  AIStudioFileInfo,
  AIStudioMessage,
} from "./model";

const SELECTORS = {
  title: ".page-title h1",
  turn: "ms-chat-turn",
  scrollContainer: "ms-autoscroll-container",
  userContainer: '.user-prompt-container[data-turn-role="User"]',
  modelContainer: ".model",
  // Content elements (render only when visible due to virtualization)
  textChunk: "ms-text-chunk",
  promptChunk: "ms-prompt-chunk",
  cmarkNode: "ms-cmark-node",
  // Thinking blocks
  thinkingContainer: "ms-thought-chunk",
  thinkingPanel: "mat-expansion-panel",
  thinkingPanelHeader: "mat-expansion-panel-header",
  thinkingPanelExpanded: "mat-expanded",
  // Files
  userFileChunk: "ms-file-chunk",
  imageChunk: "ms-image-chunk",
  userFileThumb: ".thumbnail-img",
  userFileName: ".file-chunk-container .name",
  loadedImage: ".loaded-image",
  // Code blocks
  codeBlock: "ms-code-block pre code",
  codeHeaderTitleText: ".mat-expansion-panel-header-title span:not(.title-icon)",
  // System instructions
  systemInstructionsPanel: "ms-system-instructions-panel",
  systemInstructionsSubtitle: "span.subtitle",
  // Other
  image: "img",
  videoSource: "video source",
  modelName: 'ms-model-selector-v3 [data-test-id="model-name"]',
  authorLabel: ".author-label",
  searchEntryPoint: "ms-search-entry-point",
  promptRunSettings: "ms-prompt-run-settings",
  // UI elements to filter out
  uiIconClasses: ["thinking-progress-icon"],
  // Library page selectors (for bulk sync)
  libraryScrollContainer: ".lib-table-wrapper",
  libraryTableRow: "tr.mat-mdc-row",
  libraryChatLink: "a.name-btn",
  libraryTypeColumn: "td.mat-column-type",
  libraryUpdatedColumn: "td.mat-column-updated",
};

function isNonContentAssistantImage(imgEl: HTMLImageElement): boolean {
  // Skip UI icons (like the thinking progress icon)
  if (SELECTORS.uiIconClasses.some((cls) => imgEl.classList.contains(cls))) return true;
  // Skip Google's watermark/thinking icon by URL pattern
  if (imgEl.src.includes("gstatic.com/aistudio/watermark")) return true;
  // Skip material icons
  if (imgEl.closest("mat-icon")) return true;

  // Exclude Grounding UI artifacts (e.g., Google Search Suggestions logos/chips)
  const nonContentContainers = [
    SELECTORS.searchEntryPoint,
    SELECTORS.promptRunSettings,
    ".search-entry-point",
    ".search-entry-container",
    ".settings-item.settings-tool",
    ".item-about-search",
    ".grounding-source",
  ];
  if (nonContentContainers.some((selector) => !!imgEl.closest(selector))) return true;

  return false;
}

// Platform Detection
export function isAIStudioPlatform(): boolean {
  return detectPlatform({
    hostnames: ["aistudio.google.com"],
  });
}

// Conversation ID Extraction
export function extractAIStudioConversationId(): string {
  const pathname = window.location.pathname;
  // URL pattern: /prompts/{chatId}
  const match = pathname.match(/\/prompts\/([^/?]+)/);
  if (match?.[1]) {
    return match[1];
  }
  throw new Error(`Could not extract AI Studio conversation ID from URL: ${pathname}`);
}

// Title Extraction
export function extractAIStudioConversationTitle(): string {
  try {
    const titleElement = document.querySelector(SELECTORS.title) as HTMLElement | null;
    if (!titleElement) {
      return "Untitled AI Studio Conversation";
    }
    return titleElement.textContent?.trim() || "Untitled AI Studio Conversation";
  } catch (error) {
    log.error("Error extracting AI Studio title:", error);
    return "Untitled AI Studio Conversation";
  }
}

// Model Name Extraction
export function extractAIStudioModelName(): string | undefined {
  try {
    const modelElement = document.querySelector(SELECTORS.modelName) as HTMLElement | null;
    return modelElement?.textContent?.trim() || undefined;
  } catch (error) {
    log.error("Error extracting AI Studio model name:", error);
    return undefined;
  }
}

// The placeholder shown when no system instructions are set.
// We must filter this out to avoid storing it as real content.
const SYSTEM_INSTRUCTIONS_PLACEHOLDER = "Optional tone and style instructions for the model";

// System Instructions Extraction
export function extractAIStudioSystemInstructions(): string | undefined {
  try {
    const panel = document.querySelector(SELECTORS.systemInstructionsPanel);
    if (!panel) return undefined;
    const subtitle = panel.querySelector(
      SELECTORS.systemInstructionsSubtitle,
    ) as HTMLElement | null;
    // Use textContent (not innerText): innerText returns empty for all elements in background
    // tabs due to Chrome's rendering throttling, while textContent is CSS-independent.
    const text = subtitle?.textContent?.trim();
    if (!text || text === SYSTEM_INSTRUCTIONS_PLACEHOLDER) return undefined;
    return text;
  } catch (error) {
    log.error("Error extracting AI Studio system instructions:", error);
    return undefined;
  }
}

// Helper: wait for DOM to settle after scroll/click
function waitForRender(ms: number = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scroll a turn into view and wait for content to render
async function scrollTurnIntoView(turnEl: Element): Promise<void> {
  turnEl.scrollIntoView({ behavior: "instant", block: "center" });
  await waitForRender(100);
}

// Expand thinking panel if collapsed
async function expandThinkingIfNeeded(turnEl: Element): Promise<void> {
  const thinkingContainer = turnEl.querySelector(SELECTORS.thinkingContainer);
  if (!thinkingContainer) return;

  const panel = thinkingContainer.querySelector(SELECTORS.thinkingPanel);
  if (!panel) return;

  // Check if already expanded
  if (panel.classList.contains(SELECTORS.thinkingPanelExpanded)) return;

  // Click the header to expand
  const header = panel.querySelector(SELECTORS.thinkingPanelHeader) as HTMLElement | null;
  if (header) {
    header.click();
    await waitForRender(200); // Wait for expansion animation
  }
}

// Extract user message from a turn (must be called after scrolling into view)
function extractUserFromTurn(turnEl: Element): {
  text: string;
  files: AIStudioFileInfo[];
} {
  const container = turnEl.querySelector(SELECTORS.userContainer) as HTMLElement | null;
  if (!container) {
    return { text: "", files: [] };
  }

  // Extract text from ms-text-chunk elements (the actual content)
  const textChunks = container.querySelectorAll(SELECTORS.textChunk);
  const textParts: string[] = [];
  textChunks.forEach((chunk) => {
    const text = (chunk as HTMLElement).innerText?.trim();
    if (text) {
      textParts.push(text);
    }
  });
  const text = textParts.join("\n\n");

  // Extract files (images, attachments)
  const files: AIStudioFileInfo[] = [];

  // File chunks with thumbnails
  container.querySelectorAll(SELECTORS.userFileChunk).forEach((chunk) => {
    const img = chunk.querySelector(SELECTORS.userFileThumb) as HTMLImageElement | null;
    const nameEl = chunk.querySelector(SELECTORS.userFileName) as HTMLElement | null;
    if (img?.src) {
      files.push({
        url: img.src,
        name: nameEl?.textContent?.trim() || undefined,
        type: img.alt === "file thumbnail" ? undefined : "image/*",
      });
    }
  });

  // Image chunks (uploaded images)
  container.querySelectorAll(SELECTORS.imageChunk).forEach((chunk) => {
    const img = chunk.querySelector(SELECTORS.loadedImage) as HTMLImageElement | null;
    if (img?.src && !img.src.startsWith("data:")) {
      files.push({
        url: img.src,
        name: img.alt || undefined,
        type: "image/*",
      });
    }
  });

  return { text, files };
}

// Extract assistant message from a turn (must be called after scrolling and expanding)
function extractAssistantFromTurn(turnEl: Element): {
  text: string;
  codeBlocks: AIStudioCodeBlock[];
  mediaFiles: AIStudioFileInfo[];
  thinking?: string;
} {
  const scope = turnEl as HTMLElement;

  // Check if this is a model turn
  const hasModelContainer = !!scope.querySelector(SELECTORS.modelContainer);
  if (!hasModelContainer) {
    return { text: "", codeBlocks: [], mediaFiles: [] };
  }

  const thinkingContainer = scope.querySelector(SELECTORS.thinkingContainer);

  // Extract thinking content from ms-thought-chunk
  let thinking: string | undefined;
  if (thinkingContainer) {
    // Get ms-text-chunk content inside thinking container
    const thinkingTextChunks = thinkingContainer.querySelectorAll(SELECTORS.textChunk);
    const thinkingParts: string[] = [];
    thinkingTextChunks.forEach((chunk) => {
      const text = (chunk as HTMLElement).innerText?.trim();
      if (text) {
        thinkingParts.push(text);
      }
    });
    thinking = thinkingParts.join("\n\n") || undefined;
  }

  // Extract response text from ms-text-chunk NOT inside thinking container
  const allTextChunks = scope.querySelectorAll(SELECTORS.textChunk);
  const responseTextParts: string[] = [];
  allTextChunks.forEach((chunk) => {
    // Skip if inside thinking container
    if (thinkingContainer?.contains(chunk)) return;
    // Skip if inside user container
    if (chunk.closest(SELECTORS.userContainer)) return;

    const text = (chunk as HTMLElement).innerText?.trim();
    if (text) {
      responseTextParts.push(text);
    }
  });
  const text = responseTextParts.join("\n\n");

  // Extract code blocks
  const codeBlocks: AIStudioCodeBlock[] = [];
  scope.querySelectorAll(SELECTORS.codeBlock).forEach((codeEl) => {
    // Skip if inside thinking container (thinking can have code but we keep it as part of thinking text)
    if (thinkingContainer?.contains(codeEl)) return;

    const code = (codeEl as HTMLElement).textContent || "";
    if (!code.trim()) return;

    // Try to find language in the expansion panel header
    const panel = codeEl.closest(".mat-expansion-panel");
    let language: string | undefined;
    if (panel) {
      const titleText = panel.querySelector(SELECTORS.codeHeaderTitleText) as HTMLElement | null;
      if (titleText) {
        language = titleText.textContent?.trim() || undefined;
      }
    }

    codeBlocks.push({ language, code });
  });

  // Extract media files (images, videos) from assistant response
  const mediaFiles: AIStudioFileInfo[] = [];

  // Images (excluding user attachments and UI icons)
  scope.querySelectorAll(SELECTORS.image).forEach((img) => {
    const imgEl = img as HTMLImageElement;
    // Skip if it's in the user container
    if (imgEl.closest(SELECTORS.userContainer)) return;
    // Skip if inside thinking container (not actual content)
    if (thinkingContainer?.contains(imgEl)) return;
    // Skip thumbnails
    if (imgEl.classList.contains("thumbnail-img")) return;
    if (isNonContentAssistantImage(imgEl)) return;

    if (imgEl.src && !imgEl.src.startsWith("data:")) {
      mediaFiles.push({
        url: imgEl.src,
        name: imgEl.alt || undefined,
        type: "image/*",
      });
    }
  });

  // Video sources
  scope.querySelectorAll(SELECTORS.videoSource).forEach((src) => {
    const srcEl = src as HTMLSourceElement;
    // Skip if inside thinking container
    if (thinkingContainer?.contains(srcEl)) return;
    if (srcEl.src && !srcEl.src.startsWith("data:")) {
      mediaFiles.push({
        url: srcEl.src,
        type: srcEl.type || "video/*",
      });
    }
  });

  return { text, codeBlocks, mediaFiles, thinking };
}

// Generate estimated timestamp
function generateEstimatedTimestamp(baseTime: Date, index: number): string {
  const d = new Date(baseTime);
  // We want timestamps to INCREASE with index to maintain proper order when sorted ascending.
  // We start 1 hour ago and add increments for each message.
  d.setHours(d.getHours() - 1);
  d.setMinutes(d.getMinutes() + index * 2);
  return d.toISOString();
}

// Main extraction function
export async function extractAIStudioConversationData(
  options: { customTitle?: string } = {},
): Promise<AIStudioConversationData> {
  if (!isAIStudioPlatform()) {
    throw new Error("Not on AI Studio platform");
  }

  const now = new Date();
  const title = options.customTitle || extractAIStudioConversationTitle();
  const modelName = extractAIStudioModelName();
  const systemInstructions = extractAIStudioSystemInstructions();
  const conversationId = extractAIStudioConversationId();
  log.info(`[AI Studio Extractor] Using conversation ID: ${conversationId}`);

  const messages: AIStudioMessage[] = [];
  const processedTurns = new Set<Element>();

  log.info(`[AI Studio Extractor] Starting dynamic extraction for conversation: ${conversationId}`);

  // 1. Trigger upward infinite scroll to load ALL historical messages.
  //    AI Studio lazy-loads older turns only when the viewport is scrolled to the
  //    top of the currently rendered content. A single scrollTop=0 may only reveal
  //    one batch; we repeat until no new turns appear.
  const scroller = document.querySelector(SELECTORS.scrollContainer) || document.documentElement;

  log.info("[AI Studio Extractor] Loading historical content (upward infinite scroll)...");
  let prevTurnCount = -1;
  const MAX_UP_SCROLLS = 25; // safety cap: 25 × 500ms ≈ 12s foreground, ~25s background
  for (let attempt = 0; attempt < MAX_UP_SCROLLS; attempt++) {
    scroller.scrollTop = 0;
    await waitForRender(500);
    const count = document.querySelectorAll(SELECTORS.turn).length;
    if (count === prevTurnCount) break; // no new turns loaded — we've reached the beginning
    log.debug(`[AI Studio Extractor] Upscroll attempt ${attempt + 1}: ${count} turns visible`);
    prevTurnCount = count;
  }
  log.info(`[AI Studio Extractor] Finished loading history: ${prevTurnCount} turns in DOM`);

  let noNewTurnsCount = 0;
  const maxNoNewTurns = 3;
  let lastMessageCount = -1;

  while (noNewTurnsCount < maxNoNewTurns) {
    const currentTurns = Array.from(document.querySelectorAll(SELECTORS.turn));

    // For each new turn: scroll it into view, wait for its content to render, then extract.
    // We scroll to each turn individually (not batched) so the virtualizer always has it
    // in the viewport when we read innerText.
    const newTurns = currentTurns.filter((t) => !processedTurns.has(t));
    for (const turnEl of newTurns) {
      processedTurns.add(turnEl);
      turnEl.scrollIntoView({ behavior: "instant", block: "center" });
      await waitForRender(100);

      // Expand thinking panel if present
      await expandThinkingIfNeeded(turnEl);

      // Check role
      const isUserTurn = !!turnEl.querySelector(SELECTORS.userContainer);
      const isModelTurn = !!turnEl.querySelector(SELECTORS.modelContainer);

      if (isUserTurn) {
        const { text: userText, files: userFiles } = extractUserFromTurn(turnEl);
        if (userText || userFiles.length > 0) {
          messages.push({
            role: "user",
            content: userText,
            files: userFiles,
            timestamp: generateEstimatedTimestamp(now, messages.length),
          });
        }
      } else if (isModelTurn) {
        const { text, codeBlocks, mediaFiles, thinking } = extractAssistantFromTurn(turnEl);

        // AI Studio often splits thinking and response into separate ms-chat-turn elements.
        const hasOnlyThinking = thinking && !text && codeBlocks.length === 0;

        // If this turn has only thinking, we might want to wait for the next turn which might contain the text
        // In a dynamic loop, the "next" turn will be processed in the next iteration of the `for` loop
        // or the next `while` loop iteration.
        // We'll handle merging by checking if the previous message was a 'thinking-only' assistant message.

        // Simple merge logic: if current turn is model and previous was model and previous was thinking-only
        const prevMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        if (
          prevMsg &&
          prevMsg.role === "assistant" &&
          !prevMsg.content &&
          prevMsg.thinking &&
          !hasOnlyThinking
        ) {
          // Merge current into previous
          prevMsg.content = text;
          if (codeBlocks.length > 0) {
            const codeFences = codeBlocks
              .map(({ language, code }) => `\n\n\`\`\`${language || ""}\n${code}\n\`\`\`\n`)
              .join("");
            prevMsg.content = [prevMsg.content, codeFences].filter(Boolean).join("");
          }
          prevMsg.files = [...(prevMsg.files || []), ...mediaFiles];
          prevMsg.codeBlocks = codeBlocks;
          log.debug("[AI Studio Extractor] Merged response turn into previous thinking turn");
        } else {
          // Standard add
          let content = text;
          if (codeBlocks.length > 0) {
            const codeFences = codeBlocks
              .map(({ language, code }) => `\n\n\`\`\`${language || ""}\n${code}\n\`\`\`\n`)
              .join("");
            content = [content, codeFences].filter(Boolean).join("");
          }

          if (content || mediaFiles.length > 0 || thinking) {
            messages.push({
              role: "assistant",
              content: content,
              codeBlocks: codeBlocks.length > 0 ? codeBlocks : undefined,
              files: mediaFiles,
              thinking,
              timestamp: generateEstimatedTimestamp(now, messages.length),
            });
          }
        }
      }
    }

    if (messages.length > lastMessageCount) {
      lastMessageCount = messages.length;
      noNewTurnsCount = 0;
      // Scroll to the bottom of the last processed turn to trigger more loading
      const lastTurn = currentTurns[currentTurns.length - 1];
      if (lastTurn) {
        lastTurn.scrollIntoView({ behavior: "instant", block: "end" });
        await waitForRender(200);
      }
    } else {
      noNewTurnsCount++;
      // Try one more scroll-down to be sure
      scroller.scrollTop += 500;
      await waitForRender(300);
    }

    // Safety break for extremely long chats
    if (messages.length > 1000) {
      log.warn("[AI Studio Extractor] Safety limit reached (1000 messages)");
      break;
    }
  }

  const data: AIStudioConversationData = {
    platform: "aistudio",
    url: window.location.href,
    conversationId,
    title,
    modelName,
    systemInstructions,
    messages,
    extractedAt: now.toISOString(),
  };

  log.info("[AI Studio Extractor] Extracted conversation data:", {
    title,
    conversationId,
    messageCount: messages.length,
    userMessages: messages.filter((m) => m.role === "user").length,
    assistantMessages: messages.filter((m) => m.role === "assistant").length,
    modelName,
  });

  return data;
}

// Helper: wait for a specified duration
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scroll an element until no new content loads (for infinite scroll lists).
 * Returns when: scroll reaches bottom + no new items after multiple checks.
 */
async function scrollUntilSettled(
  element: HTMLElement,
  options: {
    stepPx?: number;
    delayMs?: number;
    maxDurationMs?: number;
    getItemCount: () => number;
    requiredIdleChecks?: number;
  },
): Promise<void> {
  const {
    stepPx = 1000,
    delayMs = 500,
    maxDurationMs = 120000,
    getItemCount,
    requiredIdleChecks = 5,
  } = options;

  const start = performance.now();
  let lastItemCount = getItemCount();
  let lastScrollHeight = element.scrollHeight;
  let idleChecks = 0;

  log.info(`[AI Studio] Starting scroll, initial item count: ${lastItemCount}`);

  while (performance.now() - start < maxDurationMs) {
    // Scroll down
    element.scrollTop += stepPx;
    await wait(delayMs);

    const currentItemCount = getItemCount();
    const currentScrollHeight = element.scrollHeight;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 10;

    // Check if new content loaded
    if (currentItemCount > lastItemCount || currentScrollHeight > lastScrollHeight) {
      log.info(`[AI Studio] New content loaded: ${currentItemCount} items`);
      lastItemCount = currentItemCount;
      lastScrollHeight = currentScrollHeight;
      idleChecks = 0;
      continue;
    }

    // If at bottom with no new content, increment idle counter
    if (atBottom) {
      idleChecks++;
      log.debug(`[AI Studio] Idle check ${idleChecks}/${requiredIdleChecks}`);
      if (idleChecks >= requiredIdleChecks) {
        log.info(`[AI Studio] Scroll settled after ${idleChecks} idle checks`);
        break;
      }
    }
  }

  log.info(
    `[AI Studio] Scroll complete: ${getItemCount()} items in ${Math.round(performance.now() - start)}ms`,
  );
}

/**
 * Get all chat IDs from the AI Studio library page.
 * Must be called when on https://aistudio.google.com/library
 */
export async function getAIStudioChatIds(): Promise<string[]> {
  const start = performance.now();

  if (!isAIStudioPlatform()) {
    throw new Error("Not on AI Studio platform");
  }

  // Verify we're on the library page
  const pathname = window.location.pathname;
  if (!pathname.includes("/library")) {
    log.warn("[AI Studio] getAIStudioChatIds called outside /library; attempting anyway.");
  }

  // Find the scroll container for the library table
  const scrollContainer = document.querySelector(
    SELECTORS.libraryScrollContainer,
  ) as HTMLElement | null;

  if (!scrollContainer) {
    log.error("[AI Studio] Library scroll container not found (.lib-table-wrapper)");
    throw new Error("Library scroll container not found. Are you on the library page?");
  }

  // Scroll to load all items
  await scrollUntilSettled(scrollContainer, {
    stepPx: 800,
    delayMs: 1000, // 1000ms avoids Chrome's background-tab sub-second throttling
    maxDurationMs: 120000,
    requiredIdleChecks: 3, // was 5; 3 consecutive idle checks is sufficient
    getItemCount: () => document.querySelectorAll(SELECTORS.libraryChatLink).length,
  });

  // Collect all chat links
  const allLinks = Array.from(document.querySelectorAll(SELECTORS.libraryChatLink));
  log.info(`[AI Studio] Found ${allLinks.length} total chat links`);

  // Extract chat IDs from href attributes
  // URL pattern: /prompts/{chatId}
  const chatIds = allLinks
    .map((el) => {
      const href = el.getAttribute("href");
      if (!href) return null;

      // Match /prompts/{chatId} pattern
      const match = href.match(/\/prompts\/([^/?#]+)/);
      if (match?.[1]) {
        return match[1];
      }
      return null;
    })
    .filter((id): id is string => id !== null)
    .filter((id, index, self) => self.indexOf(id) === index); // Deduplicate

  log.info(
    `[AI Studio] Extracted ${chatIds.length} unique chat IDs in ${Math.round(performance.now() - start)}ms`,
  );

  return chatIds;
}
