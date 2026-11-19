/**
 * The popup's status line (HVN-110): the outcome of the last action, under the header. The DOM
 * sits in popup.ts. What the line says and how it is styled lives here, so a test can hold it.
 */

export type PopupStatusKind = "info" | "working" | "success" | "warning" | "error";

/** The line a popup shows when nothing has happened yet: the page is ready to sync. */
export const READY_TEXT = "Ready to sync";

const BASE_CLASSES = "p-2 border-2 text-xs font-bold break-words";

// Literal class names, so the popup's Tailwind build keeps them. Error uses the theme's destructive
// token; success uses the green of the SYNCED indicator.
const KIND_CLASSES: Record<PopupStatusKind, string> = {
  info: "text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]",
  working: "text-[hsl(var(--foreground))] border-[hsl(var(--border))]",
  success: "text-green-500 border-green-500",
  warning: "text-[hsl(var(--secondary))] border-[hsl(var(--secondary))]",
  error:
    "text-[hsl(var(--destructive))] border-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.1)]",
};

/** The full class list of the status line for a kind. */
export function statusClassName(kind: PopupStatusKind): string {
  return `${BASE_CLASSES} ${KIND_CLASSES[kind]}`;
}

/**
 * The text a failed action shows: the error the background returned, or the fallback when it sent
 * none. A failed sync throws the background's message, so it arrives here as an Error.
 */
export function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return fallback;
}

/** The kind of a finished bulk sync: success when every chat synced, error when some did not. */
export function bulkCompleteKind(failedCount?: number): PopupStatusKind {
  return failedCount !== undefined && failedCount > 0 ? "error" : "success";
}

/**
 * Holds the status line's latest message. A reset scheduled after a success puts the resting line
 * back only when nothing was shown since it was scheduled, so an earlier success cannot wipe a
 * later failure before the user reads it.
 */
export class PopupStatus {
  private revision = 0;
  private readonly render: (text: string, kind: PopupStatusKind) => void;

  constructor(render: (text: string, kind: PopupStatusKind) => void) {
    this.render = render;
  }

  show(text: string, kind: PopupStatusKind): void {
    this.revision++;
    this.render(text, kind);
  }

  /** Hides the line: an action that runs in the progress view has nothing to report here. */
  clear(): void {
    this.revision++;
    this.render("", "info");
  }

  /** Puts the resting line back after `ms`, unless another message was shown in the meantime. */
  restAfter(ms: number): void {
    const scheduledAt = this.revision;
    setTimeout(() => {
      if (this.revision === scheduledAt) this.show(READY_TEXT, "info");
    }, ms);
  }
}
