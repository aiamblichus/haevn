import { useEffect } from "react";
import { Button } from "../../components/ui/button";

interface UndoToastProps {
  /** How many chats the delete removed. */
  count: number;
  /** When the undo window closes (ms since epoch). The toast goes then, and so does the undo. */
  expiresAt: number;
  onUndo: () => void;
  onDismiss: () => void;
}

/** "Deleted N chats — Undo", shown while the last delete can still be undone. */
export const UndoToast = ({ count, expiresAt, onUndo, onDismiss }: UndoToastProps) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, onDismiss]);

  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-md border border-primary/50 bg-card px-4 py-3 text-sm text-foreground shadow-lg"
    >
      <span>{`Deleted ${count} ${count === 1 ? "chat" : "chats"} —`}</span>
      <Button type="button" variant="outline" size="sm" onClick={onUndo}>
        Undo
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-2"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </Button>
    </div>
  );
};
