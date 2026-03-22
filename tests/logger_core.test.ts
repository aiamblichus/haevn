import { beforeEach, describe, expect, it } from "vitest";
import { configureLogger, log, LogLevel } from "../src/utils/logger/core";
import type { LogEntry, LogTransport } from "../src/utils/logger/types";

class TestTransport implements LogTransport {
  public entries: LogEntry[] = [];

  send(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("logger core serialization", () => {
  let transport: TestTransport;

  beforeEach(() => {
    transport = new TestTransport();
    configureLogger({
      transport,
      config: { minLevel: LogLevel.DEBUG },
    });
  });

  it("serializes Error objects with message and stack", () => {
    const err = new Error("boom");
    log.error("test error", err);

    expect(transport.entries.length).toBe(1);

    const entry = transport.entries[0];
    expect(entry.level).toBe("ERROR");
    expect(Array.isArray(entry.data)).toBe(true);

    const data = entry.data as Array<Record<string, unknown>>;
    expect(data[0]).toMatchObject({
      name: "Error",
      message: "boom",
    });
    expect(typeof data[0].stack).toBe("string");
  });

  it("serializes non-cloneable values to safe forms", () => {
    log.info("test values", {
      bigint: 42n,
      symbol: Symbol("x"),
      fn: () => "x",
    });

    expect(transport.entries.length).toBe(1);
    const entry = transport.entries[0];
    const data = entry.data as Array<Record<string, unknown>>;
    const payload = data[0];

    expect(payload.bigint).toBe("42n");
    expect(payload.symbol).toContain("Symbol(x)");
    expect(payload.fn).toContain("[Function");
  });
});
