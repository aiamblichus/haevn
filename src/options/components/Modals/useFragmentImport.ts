/**
 * The import of the planned fragments, for the panel (HVN-178): the run (`FragmentImportRun`,
 * which a test drives with a fake service), its state, and what to do when the dialog closes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FragmentPlanEntry } from "../../../providers/fragment/model";
import { useStatus } from "../../context/StatusContext";
import { askFragments } from "../../import/fragmentImportApi";
import {
  FragmentImportRun,
  type ImportRunState,
  type RunSession,
} from "../../import/fragmentImportRun";

interface UseFragmentImportOptions {
  session: RunSession;
  /** The dialog is held (Esc and the close button do nothing) while an import runs */
  onBusyChange: (busy: boolean) => void;
  /** The archive's list is out of date: chats were written. Resolves when it has reloaded */
  onImported: () => void | Promise<void>;
  /** The result is on show: what the plan had folded or opened does not carry over to it */
  onDone: () => void;
}

export function useFragmentImport({
  session,
  onBusyChange,
  onImported,
  onDone,
}: UseFragmentImportOptions) {
  const { setStatus } = useStatus();
  // What the run calls is the latest of the props, not the first render's
  const latest = useRef({ onBusyChange, onImported, onDone, setStatus });
  latest.current = { onBusyChange, onImported, onDone, setStatus };

  const [state, setState] = useState<ImportRunState>({ kind: "idle" });
  const runRef = useRef<FragmentImportRun | null>(null);
  if (runRef.current === null) {
    runRef.current = new FragmentImportRun(session, {
      ask: (files, options) => askFragments(files, { dryRun: false, ...options }),
      onChange: (next) => {
        if (next.kind === "done") latest.current.onDone();
        setState(next);
      },
      onBusyChange: (busy) => latest.current.onBusyChange(busy),
      onImported: () => latest.current.onImported(),
      onStatus: (text, tone) => latest.current.setStatus(text, tone),
    });
  }
  const run = runRef.current;

  useEffect(() => () => run.dispose(), [run]);

  const confirm = useCallback(
    (plan: FragmentPlanEntry[], replace: boolean) => run.confirm(plan, replace),
    [run],
  );
  const reset = useCallback(() => run.reset(), [run]);

  return { state, confirm, reset };
}
