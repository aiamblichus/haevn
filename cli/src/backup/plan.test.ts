import { describe, expect, it } from "vitest";
import { confirmQuestion, formatPlan, type RestorePlan } from "./plan.js";

function plan(extra: Partial<RestorePlan> = {}): RestorePlan {
  return {
    dir: "/restored/haevn/archive",
    createdAt: "2026-11-23T03:00:00.000Z",
    haevnVersion: "1.9.0",
    backupChats: 2_812,
    backupBytes: 1_800_000_000,
    chats: 2_812,
    mediaFiles: 900,
    bytes: 1_800_000_000,
    replaced: 1_204,
    changed: 37,
    added: 1_608,
    ...extra,
  };
}

describe("the block a person reads before a restore", () => {
  it("says what the backup is, what is replaced (with the rollback paragraph) and what is added", () => {
    const text = formatPlan(plan());

    expect(text).toContain("Restore from /restored/haevn/archive");
    expect(text).toMatch(
      /backup taken 2026-11-2\d \d\d:\d\d, 2,812 chats, 1\.7 GB \(haevn 1\.9\.0\)/,
    );
    expect(text).toContain(
      "1,204  chats are in your archive now: each is replaced by the backup's copy.",
    );
    expect(text).toContain("37 of them were synced again since the backup.");
    expect(text).toContain("Anything that changed since the backup (new messages, edited titles,");
    expect(text).toContain("new AI metadata) is lost from these chats.");
    expect(text).toContain(
      "1,608  chats are not in your archive now (new here, or deleted since the",
    );
    expect(text).toContain("backup): each is added back.");
    expect(text).toContain("Chats that are not in the backup are not touched. Nothing is deleted.");
  });

  it("leaves the rollback paragraph out when nothing is replaced: a new machine gets a short, calm block", () => {
    const text = formatPlan(plan({ replaced: 0, changed: 0, added: 2_812 }));

    expect(text).not.toContain("is lost from");
    expect(text).not.toContain("replaced");
    expect(text).not.toContain("changed since");
    expect(text).toContain("2,812  chats are not in your archive now");
    expect(text).toContain("Nothing is deleted.");
  });

  it("says nothing about added chats when none would be added", () => {
    const text = formatPlan(plan({ replaced: 2_812, changed: 5, added: 0 }));

    expect(text).not.toContain("not in your archive now");
    expect(text).not.toContain("added back");
    expect(text).toContain("2,812  chats are in your archive now");
  });

  it("does not claim how many changed when it cannot say, and says nothing of them when none did", () => {
    expect(formatPlan(plan({ changed: null }))).not.toContain("of them changed");
    expect(formatPlan(plan({ changed: 0 }))).not.toContain("of them changed");
    expect(formatPlan(plan({ changed: 0 }))).toContain("is lost from these chats");
  });

  it('says "was" for one chat of several that were synced again', () => {
    expect(formatPlan(plan({ replaced: 40, changed: 1 }))).toContain(
      "1 of them was synced again since the backup.",
    );
  });

  it("names the part of the backup a --chat restore takes", () => {
    const text = formatPlan(
      plan({ chats: 2, replaced: 1, changed: 1, added: 1, mediaFiles: 3, bytes: 5_000 }),
    );

    expect(text).toContain("restoring 2 of them, 3 media files, 4.9 KB");
    expect(text).toContain("1  chat is in your archive now: it is replaced by the backup's copy.");
    expect(text).toContain("It was synced again since the backup.");
    expect(text).toContain("is lost from this chat.");
  });

  it("asks a question that names the count, and the default is no", () => {
    const question = confirmQuestion(plan());

    expect(question).toBe("Restore 2,812 chats into the haevn connected to this terminal? [y/N] ");
  });
});
