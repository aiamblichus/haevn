import { describe, expect, it } from "vitest";
import { isOlderRun, syncRunId } from "../src/background/bulkSync/runId";

// The id a bulk sync gives its worker requests (HVN-127) and the order the worker puts them in.

describe("syncRunId", () => {
  it("is the run's start and the number of resumes, none being 0", () => {
    expect(syncRunId({ startedAt: 1700000000000 })).toBe("1700000000000:0");
    expect(syncRunId({ startedAt: 1700000000000, resumeCount: 2 })).toBe("1700000000000:2");
  });
});

describe("isOlderRun", () => {
  it("orders by the run's start first", () => {
    expect(isOlderRun("100:3", "200:0")).toBe(true);
    expect(isOlderRun("200:0", "100:3")).toBe(false);
  });

  it("orders the stretches of one run by its resume count", () => {
    expect(isOlderRun("100:0", "100:1")).toBe(true);
    expect(isOlderRun("100:1", "100:0")).toBe(false);
  });

  it("compares numbers, not text", () => {
    expect(isOlderRun("99:0", "100:0")).toBe(true);
    expect(isOlderRun("100:0", "99:0")).toBe(false);
    expect(isOlderRun("100:9", "100:10")).toBe(true);
  });

  it("is not older than itself", () => {
    expect(isOlderRun("100:2", "100:2")).toBe(false);
  });

  it("never calls an id it cannot read older", () => {
    expect(isOlderRun("run-a", "100:0")).toBe(false);
    expect(isOlderRun("100:0", "run-b")).toBe(false);
    expect(isOlderRun(undefined as unknown as string, "100:0")).toBe(false);
  });
});
