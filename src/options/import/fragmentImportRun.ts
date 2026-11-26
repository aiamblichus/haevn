/**
 * The import of the planned fragments, as the dialog runs it (HVN-163 slice 3, HVN-178): the person
 * confirms, the files go to the service for real, and what comes back is the result or a notice.
 * Plain TypeScript, so that a test can drive it with a fake service: the React hook
 * (`useFragmentImport`) only shows its state.
 *
 * While it runs the session is locked (nothing is added, no check reports over it) and the dialog
 * is held busy. Every run has a number, and only the latest may report: a run that outlives the
 * dialog finds itself stale when the answer comes, releases what it held and says nothing.
 */

import type { FragmentFile, FragmentPlanEntry } from "../../providers/fragment/model";
import type { ReadFragments } from "./fragmentFiles";
import type { FragmentAnswer } from "./fragmentImportApi";
import {
  busyNotice,
  describeOutcome,
  describePlan,
  type ImportOutcome,
  inSentence,
  plural,
} from "./fragmentPlanView";
import type { ToneNotice } from "./fragmentSession";

/**
 * What the import shows over what the session shows. Idle shows the session; `notice` is what an
 * import that did not run said (another operation holds the lock, it stopped).
 */
export type ImportRunState =
  | { kind: "idle"; notice?: ToneNotice }
  | { kind: "importing"; count: number }
  | { kind: "done"; outcome: ImportOutcome; replace: boolean; plan: FragmentPlanEntry[] };

/** The part of the session the import needs */
export interface RunSession {
  /** The text of the files the plan was asked for */
  readonly read: ReadFragments | null;
  lock(on: boolean): void;
}

export interface ImportRunHooks {
  /** The import itself, not a dry run */
  ask: (files: FragmentFile[], options: { overwrite: boolean }) => Promise<FragmentAnswer>;
  /** The state changed: show it */
  onChange: (state: ImportRunState) => void;
  /** The dialog is held (Esc and the close button do nothing) while this is true */
  onBusyChange: (busy: boolean) => void;
  /** The archive's list is out of date: chats were written. Resolves when it has reloaded */
  onImported: () => void | Promise<void>;
  /** The line for the status bar, said last, after the list has reloaded */
  onStatus: (text: string, tone: "ok" | "warn") => void;
}

const IDLE: ImportRunState = { kind: "idle" };

export class FragmentImportRun {
  private run = 0;
  private state: ImportRunState = IDLE;

  constructor(
    private readonly session: RunSession,
    private readonly hooks: ImportRunHooks,
  ) {}

  get snapshot(): ImportRunState {
    return this.state;
  }

  /** The session said something new (a drop, Clear): what the import showed gives way to it */
  reset(): void {
    this.emit(IDLE);
  }

  /** The dialog is closed: a run still in flight finds itself stale and says nothing */
  dispose(): void {
    this.run++;
  }

  /** Imports the files the plan was made of, with the plan's Replace choice */
  async confirm(plan: FragmentPlanEntry[], replace: boolean): Promise<void> {
    const read = this.session.read;
    if (!read) return;
    const run = ++this.run;
    const count = describePlan(plan, { replace }).toImport;
    // Nothing is added to the set, and no check reports over it, until the import ends
    this.session.lock(true);
    this.emit({ kind: "importing", count });
    this.hooks.onBusyChange(true);
    const answer = await this.hooks.ask(read.files, { overwrite: replace });
    this.hooks.onBusyChange(false);
    this.session.lock(false);
    if (run !== this.run) return;
    if (!answer.ok) {
      this.emit({
        kind: "idle",
        notice:
          "busy" in answer
            ? { tone: "bad", ...busyNotice(answer.busy) }
            : {
                tone: "bad",
                title: `The import stopped: ${inSentence(answer.error)}.`,
                body: "Choose the files again: the plan will show what is already in.",
              },
      });
      return;
    }
    const done = [...read.refused, ...answer.reply.plan];
    const outcome = describeOutcome({ ...answer.reply, plan: done }, { replace });
    this.emit({ kind: "done", outcome, replace, plan: done });
    // The list reloads, and says "Loaded." when it is done: this is said after it, or it is lost
    await this.hooks.onImported();
    this.hooks.onStatus(
      `Imported ${plural(outcome.saved, "fragment")}.`,
      outcome.failed.length > 0 || outcome.indexError ? "warn" : "ok",
    );
  }

  private emit(state: ImportRunState): void {
    this.state = state;
    this.hooks.onChange(state);
  }
}
