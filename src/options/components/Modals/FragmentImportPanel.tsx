/**
 * The Import dialog's panel for fragments (HVN-163, slice 3): choose or drop .md files or a
 * folder, read the plan the extension makes of them, confirm, and see what was done. The design,
 * with the words of each state and the keyboard walk, is
 * /project/haevn/product/design/fragment-import. Nothing is written before the person confirms,
 * and the page never writes to the person's files.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { cn } from "../../../lib/utils";
import { type FragmentPlanEntry, REFUSED_STATES } from "../../../providers/fragment/model";
import { fireAndForget } from "../../../utils/error_utils";
import { log } from "../../../utils/logger";
import { useStatus } from "../../context/StatusContext";
import {
  type DroppedItem,
  type FragmentSource,
  type GatheredFragments,
  gatherFragmentSources,
  overLimit,
  type ReadFragments,
  readFragmentFiles,
  sourceFromFolderPick,
  sourcesFromDrop,
  takeDroppedItems,
} from "../../import/fragmentFiles";
import { askFragments } from "../../import/fragmentImportApi";
import {
  assignIdsPlan,
  busyNotice,
  describeOutcome,
  describePlan,
  type ImportOutcome,
  idBlock,
  idLine,
  indexesLater,
  inSentence,
  isMissingFrontmatter,
  leftOutLine,
  type Notice,
  noIdWords,
  noMarkdownNotice,
  overLimitNotice,
  type PlanGroup,
  type PlanRow,
  planHeading,
  plural,
  readFailedNotice,
} from "../../import/fragmentPlanView";
import { FilesRegion } from "./FilesRegion";

const DOCS = "https://haevn.pages.dev/user-guide/fragments/";
/** A group longer than this shows this many rows, and a button for the rest */
const ROWS_SHOWN = 20;

type NoticeTone = "info" | "bad" | "warn";
type ToneNotice = Notice & { tone: NoticeTone };

type View =
  | { kind: "empty"; notice?: ToneNotice }
  | { kind: "listing" }
  | { kind: "reading"; read: number; total: number }
  | { kind: "checking"; total: number }
  | { kind: "failed"; error: string }
  | { kind: "plan"; notice?: ToneNotice }
  | { kind: "importing"; count: number }
  | { kind: "done"; outcome: ImportOutcome; replace: boolean };

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

const hasFiles = (event: DragEvent) =>
  event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes("Files");

export const FragmentImportPanel = ({
  onBusyChange,
  onClose,
  onShowFragments,
  onImported,
  focusFirst,
}: FragmentImportPanelProps) => {
  const { setStatus } = useStatus();
  const [view, setView] = useState<View>({ kind: "empty" });
  const [plan, setPlan] = useState<FragmentPlanEntry[]>([]);
  const [replace, setReplace] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const gatheredRef = useRef<GatheredFragments | null>(null);
  const readRef = useRef<ReadFragments | null>(null);
  const runRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const refocusImport = useRef(false);
  const dragDepth = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const importingRef = useRef(false);
  const chooseFilesRef = useRef<HTMLButtonElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const previousKind = useRef<View["kind"] | null>(null);

  const importing = view.kind === "importing";
  importingRef.current = importing;

  // A run that outlives the dialog finds itself stale and stops
  useEffect(() => {
    return () => {
      runRef.current += 1;
    };
  }, []);

  // A file dropped beside the dialog must not take the tab away from the archive
  useEffect(() => {
    const keep = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
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
    } else if (view.kind === "plan" && refocusImport.current) {
      // A notice after Import (busy, stopped): the button that was pressed, enabled again
      refocusImport.current = false;
      importButtonRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [view.kind]);

  const ask = useCallback(async (run: number, read: ReadFragments, local: FragmentPlanEntry[]) => {
    setView({ kind: "checking", total: read.files.length });
    const answer = await askFragments(read.files, { dryRun: true, overwrite: true });
    if (run !== runRef.current) return;
    if (!answer.ok) {
      setView({
        kind: "failed",
        error: "busy" in answer ? "the extension is busy" : answer.error,
      });
      return;
    }
    setPlan([...local, ...answer.reply.plan]);
    setReplace(true);
    setExpanded(new Set());
    setView({ kind: "plan" });
  }, []);

  const begin = useCallback(
    async (sources: FragmentSource[]) => {
      if (sources.length === 0) return;
      const run = ++runRef.current;
      const gathered = gatherFragmentSources(sources);
      gatheredRef.current = gathered;
      readRef.current = null;

      if (gathered.candidates.length === 0) {
        setView({ kind: "empty", notice: { tone: "info", ...noMarkdownNotice(gathered) } });
        return;
      }
      if (overLimit(gathered)) {
        setView({ kind: "empty", notice: { tone: "bad", ...overLimitNotice(gathered) } });
        return;
      }

      const total = gathered.candidates.length;
      setView({ kind: "reading", read: 0, total });
      let read: ReadFragments | undefined;
      try {
        read = await readFragmentFiles(gathered, {
          onProgress: (n) => {
            if (run === runRef.current) setView({ kind: "reading", read: n, total });
          },
          isCancelled: () => run !== runRef.current,
        });
      } catch (err) {
        if (run !== runRef.current) return;
        log.warn("[FragmentImport] Could not read the chosen files", err);
        setView({ kind: "empty", notice: { tone: "bad", ...readFailedNotice() } });
        return;
      }
      if (!read || run !== runRef.current) return;
      readRef.current = read;
      if (read.files.length === 0) {
        // Every file was refused here: there is nothing to ask the extension
        setPlan(read.refused);
        setExpanded(new Set());
        setView({ kind: "plan" });
        return;
      }
      await ask(run, read, read.refused);
    },
    [ask],
  );

  // A drop: the folders are listed (one level) before anything is read. The list can be long, or
  // fail, so it has its own state and its own failure.
  const handleDrop = useCallback(
    async (items: DroppedItem[]) => {
      if (!items.some((item) => item.file || item.entry)) return;
      const run = ++runRef.current;
      if (items.some((item) => item.entry?.isDirectory)) setView({ kind: "listing" });
      let sources: FragmentSource[];
      try {
        sources = await sourcesFromDrop(items);
      } catch (err) {
        if (run !== runRef.current) return;
        log.warn("[FragmentImport] Could not read the chosen files", err);
        setView({ kind: "empty", notice: { tone: "bad", ...readFailedNotice() } });
        return;
      }
      if (run !== runRef.current) return;
      await begin(sources);
    },
    [begin],
  );

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
      void handleDrop(takeDroppedItems(event.dataTransfer));
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
  }, [handleDrop]);

  const retry = () => {
    const read = readRef.current;
    if (!read) return;
    void ask(++runRef.current, read, read.refused);
  };

  const reset = () => {
    runRef.current += 1;
    gatheredRef.current = null;
    readRef.current = null;
    setPlan([]);
    setView({ kind: "empty" });
  };

  const confirm = async () => {
    const read = readRef.current;
    if (!read) return;
    const run = ++runRef.current;
    const count = describePlan(plan, { replace }).toImport;
    setView({ kind: "importing", count });
    onBusyChange(true);
    const answer = await askFragments(read.files, { dryRun: false, overwrite: replace });
    onBusyChange(false);
    if (run !== runRef.current) return;
    if (!answer.ok) {
      const notice: ToneNotice =
        "busy" in answer
          ? { tone: "bad", ...busyNotice(answer.busy) }
          : {
              tone: "bad",
              title: `The import stopped: ${inSentence(answer.error)}.`,
              body: "Choose the files again: the plan will show what is already in.",
            };
      refocusImport.current = true;
      setView({ kind: "plan", notice });
      return;
    }
    const outcome = describeOutcome(
      { ...answer.reply, plan: [...read.refused, ...answer.reply.plan] },
      { replace },
    );
    setPlan([...read.refused, ...answer.reply.plan]);
    setExpanded(new Set());
    setView({ kind: "done", outcome, replace });
    // The list reloads, and says "Loaded." when it is done: this is said after it, or it is lost
    await onImported();
    setStatus(
      `Imported ${plural(outcome.saved, "fragment")}.`,
      outcome.failed.length > 0 || outcome.indexError ? "warn" : "ok",
    );
  };

  const choose = (event: React.ChangeEvent<HTMLInputElement>, folder: boolean) => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;
    if (folder) {
      const source = sourceFromFolderPick(files);
      if (source) void begin([source]);
    } else {
      void begin(files.map((file) => ({ kind: "file" as const, file })));
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

  const gathered = gatheredRef.current;
  const summary = describePlan(plan, { replace });
  const everyRefused =
    summary.toImport === 0 && summary.changedCount === 0 && summary.refusedCount > 0;

  const folderOf = new Map(
    (gathered?.candidates ?? []).map((candidate) => [candidate.name, candidate.folder]),
  );
  const noIdNames = plan.filter((entry) => entry.state === "no-id").map((entry) => entry.name);
  const advice =
    noIdNames.length > 0
      ? assignIdsPlan(
          noIdNames.map((name) => ({ name, folder: folderOf.get(name) })),
          {
            folderIsEverything:
              (gathered?.folders.length ?? 0) === 1 && (gathered?.looseFiles ?? 0) === 0,
          },
        )
      : undefined;
  const command = advice?.command ?? "";
  const words = noIdWords(noIdNames.length, advice?.folder);

  const rowView = (row: PlanRow) => (
    <li
      key={`${row.state}:${row.name}`}
      className="grid grid-cols-1 gap-x-2.5 gap-y-0.5 border-t border-border/50 px-3 py-1.5 text-[13px] sm:grid-cols-[7.5rem_minmax(0,1fr)]"
    >
      <span
        className={cn(
          "pt-0.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground",
          row.state === "new" && "text-primary",
          REFUSED_STATES.has(row.state) && "text-destructive",
        )}
      >
        {row.label}
      </span>
      <span className="text-foreground [overflow-wrap:anywhere]">{row.name}</span>
      {row.meta && (
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere] sm:col-start-2">
          {row.meta}
        </span>
      )}
      {row.reason && (
        <span className="text-xs text-foreground [overflow-wrap:anywhere] sm:col-start-2">
          {row.reason}
        </span>
      )}
      {row.warnings.map((warning) => (
        <span key={warning} className="text-xs text-secondary sm:col-start-2">
          <span aria-hidden="true">! </span>
          <span className="sr-only">Warning: </span>
          {warning}
        </span>
      ))}
      {row.state === "no-id" && (
        <span className="sm:col-start-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() =>
              isMissingFrontmatter(row.reason)
                ? copy(idBlock(), "Id block copied", `id:${row.name}`)
                : copy(`${idLine()}\n`, "Id line copied", `id:${row.name}`)
            }
          >
            {copied === `id:${row.name}`
              ? "Copied"
              : isMissingFrontmatter(row.reason)
                ? "Copy an id block"
                : "Copy an id line"}
          </Button>
        </span>
      )}
    </li>
  );

  const noIdBox = (
    <div
      role="group"
      aria-labelledby="fragment-cmd-label"
      className="mx-3 mb-2.5 mt-2 grid gap-2 border border-border bg-muted/50 p-3 text-xs text-foreground"
    >
      <div id="fragment-cmd-label">{words.lead}</div>
      <div className="flex items-start justify-between gap-2">
        <code
          id="fragment-cmd"
          className="block min-w-0 flex-1 bg-background px-2 py-1.5 text-xs text-primary [overflow-wrap:anywhere]"
        >
          {command}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          aria-describedby="fragment-cmd"
          onClick={() => copy(command, "Command copied", "cmd")}
        >
          {copied === "cmd" ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="text-muted-foreground">
        {words.where}{" "}
        <a
          className="text-primary underline underline-offset-4"
          href={`${DOCS}#the-id`}
          target="_blank"
          rel="noreferrer"
        >
          Or add an id by hand
        </a>
      </div>
    </div>
  );

  const groupView = (group: PlanGroup) => {
    const folded = group.key === "unchanged" || group.key === "same-file";
    const open = expanded.has(group.key);
    const all = expanded.has(`${group.key}:all`);
    // A folded group shows nothing, or every row; the others show the first rows, or every row
    const visible = folded
      ? open
        ? group.rows
        : []
      : all
        ? group.rows
        : group.rows.slice(0, ROWS_SHOWN);
    // The no-id box sits after the last no-id row, between two lists
    const lastNoId = group.key === "refused" ? lastIndexWhere(visible, "no-id") : -1;
    const head = lastNoId === -1 ? visible : visible.slice(0, lastNoId + 1);
    const tail = lastNoId === -1 ? [] : visible.slice(lastNoId + 1);
    // The button stays when it is pressed (it turns over), so that focus is not lost with it
    const expandable = folded || group.rows.length > ROWS_SHOWN;
    const expandedNow = folded ? open : all;
    return (
      <section
        key={group.key}
        aria-labelledby={`fragment-g-${group.key}`}
        className="border-t border-border first:border-t-0"
      >
        <div className="sticky top-0 z-[1] flex flex-wrap items-baseline gap-x-2.5 gap-y-1 bg-popover px-3 py-2">
          <h4
            id={`fragment-g-${group.key}`}
            className={cn(
              "text-xs font-bold uppercase tracking-wider text-foreground",
              group.key === "refused" && "text-destructive",
            )}
          >
            {group.title} · {group.count}
          </h4>
          <span className="min-w-0 flex-1 basis-72 text-xs text-muted-foreground">
            {group.sentence}
          </span>
        </div>
        {group.key === "changed" && (
          <label className="flex items-center gap-2 px-3 pb-2 pt-1.5 text-[13px] text-foreground">
            <Checkbox checked={replace} onCheckedChange={(on) => setReplace(on === true)} />
            {group.count === 1 ? "Replace this chat" : `Replace these ${group.count} chats`}
          </label>
        )}
        {head.length > 0 && <ul className="m-0 list-none p-0">{head.map(rowView)}</ul>}
        {lastNoId !== -1 && noIdBox}
        {tail.length > 0 && <ul className="m-0 list-none p-0">{tail.map(rowView)}</ul>}
        {expandable && (
          <div className="px-3 pb-2.5 pt-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              aria-expanded={expandedNow}
              onClick={() => toggle(folded ? group.key : `${group.key}:all`)}
            >
              {folded
                ? open
                  ? "Hide"
                  : `Show ${group.count}`
                : all
                  ? `Show first ${ROWS_SHOWN}`
                  : `Show all ${group.count}`}
            </Button>
          </div>
        )}
      </section>
    );
  };

  const filesRegion = (label: string, groups: PlanGroup[]) => (
    <FilesRegion label={label}>{groups.map(groupView)}</FilesRegion>
  );

  const noticeView = (notice: ToneNotice, focusable = false) => (
    <div
      role="alert"
      className={cn(
        "border px-3 py-2.5 text-[13px] text-foreground",
        notice.tone === "bad" && "border-destructive/60 bg-destructive/10",
        notice.tone === "warn" && "border-secondary/60 bg-secondary/10",
        notice.tone === "info" && "border-border",
      )}
    >
      {focusable ? (
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="mb-0.5 block text-[13px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {notice.title}
        </h3>
      ) : (
        <strong className="mb-0.5 block">{notice.title}</strong>
      )}
      {notice.body}
    </div>
  );

  const heading = (text: React.ReactNode) => (
    <h3
      ref={headingRef}
      tabIndex={-1}
      className="m-0 w-fit text-[15px] font-bold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {text}
    </h3>
  );

  const bar = (value?: number, label?: string) =>
    value === undefined ? (
      <div className="h-1.5 overflow-hidden bg-muted">
        <div className="mx-auto h-full w-1/3 bg-primary motion-safe:animate-pulse" />
      </div>
    ) : (
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden bg-muted"
      >
        <div className="h-full bg-primary transition-all" style={{ width: `${value}%` }} />
      </div>
    );

  const footer = (parts: { left?: React.ReactNode; right: React.ReactNode }) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {parts.left}
      <span className="flex-1" />
      {parts.right}
    </div>
  );

  const cancelFooter = footer({
    right: (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    ),
  });

  const chooseOther = (
    <Button variant="outline" onClick={reset} disabled={importing}>
      Choose other files
    </Button>
  );

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
          {view.notice && noticeView(view.notice)}
          {cancelFooter}
        </>
      );
      break;
    case "listing":
      body = (
        <>
          <div role="status" className="grid gap-1.5">
            {heading("Reading the folder…")}
            {bar()}
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
            {heading(`Reading ${view.read} of ${view.total} files…`)}
            {bar(Math.round((view.read / view.total) * 100), "Reading files")}
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
            {heading(`Checking ${plural(view.total, "file")} against the archive…`)}
            {bar()}
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
          {noticeView(
            {
              tone: "bad",
              title: "The files could not be checked.",
              body: `The archive did not answer: ${inSentence(view.error)}. Nothing was written.`,
            },
            true,
          )}
          {footer({
            left: chooseOther,
            right: (
              <>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={retry}>Try again</Button>
              </>
            ),
          })}
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
              {heading(title)}
              {bar()}
              {indexesLater(summary) && (
                <div className="text-xs text-muted-foreground">
                  Search finds them when the index rebuild ends.
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-1">
              {heading(title)}
              <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[13px] text-muted-foreground [&_b]:font-bold">
                {counts}
              </div>
              {nothingNew && (
                <div className="text-xs text-muted-foreground">
                  Edit a file and import it again to change its chat.
                </div>
              )}
              {left && <div className="text-xs text-muted-foreground">{left}</div>}
            </div>
          )}
          {view.kind === "plan" && view.notice && noticeView(view.notice)}
          {!waiting && filesRegion("Files", groups)}
          {waiting
            ? footer({
                left: (
                  <Button variant="outline" disabled>
                    Choose other files
                  </Button>
                ),
                right: (
                  <>
                    <Button variant="outline" disabled>
                      Cancel
                    </Button>
                    <Button disabled>Importing…</Button>
                  </>
                ),
              })
            : footer({
                left: chooseOther,
                right:
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
                        onClick={() => void confirm()}
                      >
                        {importable ? `Import ${plural(summary.toImport, "fragment")}` : "Import"}
                      </Button>
                    </>
                  ),
              })}
        </>
      );
      break;
    }
    case "done": {
      const { outcome } = view;
      const failedSome = outcome.failed.length > 0;
      const parts = [
        outcome.newSaved > 0 ? `${outcome.newSaved} new` : "",
        outcome.replaced > 0 ? `${outcome.replaced} replaced` : "",
      ].filter(Boolean);
      const sentence = [
        parts.length > 0 ? `${parts.join(", ")}.` : "",
        outcome.unchanged > 0
          ? `${outcome.unchanged} ${outcome.unchanged === 1 ? "was" : "were"} unchanged.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const refusedGroups = describePlan(plan, { replace: view.replace }).groups.filter(
        (group) => group.key === "refused",
      );
      body = (
        <>
          <div role="status" className="grid gap-1">
            {heading(
              failedSome ? (
                `Imported ${outcome.saved} of ${plural(outcome.attempted, "fragment")}`
              ) : outcome.saved === 0 ? (
                "Nothing to import"
              ) : (
                <>
                  <span className="text-primary" aria-hidden="true">
                    ✓
                  </span>{" "}
                  Imported {plural(outcome.saved, "fragment")}
                </>
              ),
            )}
            {sentence && <p className="m-0 text-[13px] text-foreground">{sentence}</p>}
            {outcome.leftAsIs > 0 && (
              <p className="m-0 text-[13px] text-foreground">
                {outcome.leftAsIs} changed {outcome.leftAsIs === 1 ? "file was" : "files were"} left
                as {outcome.leftAsIs === 1 ? "it is" : "they are"}.
              </p>
            )}
            {outcome.untitled > 0 && (
              <p className="m-0 text-[13px] text-muted-foreground">
                {outcome.untitled} {outcome.untitled === 1 ? "has" : "have"} no title: shown as
                (Untitled) until metadata generation names {outcome.untitled === 1 ? "it" : "them"}.
              </p>
            )}
            {outcome.refused > 0 && (
              <p className="m-0 text-[13px] text-foreground">
                {outcome.refused} {outcome.refused === 1 ? "file was" : "files were"} refused; they
                are listed below.
              </p>
            )}
          </div>
          {outcome.failed.length > 0 &&
            noticeView({
              tone: "bad",
              title: `${plural(outcome.failed.length, "file")} could not be saved.`,
              body: "The others are in.",
            })}
          {outcome.failed.length > 0 && (
            <div
              role="region"
              aria-label="Files that could not be saved"
              tabIndex={0}
              className="max-h-40 overflow-y-auto border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ul className="m-0 list-none p-0">
                {outcome.failed.map((file) => (
                  <li
                    key={file.name}
                    className="grid grid-cols-1 gap-x-2.5 gap-y-0.5 border-t border-border/50 px-3 py-1.5 text-[13px] first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
                  >
                    <span className="pt-0.5 text-[11px] font-bold uppercase tracking-wide text-destructive">
                      Failed
                    </span>
                    <span className="text-foreground [overflow-wrap:anywhere]">{file.name}</span>
                    <span className="text-xs text-foreground [overflow-wrap:anywhere] sm:col-start-2">
                      {file.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {outcome.indexError &&
            noticeView({
              tone: "warn",
              title: "Not searchable yet.",
              body: `The chats are saved, but the search index could not be updated (${outcome.indexError}). It catches up when HAEVN next starts.`,
            })}
          {refusedGroups.length > 0 && filesRegion("Refused files", refusedGroups)}
          {footer({
            left: (
              <Button variant="outline" onClick={reset}>
                Import more
              </Button>
            ),
            right: (
              <>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button onClick={onShowFragments}>Show fragments</Button>
              </>
            ),
          })}
        </>
      );
      break;
    }
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

function lastIndexWhere(rows: PlanRow[], state: string): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].state === state) return i;
  return -1;
}
