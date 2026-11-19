import { fireAndForget } from "../utils/error_utils";

/** A broadcast the popup reacts to. The service worker sends these to every extension page. */
export interface PopupBroadcast {
  action: string;
  provider?: string;
  progress?: number;
  status?: string;
  /** On bulkSyncFailed: the reason the sync failed. */
  error?: string;
  /** On bulkSyncComplete: how many chats did not sync. */
  failedCount?: number;
}

/** True for `bulkSync*` (progress and state changes) and `chatSynced`: the popup's broadcasts. */
export function isPopupBroadcast(message: unknown): message is PopupBroadcast {
  if (typeof message !== "object" || message === null || !("action" in message)) {
    return false;
  }
  const { action } = message as { action: unknown };
  return typeof action === "string" && (action === "chatSynced" || action.startsWith("bulkSync"));
}

/**
 * Registers the popup's broadcast listener. It never answers. A listener that returns a Promise
 * answers every message, the archive's searches and state requests included, with null before the
 * service worker can answer them (HVN-67), so this one returns nothing and sends no response.
 */
export function listenForPopupBroadcasts(
  onBroadcast: (message: PopupBroadcast) => Promise<void>,
): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isPopupBroadcast(message)) return;
    fireAndForget(onBroadcast(message), `Popup broadcast ${message.action}`);
  });
}
