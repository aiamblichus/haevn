import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyFailure } from "../src/background/health/providerHealth";
import { extractQwenChatIds, fetchQwenConversation } from "../src/providers/qwen/extractor";
import { log } from "../src/utils/logger";
import { fetchWithTimeout } from "../src/utils/network_utils";

vi.mock("../src/utils/network_utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/network_utils")>()),
  fetchWithTimeout: vi.fn(),
}));

// Synthetic values only: the real session token is never written into a test (HVN-115).
const SYNTHETIC_TOKEN = "synthetic-session-token-0001";
const SYNTHETIC_CHAT_ID = "00000000-0000-4000-8000-000000000001";

const fetchMock = vi.mocked(fetchWithTimeout);

function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

function listItem(id: string) {
  return { id, title: "Synthetic chat", updated_at: 1, created_at: 1, chat_type: "t2t" };
}

function chatPayload(id: string) {
  return {
    id,
    user_id: "synthetic-user",
    title: "Synthetic chat",
    chat: {
      history: { messages: {}, currentId: "", currentResponseIds: [] },
      models: ["qwen3-max"],
      messages: [],
    },
    created_at: 1,
    updated_at: 1,
    chat_type: "t2t",
  };
}

/** The headers the n-th call to the mocked fetch was made with. */
function headersOf(call: number): Record<string, string> {
  const init = fetchMock.mock.calls[call][1] as unknown as { headers: Record<string, string> };
  return init.headers;
}

function stubToken(token: string | null): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "token" ? token : null),
  });
}

/** The error an extractor call rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

describe("Qwen's list and chat fetch (HVN-115)", () => {
  let logSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    fetchMock.mockReset();
    logSpies = (["debug", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(log, level),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the session token as a bearer on the chat list", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({ success: true, request_id: "r1", data: [listItem("synthetic-chat-a")] }),
    );

    await expect(extractQwenChatIds()).resolves.toEqual(["synthetic-chat-a"]);
    expect(headersOf(0).Authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it("sends the session token as a bearer on a single chat's fetch", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({ success: true, request_id: "r2", data: chatPayload(SYNTHETIC_CHAT_ID) }),
    );

    const data = await fetchQwenConversation(SYNTHETIC_CHAT_ID);
    expect(data.id).toBe(SYNTHETIC_CHAT_ID);
    expect(headersOf(0).Authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it("sends no Authorization header when the page holds no token", async () => {
    stubToken(null);
    fetchMock.mockResolvedValueOnce(answer({ success: true, request_id: "r3", data: [] }));

    await extractQwenChatIds();
    expect(headersOf(0)).not.toHaveProperty("Authorization");
  });

  it("a signed-out page, with no token and Unauthorized, is reported as not signed in", async () => {
    stubToken(null);
    fetchMock.mockResolvedValueOnce(
      answer({ success: false, request_id: "r4", data: { code: "Unauthorized" } }),
    );

    const err = await rejectionOf(extractQwenChatIds());
    expect(classifyFailure(err.message)).toBe("not-signed-in");
  });

  it("a rejected session token on the chat list is reported as signed out, in its own words", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({ success: false, request_id: "r5", data: { code: "Unauthorized" } }),
    );

    const err = await rejectionOf(extractQwenChatIds());
    expect(err.message).toBe("Not signed in to Qwen: the session token was rejected");
    expect(classifyFailure(err.message)).toBe("not-signed-in");
  });

  it("a rejected session token on a chat fetch is reported as signed out too", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({ success: false, request_id: "r6", data: { code: "Unauthorized" } }),
    );

    const err = await rejectionOf(fetchQwenConversation(SYNTHETIC_CHAT_ID));
    expect(classifyFailure(err.message)).toBe("not-signed-in");
  });

  it("with a token, any code other than Unauthorized is a failure, not signed out", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({ success: false, request_id: "r8", data: { code: "InternalError" } }),
    );

    const err = await rejectionOf(extractQwenChatIds());
    expect(classifyFailure(err.message)).toBe("other");
  });

  it("never puts the session token in an error or in a log", async () => {
    stubToken(SYNTHETIC_TOKEN);
    fetchMock.mockResolvedValueOnce(
      answer({
        success: false,
        request_id: "r7",
        data: { code: "Unauthorized", details: "synthetic details" },
      }),
    );

    const err = await rejectionOf(extractQwenChatIds());
    expect(err.message).not.toContain(SYNTHETIC_TOKEN);
    const logged = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(SYNTHETIC_TOKEN);
  });
});
