/**
 * A file let go beside a drop zone must not take the tab away from the archive (HVN-163, HVN-177).
 * The browser opens a dropped file in the tab unless the page cancels the drop, so while the
 * Import dialog is open the window cancels every drop that carries files, whatever the format.
 */

import { useEffect } from "react";

/** Does this drag carry files (and not text, or a link)? */
export const hasFiles = (event: DragEvent) =>
  event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes("Files");

/** Cancels the drops of files on `target`; the returned function takes the guard off */
export function guardWindowDrops(target: EventTarget): () => void {
  const keep = (event: Event) => {
    if (hasFiles(event as DragEvent)) event.preventDefault();
  };
  target.addEventListener("dragover", keep);
  target.addEventListener("drop", keep);
  return () => {
    target.removeEventListener("dragover", keep);
    target.removeEventListener("drop", keep);
  };
}

/** The guard, on the window, for as long as `active` */
export function useWindowDropGuard(active: boolean): void {
  useEffect(() => (active ? guardWindowDrops(window) : undefined), [active]);
}
