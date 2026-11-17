import { describe, expect, it } from "vitest";
import {
  isKeyRejected,
  REJECTED_RETRY_MAX_MS,
  rejectedRetryDelayMs,
  terminalCloseReason,
  WS_CLOSE_REPLACED,
  WS_CLOSE_UNAUTHORIZED,
  WS_REASON_REPLACED,
} from "../src/background/wsBridgeClose";

describe("terminalCloseReason", () => {
  it("is final, with a reason, only for a replaced connection (4002)", () => {
    expect(terminalCloseReason(WS_CLOSE_REPLACED)).toBe(WS_REASON_REPLACED);
    expect(terminalCloseReason(4002)).not.toBeNull();
  });

  it("is not final for a rejected key (4001): the daemon may be restarted with the right one", () => {
    expect(terminalCloseReason(WS_CLOSE_UNAUTHORIZED)).toBeNull();
  });

  it("lets every other close reconnect", () => {
    // Normal and abnormal closes, going away, no status, an invalid JSON frame, and the
    // neighbours of the private codes.
    for (const code of [1000, 1001, 1003, 1005, 1006, 1011, 4000, 4003, 4999]) {
      expect(terminalCloseReason(code)).toBeNull();
    }
  });
});

describe("isKeyRejected", () => {
  it("is true for 4001 only", () => {
    expect(isKeyRejected(4001)).toBe(true);
    for (const code of [1000, 1006, 4000, 4002, 4003]) expect(isKeyRejected(code)).toBe(false);
  });
});

describe("rejectedRetryDelayMs", () => {
  it("starts at 30 s, doubles, and stops at 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(rejectedRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
    expect(REJECTED_RETRY_MAX_MS).toBe(300_000);
  });
});
