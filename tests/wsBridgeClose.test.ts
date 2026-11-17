import { describe, expect, it } from "vitest";
import {
  terminalCloseReason,
  WS_CLOSE_REPLACED,
  WS_CLOSE_UNAUTHORIZED,
  WS_REASON_REPLACED,
  WS_REASON_UNAUTHORIZED,
} from "../src/background/wsBridgeClose";

describe("terminalCloseReason", () => {
  it("is final, with a reason, for a replaced connection (4002) and a rejected key (4001)", () => {
    expect(terminalCloseReason(WS_CLOSE_REPLACED)).toBe(WS_REASON_REPLACED);
    expect(terminalCloseReason(WS_CLOSE_UNAUTHORIZED)).toBe(WS_REASON_UNAUTHORIZED);
    expect(terminalCloseReason(4002)).not.toBeNull();
    expect(terminalCloseReason(4001)).not.toBeNull();
  });

  it("lets every other close reconnect", () => {
    // Normal and abnormal closes, going away, no status, an invalid JSON frame, and the
    // neighbours of the private codes.
    for (const code of [1000, 1001, 1003, 1005, 1006, 1011, 4000, 4003, 4999]) {
      expect(terminalCloseReason(code)).toBeNull();
    }
  });
});
