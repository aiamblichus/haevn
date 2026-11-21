import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerService } from "../src/services/loggerService";
import { getLogLevel, setLogLevel } from "../src/utils/logger/core";
import { followStoredLogLevel, LOGGER_CONFIG_STORAGE_KEY } from "../src/utils/logger/levelSync";
import { type LogEntry, LogLevel } from "../src/utils/logger/types";

function entry(level: LogEntry["level"], message: string): LogEntry {
  return { id: message, timestamp: Date.now(), level, message, context: "test" };
}

describe("Capture level (HVN-119)", () => {
  beforeEach(async () => {
    await loggerService.clearLogs();
  });

  afterEach(async () => {
    await loggerService.setConfig({ minLevel: LogLevel.DEBUG });
    setLogLevel(LogLevel.DEBUG);
  });

  it("drops entries below minLevel at the sink and keeps the rest", async () => {
    await loggerService.setConfig({ minLevel: LogLevel.WARN });

    loggerService.addEntry(entry("DEBUG", "debug"));
    loggerService.addEntry(entry("INFO", "info"));
    loggerService.addEntry(entry("WARN", "warn"));
    loggerService.addEntry(entry("ERROR", "error"));
    loggerService.addLog(
      { level: "DEBUG", message: "remote debug" },
      { tab: { id: 1 } as chrome.tabs.Tab },
    );
    loggerService.addLog(
      { level: "WARN", message: "remote warn" },
      { tab: { id: 1 } as chrome.tabs.Tab },
    );

    const messages = loggerService.getLogs().map((l) => l.message);
    expect(messages).toEqual(["warn", "error", "remote warn"]);
  });

  it("applies a lowered level to entries that arrive afterwards", async () => {
    await loggerService.setConfig({ minLevel: LogLevel.ERROR });
    loggerService.addEntry(entry("INFO", "dropped"));
    await loggerService.setConfig({ minLevel: LogLevel.INFO });
    loggerService.addEntry(entry("INFO", "kept"));

    expect(loggerService.getLogs().map((l) => l.message)).toEqual(["kept"]);
  });

  it("follows the stored level, at start and on change", async () => {
    const originalChrome = globalThis.chrome;
    let onChanged:
      | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
      | undefined;
    const local = {
      get: vi.fn(async () => ({ [LOGGER_CONFIG_STORAGE_KEY]: { minLevel: LogLevel.WARN } })),
    };
    vi.stubGlobal("chrome", {
      storage: {
        local,
        onChanged: {
          addListener: (fn: typeof onChanged) => {
            onChanged = fn;
          },
        },
      },
    });
    try {
      followStoredLogLevel();
      await vi.waitFor(() => expect(getLogLevel()).toBe(LogLevel.WARN));

      onChanged?.(
        { [LOGGER_CONFIG_STORAGE_KEY]: { newValue: { minLevel: LogLevel.ERROR } } },
        "local",
      );
      expect(getLogLevel()).toBe(LogLevel.ERROR);

      onChanged?.({ other: { newValue: { minLevel: LogLevel.DEBUG } } }, "local");
      onChanged?.(
        { [LOGGER_CONFIG_STORAGE_KEY]: { newValue: { minLevel: LogLevel.DEBUG } } },
        "sync",
      );
      expect(getLogLevel()).toBe(LogLevel.ERROR);
    } finally {
      vi.stubGlobal("chrome", originalChrome);
    }
  });
});
