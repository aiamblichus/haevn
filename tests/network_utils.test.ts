import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from "vitest";
import { log } from "../src/utils/logger";
import { FetchFailedError, fetchWithTimeout } from "../src/utils/network_utils";

const START = new Date("2026-11-21T10:00:00Z");
const PATH_URL = "https://chatgpt.com/backend-api/conversation/abc";

let fetchMock: Mock<typeof fetch>;
let warn: MockInstance<typeof log.warn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function aborted(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A fetch that throws `error` after `ms` of fake time. */
function rejectAfter(ms: number, error: unknown): Promise<Response> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}

/** A fetch that never answers and gives way only to the caller's abort. */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    signal?.addEventListener("abort", () => reject(aborted()), { once: true });
  });
}

/** A fetch that answers 200 after `ms`, unless the caller's abort comes first. */
function answerAfter(ms: number, signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => resolve(respond(200)), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(aborted());
      },
      { once: true },
    );
  });
}

/** Records the fake time of each fetch call, and answers call n with `answer(n)`. */
function recordCalls(answer: (call: number) => Response): number[] {
  const times: number[] = [];
  fetchMock.mockImplementation(async () => {
    times.push(Date.now());
    return answer(times.length - 1);
  });
  return times;
}

/** Lets the fake clock run until the call settles; resolves to its value or to its rejection. */
async function settle<T>(pending: Promise<T>): Promise<T | Error> {
  const outcome = pending.catch((error: Error) => error);
  await vi.runAllTimersAsync();
  return outcome;
}

describe("fetchWithTimeout when every attempt fails", () => {
  it("says in the message what each attempt did, and how long it took", async () => {
    const delays = [2, 1, 0, 5];
    fetchMock.mockImplementation(() =>
      rejectAfter(delays.shift() ?? 0, new TypeError("Failed to fetch")),
    );

    const error = await settle(
      fetchWithTimeout(`${PATH_URL}?access_token=SECRET`, { retries: 3, retryDelayMs: 1000 }),
    );

    expect(error).toBeInstanceOf(FetchFailedError);
    expect((error as Error).message).toBe(
      `Failed to fetch [GET ${PATH_URL}: 4 attempts: TypeError 2ms, TypeError 1ms, TypeError 0ms, TypeError 5ms; total 3008ms; online]`,
    );
    expect((error as FetchFailedError).attempts.map((a) => a.elapsedMs)).toEqual([2, 1, 0, 5]);
    expect((error as FetchFailedError).cause).toBeInstanceOf(TypeError);
  });

  it("keeps the timeout's own message at its front, with each timed-out attempt", async () => {
    fetchMock.mockImplementation((_url, init) => hangUntilAborted(init?.signal));

    const error = await settle(
      fetchWithTimeout(PATH_URL, { timeoutMs: 100, retries: 1, retryDelayMs: 50 }),
    );

    expect((error as Error).message).toBe(
      `Fetch timeout after 100ms [GET ${PATH_URL}: 2 attempts: timed out 100ms, timed out 100ms; total 250ms; online]`,
    );
    expect((error as Error).message).toMatch(/timeout/);
  });

  it("adds no timeout wording to a failure that was not a timeout", async () => {
    // The first attempt times out; the last one fails to connect. The callers' retry rules read
    // the message, and a connection failure must still not look like a timeout to them.
    fetchMock
      .mockImplementationOnce((_url, init) => hangUntilAborted(init?.signal))
      .mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await settle(
      fetchWithTimeout(PATH_URL, { timeoutMs: 100, retries: 1, retryDelayMs: 50 }),
    );

    expect((error as Error).message).toMatch(/^Failed to fetch \[/);
    expect((error as Error).message).not.toMatch(/timeout|Timeout|did not respond|did not appear/);
  });

  it("omits the online state where the browser reports none", async () => {
    vi.stubGlobal("navigator", undefined);
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await settle(fetchWithTimeout(PATH_URL, { retries: 0 }));

    expect((error as Error).message).toBe(
      `Failed to fetch [GET ${PATH_URL}: 1 attempt: TypeError 0ms; total 0ms]`,
    );
  });

  it("says offline when the browser is offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    const error = await settle(fetchWithTimeout(PATH_URL, { retries: 0 }));

    expect((error as Error).message).toMatch(/; offline\]$/);
  });
});

describe("what the URL and headers reveal", () => {
  it("shows the origin and path only, in the error and in the warning", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await settle(
      fetchWithTimeout(`${PATH_URL}?access_token=SECRET&id=7`, {
        headers: { Authorization: "Bearer SECRET" },
        retries: 0,
      }),
    );
    expect((error as Error).message).toContain(PATH_URL);
    expect((error as Error).message).not.toMatch(/SECRET|access_token|Bearer|Authorization|\?/);

    fetchMock.mockImplementation(async () => respond(500));
    await settle(
      fetchWithTimeout(`${PATH_URL}?access_token=SECRET`, {
        headers: { Authorization: "Bearer SECRET" },
        retries: 0,
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain(PATH_URL);
    expect(logged).not.toMatch(/SECRET|access_token|Bearer|Authorization|\?/);
  });
});

describe("waiting between attempts", () => {
  it.each([
    ["delay-seconds", "5", 5_000],
    ["an HTTP-date", new Date(START.getTime() + 10_000).toUTCString(), 10_000],
    ["a delay past the 60 s cap", "3600", 60_000],
  ])("waits for Retry-After given as %s after a 429", async (_label, header, waitMs) => {
    const times = recordCalls((call) =>
      call === 0 ? respond(429, { "Retry-After": header }) : respond(200),
    );

    const pending = fetchWithTimeout(PATH_URL, { retryDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(times).toHaveLength(2);

    const response = await pending;
    expect(response.status).toBe(200);
    expect(times[1] - times[0]).toBe(waitMs);
  });

  it.each([429, 503])("doubles the wait after each %i with no Retry-After", async (status) => {
    const times = recordCalls(() => respond(status));

    const response = await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect((response as Response).status).toBe(status);
    expect(times.map((t) => t - times[0])).toEqual([0, 1000, 3000, 7000]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `[Network] HTTP ${status} [GET ${PATH_URL}: 4 attempts: ${Array(4).fill(`HTTP ${status} 0ms`).join(", ")}; total 7000ms; online]`,
    );
  });

  it.each([
    ["zero", "0"],
    ["a past HTTP-date", new Date(START.getTime() - 10_000).toUTCString()],
  ])("never waits less than retryDelayMs when Retry-After is %s", async (_label, header) => {
    const times = recordCalls((call) =>
      call === 0 ? respond(429, { "Retry-After": header }) : respond(200),
    );

    await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000 }));

    expect(times[1] - times[0]).toBe(1000);
  });

  it("falls back to the doubled wait when Retry-After is unreadable", async () => {
    const times = recordCalls(() => respond(429, { "Retry-After": "soon" }));

    await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect(times.map((t) => t - times[0])).toEqual([0, 1000, 3000, 7000]);
  });

  it("caps the doubled wait at 60 s", async () => {
    const times = recordCalls(() => respond(429));

    await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 40_000, retries: 2 }));

    expect(times.map((t) => t - times[0])).toEqual([0, 40_000, 100_000]);
  });

  it("keeps the fixed wait for other statuses, and ignores their Retry-After", async () => {
    const times = recordCalls(() => respond(500, { "Retry-After": "30" }));

    const response = await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect((response as Response).status).toBe(500);
    expect(times.map((t) => t - times[0])).toEqual([0, 1000, 2000, 3000]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `[Network] HTTP 500 [GET ${PATH_URL}: 4 attempts: ${Array(4).fill("HTTP 500 0ms").join(", ")}; total 3000ms; online]`,
    );
  });

  it("starts the timeout after the wait, so the wait does not use it up", async () => {
    fetchMock
      .mockImplementationOnce(async () => respond(500))
      .mockImplementationOnce((_url, init) => answerAfter(500, init?.signal));

    const response = await settle(
      fetchWithTimeout(PATH_URL, { timeoutMs: 1000, retryDelayMs: 5000, retries: 1 }),
    );

    expect((response as Response).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("which non-OK statuses are retried", () => {
  // A 4xx goes back to the caller at once, and the caller reads its status. retries: 3 is set so
  // that a retry would show: the old code made four calls here.
  it.each([
    400, 401, 403, 404,
  ])("returns a %i after one attempt, with the warning and a one-attempt summary", async (status) => {
    const times = recordCalls(() => respond(status));

    const response = await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect((response as Response).status).toBe(status);
    expect(times).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `[Network] HTTP ${status} [GET ${PATH_URL}: 1 attempt: HTTP ${status} 0ms; total 0ms; online]`,
    );
  });

  it("does not retry a 404 that follows a 500, and its summary names both attempts", async () => {
    const times = recordCalls((call) => (call === 0 ? respond(500) : respond(404)));

    const response = await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect((response as Response).status).toBe(404);
    expect(times.map((t) => t - times[0])).toEqual([0, 1000]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `[Network] HTTP 404 [GET ${PATH_URL}: 2 attempts: HTTP 500 0ms, HTTP 404 0ms; total 1000ms; online]`,
    );
  });

  it.each([
    408, 500, 502,
  ])("still retries a %i at the fixed retryDelayMs, as before", async (status) => {
    const times = recordCalls(() => respond(status));

    const response = await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000, retries: 3 }));

    expect((response as Response).status).toBe(status);
    expect(times.map((t) => t - times[0])).toEqual([0, 1000, 2000, 3000]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still honours Retry-After after a 503", async () => {
    const times = recordCalls((call) =>
      call === 0 ? respond(503, { "Retry-After": "5" }) : respond(200),
    );

    await settle(fetchWithTimeout(PATH_URL, { retryDelayMs: 1000 }));

    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBe(5_000);
  });
});
