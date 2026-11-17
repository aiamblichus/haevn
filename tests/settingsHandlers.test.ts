import { beforeEach, describe, expect, it, vi } from "vitest";

const setCliEnabled = vi.hoisted(() => vi.fn(async () => {}));
const resetWsBridge = vi.hoisted(() => vi.fn(async () => {}));
const applyWsBridgeSettings = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/services/settingsService", () => ({
  clearOpenWebUIBaseUrl: vi.fn(),
  getCliSettings: vi.fn(),
  getOpenWebUIBaseUrl: vi.fn(),
  regenerateCliApiKey: vi.fn(),
  setCliEnabled,
  setCliPort: vi.fn(),
  setOpenWebUIBaseUrl: vi.fn(),
}));
vi.mock("../src/background/wsBridge", () => ({ resetWsBridge, applyWsBridgeSettings }));

import { handleSetCliEnabled } from "../src/background/handlers/settingsHandlers";

beforeEach(() => {
  setCliEnabled.mockClear();
  resetWsBridge.mockClear();
  applyWsBridgeSettings.mockClear();
});

describe("switching the CLI bridge on or off (HVN-44)", () => {
  it("resets the bridge, so one that gave up after a final close tries again", async () => {
    for (const enabled of [true, false]) {
      resetWsBridge.mockClear();

      const response = await new Promise((resolve) => {
        void handleSetCliEnabled({ action: "setCliEnabled", enabled }, resolve);
      });

      expect(response).toEqual({ success: true });
      expect(setCliEnabled).toHaveBeenLastCalledWith(enabled);
      expect(resetWsBridge).toHaveBeenCalledTimes(1);
      expect(applyWsBridgeSettings).not.toHaveBeenCalled();
    }
  });
});
