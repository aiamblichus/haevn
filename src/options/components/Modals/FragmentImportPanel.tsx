/**
 * The Import dialog's panel for fragments (HVN-163, slice 3): choose or drop .md files or a
 * folder, read the plan the extension makes of them, confirm, and see what was done. The design,
 * with the words of each state and the keyboard walk, is
 * /project/haevn/product/design/fragment-import. Nothing is written before the person confirms,
 * and the page never writes to the person's files.
 *
 * The panel holds the state of the view and the keyboard's way through it. The set of files and
 * its runs are `FragmentSession`, the import is `useFragmentImport`, the list of files is
 * `FragmentPlanList`, and the result is `FragmentDoneView` (HVN-178).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { fireAndForget } from "../../../utils/error_utils";
import { log } from "../../../utils/logger";
import {
  type FragmentSource,
  sourceFromFolderPick,
  takeDroppedItems,
} from "../../import/fragmentFiles";
import { askFragments } from "../../import/fragmentImportApi";
import type { ImportRunState } from "../../import/fragmentImportRun";
import {
  describePlan,
  indexesLater,
  inSentence,
  leftOutLine,
  planHeading,
  plural,
  replacedLine,
} from "../../import/fragmentPlanView";
import { FragmentSession, type RunView, type SessionState } from "../../import/fragmentSession";
import { hasFiles } from "../../import/windowDropGuard";
import { FragmentDoneView } from "./FragmentDoneView";
import { FragmentPlanList, type PlanListState } from "./FragmentPlanList";
import { Bar, CancelFooter, DOCS, Footer, Heading, NoticeBox } from "./fragmentParts";
import { useFragmentImport } from "./useFragmentImport";

/** What the import itself shows, over what the session shows: the run, the result */
type View = RunView | Exclude<ImportRunState, { kind: "idle" }>;

interface FragmentImportPanelProps {
  /** The dialog is held (Esc and the close button do nothing) while an import runs */
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  /** Close the dialog and show the archive filtered to fragments */
  onShowFragments: () => void;
  /** The archive's list is out of date: chats were written. The panel waits for it, so that its
   *  status line is the last word and not the list's "Loaded." */
  onImported: () => void | Promise<void>;
  /** Focus "Choose files…" as the panel opens (the dialog was opened on this format alone) */
  focusFirst: boolean;
}

export const FragmentImportPanel = ({
  onBusyChange,
  onClose,
  onShowFragments,
  onImported,
  focusFirst,
}: FragmentImportPanelProps) => {
  // The session's every change gives way the import's view (a result, a notice): the import is
  // made after the session, so the session is told through here
  const resetImport = useRef<() => void>(() => {});
  const sessionRef = useRef<FragmentSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new FragmentSession({
      ask: (files) => askFragments(files, { dryRun: true, overwrite: true }),
      onChange: (state) => {
        setRun(state);
        resetImport.current();
      },
      onError: (err) => log.warn("[FragmentImport] Could not read the chosen files", err),
    });
  }
  const session = sessionRef.current;
  const [run, setRun] = useState<SessionState>(session.snapshot);
  const importRun = useFragmentImport({
    session,
    onBusyChange,
    onImported,
    onDone: () => setExpanded(new Set()),
  });
  resetImport.current = importRun.reset;
  const imported = importRun.state;
  const view: View = imported.kind === "idle" ? run.view : imported;
  // What an import that did not run said (another operation holds the lock, it stopped)
  const importNotice = imported.kind === "idle" ? imported.notice : undefined;
  const plan = imported.kind === "done" ? imported.plan : run.plan;
  const [replace, setReplace] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const viewKindRef = useRef<View["kind"]>("empty");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const importingRef = useRef(false);
  const chooseFilesRef = useRef<HTMLButtonElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const previousKind = useRef<View["kind"] | null>(null);

  const importing = view.kind === "importing";
  importingRef.current = importing;
  viewKindRef.current = view.kind;

  // Clear: nothing is kept, the Replace choice included
  const startAgain = useCallback(() => {
    session.clear();
    setReplace(true);
    setExpanded(new Set());
  }, [session]);

  // The end of the dialog: nothing the session still runs reports after this
  useEffect(() => {
    return () => sessionRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (focusFirst) chooseFilesRef.current?.focus();
  }, [focusFirst]);

  // Focus follows the task: the status heading, then the plan's, then the result's
  useEffect(() => {
    const before = previousKind.current;
    previousKind.current = view.kind;
    if (before === view.kind) return;
    if (view.kind === "empty") {
      if (before !== null) chooseFilesRef.current?.focus();
    } else if (view.kind === "plan" && before === "importing") {
      // A notice after Import (busy, stopped): the button that was pressed, enabled again
      importButtonRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [view.kind]);

  // The whole dialog takes a drop, not only the zone: a file let go on the title or the format row
  // would otherwise do nothing, with the cursor saying it would
  useEffect(() => {
    const target = panelRef.current?.closest<HTMLElement>('[role="dialog"]') ?? panelRef.current;
    if (!target) return;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current += 1;
      if (!importingRef.current) setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!importingRef.current) setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (importingRef.current) return;
      // The items are gone when this handler returns: take them before anything is awaited
      const items = takeDroppedItems(event.dataTransfer);
      // A drop after a result starts again: what was imported is not a set to add to
      if (viewKindRef.current === "done") startAgain();
      session.addDropped(items);
    };
    target.addEventListener("dragenter", enter);
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
    };
  }, [session, startAgain]);

  const retry = () => session.retry();

  const choose = (event: React.ChangeEvent<HTMLInputElement>, folder: boolean) => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0 || importingRef.current) return;
    if (viewKindRef.current === "done") startAgain();
    if (folder) {
      const source = sourceFromFolderPick(files);
      if (source) session.add([source]);
    } else {
      session.add(files.map((file): FragmentSource => ({ kind: "file", file })));
    }
  };

  const copy = (text: string, announce: string, id: string) => {
    fireAndForget(
      navigator.clipboard.writeText(text).then(
        () => {
          setAnnouncement(announce);
          setCopied(id);
          setTimeout(() => {
            setCopied((now) => (now === id ? null : now));
            setAnnouncement((now) => (now === announce ? "" : now));
          }, 2000);
        },
        () => setAnnouncement("Could not copy: select the text and copy it by hand."),
      ),
      "Copy to the clipboard",
    );
  };

  const toggle = (key: string) =>
    setExpanded((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ─── Pieces ────────────────────────────────────────────────────────────────

  const gathered = session.gathered;
  const summary = describePlan(plan, { replace });
  const everyRefused =
    summary.toImport === 0 && summary.changedCount === 0 && summary.refusedCount > 0;

  const list: PlanListState = {
    gathered,
    onReplaceChange: setReplace,
    expanded,
    onToggle: toggle,
    copied,
    onCopy: copy,
  };

  // More files are added to the set; Clear is the way to start again with none (HVN-179)
  const setButtons = (disabled: boolean) => (
    <>
      <Button variant="outline" disabled={disabled} onClick={() => filesInputRef.current?.click()}>
        Add files…
      </Button>
      <Button variant="outline" disabled={disabled} onClick={() => folderInputRef.current?.click()}>
        Add a folder…
      </Button>
      <Button variant="outline" disabled={disabled} onClick={startAgain}>
        Clear
      </Button>
    </>
  );
  const chooseOther = setButtons(importing);
  const cancelFooter = <CancelFooter onClose={onClose} />;

  // ─── The views ─────────────────────────────────────────────────────────────

  let body: React.ReactNode;
  switch (view.kind) {
    case "empty":
      body = (
        <>
          <div
            className={cn(
              "grid justify-items-center gap-3 border-2 px-4 py-6 text-center",
              dragging
                ? "border-solid border-primary bg-primary/10"
                : "border-dashed border-border",
            )}
          >
            <div
              className={cn(
                "text-[15px] font-semibold",
                dragging ? "text-primary" : "text-foreground",
              )}
            >
              {dragging ? "Release to read these files" : "Drop .md files or a folder here"}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                ref={chooseFilesRef}
                variant="outline"
                onClick={() => filesInputRef.current?.click()}
              >
                Choose files…
              </Button>
              <span className="text-xs text-muted-foreground">or</span>
              <Button variant="outline" onClick={() => folderInputRef.current?.click()}>
                Choose a folder…
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              A folder is read flat: its .md files, not its subfolders.{" "}
              <a
                className="text-primary underline underline-offset-4"
                href={DOCS}
                target="_blank"
                rel="noreferrer"
              >
                How to write a fragment
              </a>
            </div>
          </div>
          {run.notice && <NoticeBox notice={run.notice} />}
          {cancelFooter}
        </>
      );
      break;
    case "listing":
      body = (
        <>
          <div role="status" className="grid gap-1.5">
            <Heading headingRef={headingRef}>Reading the folder…</Heading>
            <Bar />
            <div className="text-xs text-muted-foreground">
              Nothing is written until you confirm.
            </div>
          </div>
          {cancelFooter}
        </>
      );
      break;
    case "reading":
      body = (
        <>
          <div role="status" className="grid gap-1.5">
            <Heading headingRef={headingRef}>
              Reading {view.read} of {view.total} files…
            </Heading>
            <Bar value={Math.round((view.read / view.total) * 100)} label="Reading files" />
            <div className="text-xs text-muted-foreground">
              {gathered && gathered.folders.length === 1 && gathered.looseFiles === 0
                ? `From ${gathered.folders[0]}/. `
                : ""}
              Nothing is written until you confirm.
            </div>
          </div>
          {cancelFooter}
        </>
      );
      break;
    case "checking":
      body = (
        <>
          <div role="status" className="grid gap-1.5">
            <Heading headingRef={headingRef}>
              Checking {plural(view.total, "file")} against the archive…
            </Heading>
            <Bar />
            <div className="text-xs text-muted-foreground">
              Nothing is written until you confirm.
            </div>
          </div>
          {cancelFooter}
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <NoticeBox
            notice={{
              tone: "bad",
              title: "The files could not be checked.",
              body: `The archive did not answer: ${inSentence(view.error)}. Nothing was written.`,
            }}
            headingRef={headingRef}
          />
          <Footer
            left={chooseOther}
            right={
              <>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={retry}>Try again</Button>
              </>
            }
          />
        </>
      );
      break;
    case "plan":
    case "importing": {
      const waiting = view.kind === "importing";
      const nothingNew =
        summary.toImport === 0 && summary.changedCount === 0 && summary.refusedCount === 0;
      const total = plan.length;
      let title: string;
      let counts: React.ReactNode;
      if (waiting) {
        title = `Importing ${plural(view.count, "fragment")}…`;
      } else if (everyRefused) {
        title = "Nothing can be imported";
      } else if (nothingNew) {
        title = "Nothing to import";
      } else {
        title = gathered ? planHeading(total, gathered) : plural(total, "file");
      }
      const left = gathered ? leftOutLine(gathered) : "";
      const replacedText = replacedLine(run.replaced);
      if (everyRefused) {
        counts = (
          <>
            <span>
              <b className="text-foreground">{total}</b> {total === 1 ? "file" : "files"}
            </span>
            {summary.unchangedCount > 0 && (
              <span>
                <b className="text-foreground">{summary.unchangedCount}</b> unchanged
              </span>
            )}
            {summary.sameFileCount > 0 && (
              <span>
                <b className="text-foreground">{summary.sameFileCount}</b> same file
              </span>
            )}
            <span className="text-destructive">
              <b>{summary.refusedCount}</b> refused
            </span>
          </>
        );
      } else if (nothingNew) {
        counts = (
          <span>
            All <b className="text-foreground">{total}</b> files are in the archive as they are.
          </span>
        );
      } else {
        counts = (
          <>
            <span>
              <b className="text-foreground">{summary.toImport}</b> to import
            </span>
            {summary.unchangedCount > 0 && (
              <span>
                <b className="text-foreground">{summary.unchangedCount}</b> unchanged
              </span>
            )}
            {summary.sameFileCount > 0 && (
              <span>
                <b className="text-foreground">{summary.sameFileCount}</b> same file
              </span>
            )}
            {summary.refusedCount > 0 && (
              <span className="text-destructive">
                <b>{summary.refusedCount}</b> refused
              </span>
            )}
            {summary.warnedCount > 0 && (
              <span className="text-secondary">
                <b>{summary.warnedCount}</b> with warnings
              </span>
            )}
          </>
        );
      }
      const importable = summary.toImport > 0;
      const groups = describePlan(plan, { replace, allRefused: everyRefused }).groups;
      body = (
        <>
          {waiting ? (
            <div role="status" className="grid gap-1.5">
              <Heading headingRef={headingRef}>{title}</Heading>
              <Bar />
              {indexesLater(summary) && (
                <div className="text-xs text-muted-foreground">
                  Search finds them when the index rebuild ends.
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-1">
              <Heading headingRef={headingRef}>{title}</Heading>
              <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[13px] text-muted-foreground [&_b]:font-bold">
                {counts}
              </div>
              {nothingNew && (
                <div className="text-xs text-muted-foreground">
                  Edit a file and import it again to change its chat.
                </div>
              )}
              {left && <div className="text-xs text-muted-foreground">{left}</div>}
              {replacedText && <div className="text-xs text-muted-foreground">{replacedText}</div>}
            </div>
          )}
          {!waiting && importNotice && <NoticeBox notice={importNotice} />}
          {!waiting && run.notice && <NoticeBox notice={run.notice} />}
          {!waiting && (
            <FragmentPlanList
              {...list}
              label="Files"
              groups={groups}
              plan={plan}
              replace={replace}
            />
          )}
          {waiting ? (
            <Footer
              left={setButtons(true)}
              right={
                <>
                  <Button variant="outline" disabled>
                    Cancel
                  </Button>
                  <Button disabled>Importing…</Button>
                </>
              }
            />
          ) : (
            <Footer
              left={chooseOther}
              right={
                everyRefused || nothingNew ? (
                  <Button variant="outline" onClick={onClose}>
                    Close
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button
                      ref={importButtonRef}
                      disabled={!importable}
                      onClick={() => void importRun.confirm(plan, replace)}
                    >
                      {importable ? `Import ${plural(summary.toImport, "fragment")}` : "Import"}
                    </Button>
                  </>
                )
              }
            />
          )}
        </>
      );
      break;
    }
    case "done":
      body = (
        <FragmentDoneView
          outcome={view.outcome}
          replace={view.replace}
          plan={view.plan}
          headingRef={headingRef}
          list={list}
          onImportMore={startAgain}
          onClose={onClose}
          onShowFragments={onShowFragments}
        />
      );
      break;
  }

  return (
    <div
      ref={panelRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3",
        dragging && view.kind !== "empty" && "outline outline-2 outline-primary",
      )}
    >
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".md,text/markdown"
        name="fragment-files"
        aria-label="Choose .md files"
        className="hidden"
        tabIndex={-1}
        onChange={(event) => choose(event, false)}
      />
      <input
        ref={folderInputRef}
        type="file"
        name="fragment-folder"
        aria-label="Choose a folder of .md files"
        className="hidden"
        tabIndex={-1}
        {...({ webkitdirectory: "" } as object)}
        onChange={(event) => choose(event, true)}
      />
      <div role="status" className="sr-only">
        {announcement}
      </div>
      {body}
    </div>
  );
};
