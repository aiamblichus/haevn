import { beforeEach, describe, expect, it } from "vitest";
import { loggerService } from "../src/services/loggerService";
import type { LogEntry } from "../src/utils/logger/types";

function entry(level: LogEntry["level"], message: string): LogEntry {
  return { id: message, timestamp: Date.now(), level, message, context: "test" };
}

describe("Read level keeps that level and the ones above it (HVN-156)", () => {
  beforeEach(async () => {
    await loggerService.clearLogs();
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"] as const) {
      loggerService.addEntry(entry(level, level.toLowerCase()));
    }
  });

  it("warn returns WARN and ERROR, but not INFO or DEBUG", () => {
    const levels = loggerService.getLogs({ level: "WARN" }).map((l) => l.level);

    expect(levels).toEqual(["WARN", "ERROR"]);
  });

  it("error returns ERROR alone, and debug returns every entry", () => {
    expect(loggerService.getLogs({ level: "ERROR" }).map((l) => l.level)).toEqual(["ERROR"]);
    expect(loggerService.getLogs({ level: "DEBUG" }).map((l) => l.level)).toEqual([
      "DEBUG",
      "INFO",
      "WARN",
      "ERROR",
    ]);
  });
});
