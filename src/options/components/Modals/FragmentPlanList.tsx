/**
 * The list of files of the fragment import dialog, in the groups of its plan (HVN-163 slice 3,
 * HVN-178): what each file will become, the warnings, the Replace choice of the changed ones, and
 * the box that says how to give the files with no id one. The panel holds what folds and what was
 * copied, so that they outlive a plan that is read again.
 */

import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { cn } from "../../../lib/utils";
import { type FragmentPlanEntry, REFUSED_STATES } from "../../../providers/fragment/model";
import type { GatheredFragments } from "../../import/fragmentFiles";
import {
  assignIdsPlan,
  idBlock,
  idLine,
  isMissingFrontmatter,
  noIdWords,
  type PlanGroup,
  type PlanRow,
} from "../../import/fragmentPlanView";
import { FilesRegion } from "./FilesRegion";
import { DOCS } from "./fragmentParts";

/** A group longer than this shows this many rows, and a button for the rest */
const ROWS_SHOWN = 20;

export interface FragmentPlanListProps {
  /** The region's name, for a screen reader */
  label: string;
  groups: PlanGroup[];
  /** The whole plan: the box for the files with no id is made from it */
  plan: FragmentPlanEntry[];
  gathered: GatheredFragments | null;
  replace: boolean;
  onReplaceChange: (replace: boolean) => void;
  /** The groups that are open, and the ones shown in full */
  expanded: Set<string>;
  onToggle: (key: string) => void;
  /** What was copied last (its id), and the way to copy */
  copied: string | null;
  onCopy: (text: string, announce: string, id: string) => void;
}

/** What the panel holds for the list, whichever view shows it */
export type PlanListState = Pick<
  FragmentPlanListProps,
  "gathered" | "onReplaceChange" | "expanded" | "onToggle" | "copied" | "onCopy"
>;

export const FragmentPlanList = ({
  label,
  groups,
  plan,
  gathered,
  replace,
  onReplaceChange,
  expanded,
  onToggle,
  copied,
  onCopy,
}: FragmentPlanListProps) => {
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
                ? onCopy(idBlock(), "Id block copied", `id:${row.name}`)
                : onCopy(`${idLine()}\n`, "Id line copied", `id:${row.name}`)
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
          onClick={() => onCopy(command, "Command copied", "cmd")}
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
            <Checkbox checked={replace} onCheckedChange={(on) => onReplaceChange(on === true)} />
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
              onClick={() => onToggle(folded ? group.key : `${group.key}:all`)}
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

  return <FilesRegion label={label}>{groups.map(groupView)}</FilesRegion>;
};

function lastIndexWhere(rows: PlanRow[], state: string): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].state === state) return i;
  return -1;
}
