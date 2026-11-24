/**
 * What a restore would do, in numbers and in words (HVN-137). The block below is what `--dry-run`
 * prints and what the confirmation shows before it asks. Its wording is the Steward's
 * (/project/haevn/product/evidence/backup-restore-promise-review-2026-11-24): the rollback
 * paragraph appears only when something would be replaced, so a restore on a new machine reads
 * short and calm.
 */

import type { BackupContents } from "./readBackup.js";

export interface RestorePlan {
  /** The backup directory. */
  dir: string;
  createdAt: string;
  haevnVersion: string;
  /** What the backup holds in all. */
  backupChats: number;
  backupBytes: number;
  /** What this run restores: all of it, or the chats of `--chat`. */
  chats: number;
  mediaFiles: number;
  bytes: number;
  /** Chats that are live in the archive now: each is replaced. */
  replaced: number;
  /**
   * Of those, the chats whose last sync differs from the backup's. Null when the extension does not
   * say when its chats were synced (an older one).
   */
  changed: number | null;
  /** Chats that are not live in the archive now (new here, or deleted since the backup). */
  added: number;
}

/** What a run restores, as counted; `planOf` joins it to what the manifest says of the backup. */
export type RestoreCounts = Pick<
  RestorePlan,
  "chats" | "mediaFiles" | "bytes" | "replaced" | "changed" | "added"
>;

export function planOf(contents: BackupContents, counts: RestoreCounts): RestorePlan {
  return {
    dir: contents.dir,
    createdAt: contents.manifest.createdAt,
    haevnVersion: contents.manifest.haevnVersion,
    backupChats: contents.manifest.chats,
    backupBytes: contents.manifest.bytes,
    ...counts,
  };
}

/** The block of lines a person reads before deciding. No question at the end: the caller adds it. */
export function formatPlan(plan: RestorePlan): string {
  const lines: string[] = [];
  lines.push(`Restore from ${plan.dir}`);
  lines.push(
    `  backup taken ${when(plan.createdAt)}, ${count(plan.backupChats)} ${chats(plan.backupChats)}, ${size(plan.backupBytes)} (haevn ${plan.haevnVersion})`,
  );
  if (plan.chats !== plan.backupChats) {
    lines.push(
      `  restoring ${count(plan.chats)} of them, ${count(plan.mediaFiles)} media ${files(plan.mediaFiles)}, ${size(plan.bytes)}`,
    );
  }
  lines.push("");

  const width = Math.max(count(plan.replaced).length, count(plan.added).length);
  const number = (n: number): string => count(n).padStart(width);
  const indent = " ".repeat(width + 2);

  if (plan.replaced > 0) {
    lines.push(
      `  ${number(plan.replaced)}  ${plural(plan.replaced, "chat is", "chats are")} in your archive now: ${plural(plan.replaced, "it is", "each is")} replaced by the backup's copy.`,
    );
    if (plan.changed !== null && plan.changed > 0) {
      lines.push(`  ${indent}${syncedAgain(plan)} since the backup.`);
    }
    lines.push(
      `  ${indent}Anything that changed since the backup (new messages, edited titles,`,
      `  ${indent}new AI metadata) is lost from ${plural(plan.replaced, "this chat", "these chats")}.`,
    );
  }
  if (plan.added > 0) {
    lines.push(
      `  ${number(plan.added)}  ${plural(plan.added, "chat is", "chats are")} not in your archive now (new here, or deleted since the`,
      `  ${indent}backup): ${plural(plan.added, "it is", "each is")} added back.`,
    );
  }
  if (plan.replaced > 0 || plan.added > 0) lines.push("");
  lines.push("  Chats that are not in the backup are not touched. Nothing is deleted.");
  return lines.join("\n");
}

/** Who was synced again: "It was" for the only chat, else "1 of them was" or "K of them were". */
function syncedAgain(plan: RestorePlan): string {
  if (plan.replaced === 1) return "It was synced again";
  return `${count(plan.changed ?? 0)} of them ${plan.changed === 1 ? "was" : "were"} synced again`;
}

/** The question under the block. */
export function confirmQuestion(plan: RestorePlan): string {
  return `Restore ${count(plan.chats)} ${chats(plan.chats)} into the haevn connected to this terminal? [y/N] `;
}

// ─── Words and numbers ────────────────────────────────────────────────────────

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function chats(n: number): string {
  return n === 1 ? "chat" : "chats";
}

function files(n: number): string {
  return n === 1 ? "file" : "files";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** The backup's date in the reader's own time, to the minute; the raw text when it does not parse. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "at an unknown time";
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
