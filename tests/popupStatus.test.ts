import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkCompleteKind,
  failureMessage,
  PopupStatus,
  type PopupStatusKind,
  READY_TEXT,
  statusClassName,
} from "../src/popup/status";

// HVN-110: a failed sync shows the background's error in the popup's status line, styled with the
// destructive token; a success is styled apart from it. The DOM is in popup.ts; this is the logic.

describe("failureMessage (HVN-110)", () => {
  it("shows the error the background returned", () => {
    // popup.ts throws the background's message: `new Error(response?.error || "Sync failed")`
    expect(failureMessage(new Error("Could not find organizationId"), "Sync failed")).toBe(
      "Could not find organizationId",
    );
  });

  it("falls back when the error has no message", () => {
    expect(failureMessage(new Error(""), "Sync failed")).toBe("Sync failed");
    expect(failureMessage(new Error("   "), "Sync failed")).toBe("Sync failed");
    expect(failureMessage(undefined, "Sync failed")).toBe("Sync failed");
    expect(failureMessage({ message: "not an Error" }, "Sync failed")).toBe("Sync failed");
  });

  it("passes a string error through", () => {
    expect(failureMessage("Tab has no URL", "Sync failed")).toBe("Tab has no URL");
  });
});

describe("bulkCompleteKind (HVN-110)", () => {
  it("is success when no chat failed", () => {
    expect(bulkCompleteKind(0)).toBe("success");
    expect(bulkCompleteKind(undefined)).toBe("success");
  });

  it("is error when some chats failed", () => {
    expect(bulkCompleteKind(1)).toBe("error");
    expect(bulkCompleteKind(12)).toBe("error");
  });
});

describe("statusClassName (HVN-110)", () => {
  const kinds: PopupStatusKind[] = ["info", "working", "success", "warning", "error"];

  it("styles an error with the theme's destructive token, and no success colour", () => {
    const error = statusClassName("error");
    expect(error).toContain("text-[hsl(var(--destructive))]");
    expect(error).not.toContain("green");
  });

  it("styles a success in green, and not with the destructive token", () => {
    const success = statusClassName("success");
    expect(success).toContain("text-green-500");
    expect(success).not.toContain("destructive");
  });

  it("gives every kind its own class list", () => {
    expect(new Set(kinds.map((kind) => statusClassName(kind))).size).toBe(kinds.length);
  });
});

describe("PopupStatus (HVN-110)", () => {
  let rendered: Array<{ text: string; kind: PopupStatusKind }>;
  let status: PopupStatus;

  beforeEach(() => {
    vi.useFakeTimers();
    rendered = [];
    status = new PopupStatus((text, kind) => rendered.push({ text, kind }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders each message it is given, with its kind", () => {
    status.show("Synced!", "success");
    status.show("Sync failed msg", "error");
    expect(rendered).toEqual([
      { text: "Synced!", kind: "success" },
      { text: "Sync failed msg", kind: "error" },
    ]);
  });

  it("puts the resting line back after the delay when nothing else was shown", () => {
    status.show("Synced!", "success");
    status.restAfter(2000);
    vi.advanceTimersByTime(1999);
    expect(rendered.at(-1)).toEqual({ text: "Synced!", kind: "success" });
    vi.advanceTimersByTime(1);
    expect(rendered.at(-1)).toEqual({ text: READY_TEXT, kind: "info" });
  });

  it("does not let an earlier success's reset wipe a later failure", () => {
    status.show("Synced!", "success");
    status.restAfter(2000);
    vi.advanceTimersByTime(1000);
    status.show("Could not find organizationId", "error");
    vi.advanceTimersByTime(1000);
    // The failure stays on screen: the reset was scheduled before it was shown.
    expect(rendered.at(-1)).toEqual({ text: "Could not find organizationId", kind: "error" });
  });

  it("hides the line on clear, and a reset scheduled before the clear does not bring it back", () => {
    status.show("Starting bulk sync...", "working");
    status.restAfter(3000);
    status.clear();
    vi.advanceTimersByTime(5000);
    expect(rendered.at(-1)).toEqual({ text: "", kind: "info" });
  });
});
