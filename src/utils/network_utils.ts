/**
 * Network utilities for resilient HTTP requests
 */

import { log } from "./logger";

/** One try at a request: what it came back with, and how long the try took. */
export interface FetchAttempt {
  /** `HTTP 503`, `timed out` (our timer aborted it), or the name of the error fetch threw. */
  outcome: string;
  elapsedMs: number;
}

/**
 * The error fetchWithTimeout throws once every attempt has failed. Its message starts with the
 * original message, so callers that match on its words still match, and ends with the attempts in
 * brackets. `attempts` and `cause` hold the same facts for code that reads them.
 */
export class FetchFailedError extends Error {
  readonly attempts: readonly FetchAttempt[];
  readonly cause: unknown;

  constructor(message: string, attempts: readonly FetchAttempt[], cause: unknown) {
    super(message);
    this.attempts = attempts;
    this.cause = cause;
  }
}

/** Statuses that mean "slow down": these back off exponentially and honour Retry-After. */
const BACKOFF_STATUSES = new Set([429, 503]);

/** The longest wait between two attempts, whatever Retry-After or the backoff asks for. */
const MAX_WAIT_MS = 60_000;

/**
 * Fetch with timeout and retry support using AbortController.
 * Automatically aborts an attempt that exceeds the timeout. The wait between attempts is not part
 * of an attempt, so it does not use up the timeout.
 * Retries on a thrown error or a non-OK response. After a 429 or 503 the wait is Retry-After when
 * the server sent one, otherwise retryDelayMs doubled for each attempt, capped at 60 s. Any other
 * failure waits retryDelayMs.
 *
 * A non-OK response that survives every attempt is returned, with one warning in the log. A failure
 * that survives every attempt is thrown as a FetchFailedError, whose message says what each attempt
 * did. The URL appears as origin and path only: no query string, no headers.
 *
 * @param url - The URL to fetch
 * @param options - Optional RequestInit options (headers, credentials, etc.) plus timeoutMs, retries, and retryDelayMs
 * @returns Promise that resolves to the Response object
 * @throws FetchFailedError if every attempt threw or timed out
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit & { timeoutMs?: number; retries?: number; retryDelayMs?: number },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxRetries = options?.retries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 3000;
  const method = (options?.method ?? "GET").toUpperCase();

  const startedAt = Date.now();
  const attempts: FetchAttempt[] = [];
  let waitMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      const timedOut = error instanceof Error && error.name === "AbortError";
      attempts.push({
        outcome: timedOut ? "timed out" : errorName(error),
        elapsedMs: Date.now() - attemptStartedAt,
      });
      if (attempt === maxRetries) {
        const original = timedOut ? `Fetch timeout after ${timeoutMs}ms` : errorMessage(error);
        const message = withAttempts(original, method, url, attempts, Date.now() - startedAt);
        throw new FetchFailedError(message, attempts, error);
      }
      waitMs = retryDelayMs;
      continue;
    }
    clearTimeout(timeoutId);

    // If response is OK, return it immediately
    if (response.ok) {
      return response;
    }

    attempts.push({
      outcome: `HTTP ${response.status}`,
      elapsedMs: Date.now() - attemptStartedAt,
    });
    if (attempt === maxRetries) {
      const summary = withAttempts(
        `HTTP ${response.status}`,
        method,
        url,
        attempts,
        Date.now() - startedAt,
      );
      log.warn(`[Network] ${summary}`);
      return response;
    }
    waitMs = BACKOFF_STATUSES.has(response.status)
      ? backoffMs(response, attempt, retryDelayMs)
      : retryDelayMs;
  }

  // Not reached for maxRetries >= 0: the last attempt always returns or throws.
  const message = withAttempts("Failed to fetch", method, url, attempts, Date.now() - startedAt);
  throw new FetchFailedError(message, attempts, undefined);
}

/**
 * The wait after a 429 or 503: its Retry-After when the server sent a readable one, otherwise
 * retryDelayMs doubled for each attempt made so far. Never more than MAX_WAIT_MS.
 */
function backoffMs(response: Response, attempt: number, retryDelayMs: number): number {
  const retryAfter = retryAfterMs(response.headers?.get("Retry-After") ?? null);
  return Math.min(retryAfter ?? retryDelayMs * 2 ** attempt, MAX_WAIT_MS);
}

/** Retry-After as a wait in ms, from delay-seconds or an HTTP-date. Undefined if unreadable. */
function retryAfterMs(value: string | null): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const until = Date.parse(text);
  return Number.isNaN(until) ? undefined : Math.max(0, until - Date.now());
}

/**
 * The message with the attempts in brackets, after the head:
 * `Failed to fetch [GET https://chatgpt.com/backend-api/conversation/abc: 4 attempts: TypeError 2ms, TypeError 1ms, TypeError 1ms, TypeError 1ms; total 9012ms; online]`.
 * No word the callers match on for a retry ("timeout", "did not respond") is added here, so a failure
 * that was not a timeout is still classed as one that is not.
 */
function withAttempts(
  head: string,
  method: string,
  url: string,
  attempts: readonly FetchAttempt[],
  totalMs: number,
): string {
  const count = attempts.length === 1 ? "1 attempt" : `${attempts.length} attempts`;
  const tries = attempts.map((attempt) => `${attempt.outcome} ${attempt.elapsedMs}ms`).join(", ");
  const parts = [`${method} ${originAndPath(url)}: ${count}: ${tries}`, `total ${totalMs}ms`];
  const online = onlineState();
  if (online) parts.push(online);
  const summary = `[${parts.join("; ")}]`;
  return head ? `${head} ${summary}` : summary;
}

/** The request's origin and path. A relative URL is cut at its query string and fragment. */
function originAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

/** Whether the browser reports a connection, where it reports one at all. */
function onlineState(): "online" | "offline" | undefined {
  if (typeof navigator === "undefined" || !("onLine" in navigator)) return undefined;
  return navigator.onLine ? "online" : "offline";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
