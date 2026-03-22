/**
 * Message Safety Utility
 *
 * Chrome's runtime.sendMessage has a 64MB limit. This utility helps detect
 * and handle oversized messages before they crash the extension.
 */

// Chrome's limit is 64MB, we'll use 60MB as safety margin
const MAX_MESSAGE_SIZE_BYTES = 60 * 1024 * 1024;
// For truncation, we'll cap individual fields at 1MB
const MAX_FIELD_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Estimate the JSON-serialized size of an object in bytes
 */
export function estimateMessageSize(obj: unknown): number {
  try {
    return JSON.stringify(obj).length * 2; // UTF-16 = 2 bytes per char
  } catch {
    // Circular reference or other issue - assume it's huge
    return MAX_MESSAGE_SIZE_BYTES + 1;
  }
}

/**
 * Truncate a string to a maximum byte size, adding an indicator
 */
function truncateString(str: string, maxBytes: number): string {
  const maxChars = Math.floor(maxBytes / 2); // UTF-16
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars - 50)}... [TRUNCATED: was ${str.length} chars]`;
}

/**
 * Recursively sanitize an object, truncating large strings and arrays
 */
function sanitizeValue(value: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 10) return "[MAX_DEPTH_EXCEEDED]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncateString(value, MAX_FIELD_SIZE_BYTES);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    // For large arrays, sample the first few elements
    if (value.length > 100) {
      return [
        ...value.slice(0, 5).map((v) => sanitizeValue(v, depth + 1)),
        `... [TRUNCATED: ${value.length} items total]`,
      ];
    }
    return value.map((v) => sanitizeValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = sanitizeValue(val, depth + 1);
    }
    return result;
  }

  // Functions, symbols, etc - just describe them
  return `[${typeof value}]`;
}

export interface SafeMessageResult {
  safe: boolean;
  message: unknown;
  originalSizeBytes?: number;
  truncatedSizeBytes?: number;
  warning?: string;
}

/**
 * Check if a message is safe to send, and if not, return a truncated version
 * with diagnostic information.
 */
export function ensureSafeMessage(message: unknown): SafeMessageResult {
  const originalSize = estimateMessageSize(message);

  if (originalSize <= MAX_MESSAGE_SIZE_BYTES) {
    return { safe: true, message };
  }

  // Message is too large - sanitize it
  const sanitized = sanitizeValue(message);
  const truncatedSize = estimateMessageSize(sanitized);

  const warning =
    `Message exceeded 64MB limit (was ~${(originalSize / 1024 / 1024).toFixed(1)}MB). ` +
    `Truncated to ~${(truncatedSize / 1024 / 1024).toFixed(1)}MB. ` +
    `Original message type: ${typeof message}, ` +
    `keys: ${typeof message === "object" && message ? Object.keys(message).join(", ") : "N/A"}`;

  return {
    safe: false,
    message: sanitized,
    originalSizeBytes: originalSize,
    truncatedSizeBytes: truncatedSize,
    warning,
  };
}

/**
 * Wrap chrome.runtime.sendMessage with size checking.
 * Returns true if sent successfully, false if blocked due to size.
 */
export async function safeSendMessage(message: unknown): Promise<boolean> {
  const result = ensureSafeMessage(message);

  if (!result.safe) {
    // Log to console since we can't send to background
    console.error("[MessageSafety] BLOCKED oversized message:", result.warning);
    console.error("[MessageSafety] Truncated message preview:", result.message);
    return false;
  }

  try {
    await chrome.runtime.sendMessage(message);
    return true;
  } catch (err) {
    // Check if it's a size error despite our check
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("64MB") || errMsg.includes("Message length")) {
      console.error("[MessageSafety] Message still too large after check:", errMsg);
      return false;
    }
    throw err; // Re-throw other errors
  }
}
