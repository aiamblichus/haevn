// Shared utilities for all platform extractors

// Note: ExportOptions types live in specific modules (extractors/formatters).

import { log } from "../utils/logger";
// Shared timestamp utilities
import { formatLocalTime as formatLocalTimeUtil } from "../utils/time_utils";

export function formatLocalTime(isoString: string): string {
  // Convert ISO string to milliseconds for the utility function
  const timestamp = new Date(isoString).getTime();
  return formatLocalTimeUtil(timestamp);
}

export function generateEstimatedTimestamp(index: number): string {
  const baseTime = new Date();
  // We want timestamps to INCREASE with index to maintain proper order when sorted ascending.
  // We start some time in the past and add increments for each message.
  const messagesOffset = index * 2; // 2 minutes per message
  baseTime.setHours(baseTime.getHours() - 1); // Start 1 hour ago
  baseTime.setMinutes(baseTime.getMinutes() + messagesOffset);
  return baseTime.toISOString();
}

export function parseTimestamp(timeText: string): Date | null {
  try {
    const parsed = new Date(timeText);
    return !Number.isNaN(parsed.getTime()) ? parsed : null;
  } catch {
    return null;
  }
}

// Shared filename utilities
export function sanitizeForFilename(title: string): string {
  if (!title) return "";

  return title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\\w\-_.]/g, "")
    .substring(0, 50)
    .replace(/^_+|_+$/g, "");
}

// Shared DOM utilities
export function trySelectors(selectors: string[]): string {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.textContent?.trim()) {
      return element.textContent.trim();
    }
  }
  return "";
}

export function generateFallbackId(platform: string): string {
  return `${platform}_conv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared waiting utilities
export async function waitForElements(
  selector: string,
  maxAttempts: number = 15,
  delay: number = 1000,
): Promise<NodeListOf<Element>> {
  log.info(`[Extractor] Waiting for elements matching: ${selector}`);

  for (let i = 0; i < maxAttempts; i++) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      log.info(`[Extractor] Found ${elements.length} elements. Proceeding.`);
      return elements;
    }
    log.info(`[Extractor] Attempt ${i + 1}/${maxAttempts}: No elements found yet, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Timeout: Elements did not appear on the page.");
}

// Shared download utilities
export interface DownloadMessageData {
  action: "downloadFile";
  content: string;
  filename: string;
  contentType: string;
}

export function createDownloadPromise(messageData: DownloadMessageData): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(messageData, (response) => {
      log.info(`[Download] Received response from background:`, response);

      if (chrome.runtime.lastError) {
        log.error(`[Download] Runtime error:`, chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (response?.success) {
        log.info(`[Download] File downloaded successfully:`, messageData.filename);
        resolve();
      } else {
        const error = response?.error || "Download failed";
        log.error(`[Download] Download failed:`, error);
        reject(new Error(error));
      }
    });
  });
}

// Shared export metadata utilities
export function generateExportMetadata(
  platform: string,
  title: string,
  conversationId: string,
  url: string,
  messageCount: number,
  extractedAt: string,
  organizationId?: string,
): string {
  let metadata = `## Conversation Metadata
Platform: ${platform}
Title: ${title}
Conversation ID: ${conversationId}
URL: ${url}
Message Count: ${messageCount}
Extracted: ${new Date(extractedAt).toLocaleString()}`;

  if (organizationId) {
    metadata += `\nOrganization ID: ${organizationId}`;
  }

  return `${metadata}\n\n`;
}

export function generateExportNotes(
  platform: string,
  url: string,
  messageCount: number,
  additionalNotes: string[] = [],
): string {
  let notes = `
## Export Notes
- Exported from ${platform} (${url})
- Message roles are automatically detected
- Timestamps reflect user's local time zone`;

  additionalNotes.forEach((note) => {
    notes += `\n- ${note}`;
  });

  notes += `
- Total Messages: ${messageCount}

Export Format: ${platform} TXT v1.0
`;

  return notes;
}
