import { log } from "./logger";

/**
 * Called where a `chrome.runtime.sendMessage` resolved with no answer. Logs the last error and
 * the contexts alive at that moment, so the next occurrence names the context that answered.
 * getContexts lists every live context, not the one that answered, so the entry narrows the
 * answer down to those (HVN-73).
 */
export async function logNoResponse(where: string): Promise<void> {
  const lastError = chrome.runtime.lastError?.message;
  let contexts: { contextType: string; documentUrl?: string }[] | string;
  try {
    contexts = (await chrome.runtime.getContexts({})).map((c) => ({
      contextType: c.contextType,
      documentUrl: c.documentUrl,
    }));
  } catch (err) {
    contexts = `getContexts failed: ${String(err)}`;
  }
  log.warn(`[NoResponse] ${where}: sendMessage resolved with no response`, { lastError, contexts });
}
