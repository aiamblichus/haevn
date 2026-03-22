/**
 * Network utilities for resilient HTTP requests
 */

/**
 * Fetch with timeout support using AbortController.
 * Automatically aborts the request if it exceeds the specified timeout.
 *
 * @param url - The URL to fetch
 * @param options - Optional RequestInit options (headers, credentials, etc.) plus timeoutMs
 * @returns Promise that resolves to the Response object
 * @throws Error if the request times out or fails
 */
/**
 * Fetch with timeout and retry support using AbortController.
 * Automatically aborts the request if it exceeds the specified timeout.
 * Retries the request on failure or non-OK response.
 *
 * @param url - The URL to fetch
 * @param options - Optional RequestInit options (headers, credentials, etc.) plus timeoutMs, retries, and retryDelayMs
 * @returns Promise that resolves to the Response object
 * @throws Error if the request exceeds max retries or times out
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit & { timeoutMs?: number; retries?: number; retryDelayMs?: number },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxRetries = options?.retries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 3000;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // If response is OK, return it immediately
      if (response.ok) {
        return response;
      }

      // If not OK and we have retries left, continue to next attempt
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      if (attempt < maxRetries) {
        continue;
      }
      return response;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      const isAbort = error instanceof Error && error.name === "AbortError";
      lastError = isAbort ? new Error(`Fetch timeout after ${timeoutMs}ms`) : (error as Error);

      if (attempt < maxRetries) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}
