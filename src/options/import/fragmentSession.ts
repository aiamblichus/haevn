/**
 * The files of the fragment import dialog, and the runs that read and check them (HVN-163 slice 3,
 * HVN-179). The dialog holds a set of what the person has given: each drop or pick is added to it,
 * a file of the same name replaces the earlier one, and the plan is the plan of the whole set,
 * asked for again (one dry run) each time the set grows. Plain TypeScript, so that a test can drive
 * it with a file list and a fake service: the React panel only shows its state.
 *
 * Which run may report. Every run (read the files, ask for the plan) has a number, and only the
 * latest reports: a drop that arrives while the first is being read or checked adds its files at
 * once, starts a run over the whole set, and the first run's answer is thrown away when it comes,
 * so a plan is never shown for a set that is no longer the set. A drop listed from a folder is
 * added in the order it was dropped, whatever order the listings end in. Clear, and the end of the
 * session, throw away what was still being listed.
 */

import type { FragmentPlanEntry } from "../../providers/fragment/model";
import {
  addSources,
  type DroppedItem,
  type FragmentSource,
  type GatheredFragments,
  gatherFragmentSources,
  overLimit,
  type ReadCache,
  type ReadFragments,
  readFragmentFiles,
  sourcesFromDrop,
} from "./fragmentFiles";
import type { FragmentAnswer } from "./fragmentImportApi";
import {
  type Notice,
  noMarkdownNotice,
  overLimitNotice,
  readFailedNotice,
} from "./fragmentPlanView";

export type NoticeTone = "info" | "bad" | "warn";
export type ToneNotice = Notice & { tone: NoticeTone };

/** What the run phases show; the panel adds the import's own (importing, done) */
export type RunView =
  | { kind: "empty" }
  | { kind: "listing" }
  | { kind: "reading"; read: number; total: number }
  | { kind: "checking"; total: number }
  | { kind: "failed"; error: string }
  | { kind: "plan"; notice?: ToneNotice };

export interface SessionState {
  view: RunView;
  /** The plan of the set: the files refused here (not UTF-8) and the service's entries */
  plan: FragmentPlanEntry[];
  /** What a drop or pick that was not taken in whole said, until the next one or Clear */
  notice?: ToneNotice;
  /** The `.md` files replaced by a later copy of the same name, since the last Clear */
  replaced: string[];
}

export interface SessionHooks {
  /** A dry run: the plan of these files */
  ask: (files: ReadFragments["files"]) => Promise<FragmentAnswer>;
  /** The state changed: show it */
  onChange: (state: SessionState) => void;
  /** Something threw that the person is not told in its own words (a folder that would not list) */
  onError?: (error: unknown) => void;
}

const EMPTY: SessionState = { view: { kind: "empty" }, plan: [], replaced: [] };

export class FragmentSession {
  private sources: FragmentSource[] = [];
  private cache: ReadCache = new WeakMap();
  private run = 0;
  private epoch = 0;
  private locked = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private running: Promise<void> = Promise.resolve();
  private state: SessionState = EMPTY;
  /** What showed before a folder was being listed, for when the listing ends without a run */
  private viewBeforeListing: RunView = { kind: "empty" };

  /** The `.md` files and what was left out, of the set as it is now */
  gathered: GatheredFragments | null = null;
  /** The text of the files the plan was asked for (what an import sends) */
  read: ReadFragments | null = null;

  constructor(private readonly hooks: SessionHooks) {}

  get snapshot(): SessionState {
    return this.state;
  }

  /** Resolves when everything started so far has ended (a test waits on it) */
  async settled(): Promise<void> {
    let before: Promise<void>;
    do {
      before = this.running;
      await this.queue;
      await this.running;
    } while (before !== this.running);
  }

  /** An import is running: nothing is added, and no run may report over it */
  lock(on: boolean): void {
    this.locked = on;
    if (on) this.run++;
  }

  /** Starts again with nothing */
  clear(): void {
    this.epoch++;
    this.run++;
    this.sources = [];
    this.gathered = null;
    this.read = null;
    this.state = EMPTY;
    this.emit(EMPTY);
  }

  /** The dialog is closed: nothing reports after this */
  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.run++;
  }

  /** Adds files that are already in hand (a pick) */
  add(added: FragmentSource[]): void {
    this.commit(added);
  }

  /**
   * Adds what a drop holds. The items must have been taken in the drop event. A dropped folder is
   * listed first, which can be long, so it has a state of its own.
   */
  addDropped(items: DroppedItem[]): void {
    if (this.locked || this.disposed) return;
    if (!items.some((item) => item.file || item.entry)) return;
    const epoch = this.epoch;
    const listing = sourcesFromDrop(items);
    listing.catch(() => {}); // told below, in its turn
    if (items.some((item) => item.entry?.isDirectory)) {
      if (this.state.view.kind !== "listing") this.viewBeforeListing = this.state.view;
      this.emit({ ...this.state, view: { kind: "listing" } });
    }
    this.queue = this.queue.then(async () => {
      let sources: FragmentSource[];
      try {
        sources = await listing;
      } catch (err) {
        if (epoch !== this.epoch) return;
        this.hooks.onError?.(err);
        this.emit({
          ...this.state,
          view: this.restingView(),
          notice: { tone: "bad", ...readFailedNotice() },
        });
        return;
      }
      if (epoch !== this.epoch) return;
      this.commit(sources);
    });
  }

  /** Asks again for the plan of the files already read, after a check that failed */
  retry(): void {
    if (!this.read || this.disposed || this.locked) return;
    const run = ++this.run;
    this.running = this.check(run, this.read);
  }

  // ─── The set ───────────────────────────────────────────────────────────────

  private commit(added: FragmentSource[]): void {
    if (this.locked || this.disposed || added.length === 0) return;
    const merged = addSources(this.sources, added);
    const gathered = gatherFragmentSources(merged.sources);
    const hadFiles = this.sources.length > 0;

    if (overLimit(gathered)) {
      // The set is not changed: what was here stays, and the drop is said not to be in
      this.emit({
        ...this.state,
        view: this.restingView(),
        notice: { tone: "bad", ...overLimitNotice(gathered, hadFiles) },
      });
      return;
    }

    this.sources = merged.sources;
    this.gathered = gathered;
    const replaced = [...this.state.replaced];
    for (const name of merged.replaced) if (!replaced.includes(name)) replaced.push(name);

    const own = gatherFragmentSources(added);
    if (gathered.candidates.length === 0) {
      this.read = null;
      this.emit({
        view: { kind: "empty" },
        plan: [],
        replaced,
        notice: { tone: "info", ...noMarkdownNotice(own) },
      });
      return;
    }
    if (hadFiles && own.candidates.length === 0) {
      // Nothing to read in this drop (text files, an empty folder): the set, and its plan, stand
      this.emit({
        ...this.state,
        view: this.restingView(),
        replaced,
        notice: { tone: "info", ...noMarkdownNotice(own, true) },
      });
      return;
    }

    const run = ++this.run;
    this.read = null;
    this.state = { ...this.state, replaced, notice: undefined };
    this.running = this.execute(run, gathered);
  }

  /** What shows when a listing ends and no run takes over: what showed before it began */
  private restingView(): RunView {
    const view = this.state.view;
    return view.kind === "listing" ? this.viewBeforeListing : view;
  }

  // ─── A run ─────────────────────────────────────────────────────────────────

  private async execute(run: number, gathered: GatheredFragments): Promise<void> {
    const total = gathered.candidates.length;
    this.emit({ ...this.state, view: { kind: "reading", read: 0, total } });
    let read: ReadFragments | undefined;
    try {
      read = await readFragmentFiles(
        gathered,
        {
          onProgress: (n) => {
            if (run === this.run)
              this.emit({ ...this.state, view: { kind: "reading", read: n, total } });
          },
          isCancelled: () => run !== this.run,
        },
        this.cache,
      );
    } catch (err) {
      if (run !== this.run) return;
      this.hooks.onError?.(err);
      this.read = null;
      this.emit({
        view: { kind: "empty" },
        plan: [],
        replaced: this.state.replaced,
        notice: { tone: "bad", ...readFailedNotice() },
      });
      return;
    }
    if (!read || run !== this.run) return;
    this.read = read;
    if (read.files.length === 0) {
      // Every file was refused here: there is nothing to ask the service
      this.emit({ ...this.state, view: { kind: "plan" }, plan: read.refused });
      return;
    }
    await this.check(run, read);
  }

  private async check(run: number, read: ReadFragments): Promise<void> {
    this.emit({ ...this.state, view: { kind: "checking", total: read.files.length } });
    const answer = await this.hooks.ask(read.files);
    if (run !== this.run) return;
    if (!answer.ok) {
      this.emit({
        ...this.state,
        view: { kind: "failed", error: "busy" in answer ? "the extension is busy" : answer.error },
      });
      return;
    }
    this.emit({
      ...this.state,
      view: { kind: "plan" },
      plan: [...read.refused, ...answer.reply.plan],
    });
  }

  private emit(state: SessionState): void {
    this.state = state;
    if (!this.disposed) this.hooks.onChange(state);
  }
}
