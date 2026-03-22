/**
 * Timeout utilities for wrapping promises with timeout protection
 * Part of CRD-003 refactoring to prevent indefinite hangs
 */

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve/reject
 * within the specified timeout, it will reject with a timeout error.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param context - Descriptive context for error messages
 * @returns Promise that resolves/rejects with the original promise, or rejects with timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms: ${context}`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Wrapper for chrome.runtime.sendMessage with timeout protection.
 * Prevents indefinite hangs when the receiving end doesn't respond.
 *
 * @param message - The message to send
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise that resolves to the response or rejects on timeout
 */
export function sendMessageWithTimeout(message: unknown, timeoutMs = 30000): Promise<unknown> {
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    }),
    timeoutMs,
    `sendMessage: ${JSON.stringify(message).slice(0, 100)}`,
  );
}
