/**
 * The scrolling list of files in the fragment import dialog (HVN-163, slice 3).
 *
 * It is `relative` on purpose. A row's "Warning:" label is `sr-only`, which is `position:
 * absolute`; without a positioned ancestor here its box is placed against the fixed dialog, deep
 * inside the list's content, and stretches the dialog's own scroll area to a few thousand pixels,
 * so that one wheel turn scrolls the whole plan out of the dialog. `tests/fragmentFilesRegion.test.tsx`
 * keeps it so.
 */

import type { ReactNode } from "react";

export const FilesRegion = ({ label, children }: { label: string; children: ReactNode }) => (
  <div
    role="region"
    aria-label={label}
    tabIndex={0}
    className="relative min-h-[10rem] flex-1 overflow-y-auto border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    {children}
  </div>
);
