/**
 * What the fragment import dialog shows when an import has ended (HVN-163 slice 3, HVN-178): how
 * many fragments are in, the files that could not be saved, a search index that is behind, and the
 * files that were refused. The words are in /project/haevn/product/design/fragment-import.
 */

import type { RefObject } from "react";
import { Button } from "../../../components/ui/button";
import type { FragmentPlanEntry } from "../../../providers/fragment/model";
import { describePlan, type ImportOutcome, plural } from "../../import/fragmentPlanView";
import { FragmentPlanList, type PlanListState } from "./FragmentPlanList";
import { Footer, Heading, NoticeBox } from "./fragmentParts";

interface FragmentDoneViewProps {
  outcome: ImportOutcome;
  /** The Replace choice the import was made with */
  replace: boolean;
  /** The plan of what was given, with the refused files among it */
  plan: FragmentPlanEntry[];
  headingRef: RefObject<HTMLHeadingElement>;
  /** What the list of refused files holds on to */
  list: PlanListState;
  onImportMore: () => void;
  onClose: () => void;
  onShowFragments: () => void;
}

export const FragmentDoneView = ({
  outcome,
  replace,
  plan,
  headingRef,
  list,
  onImportMore,
  onClose,
  onShowFragments,
}: FragmentDoneViewProps) => {
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
  const refusedGroups = describePlan(plan, { replace }).groups.filter(
    (group) => group.key === "refused",
  );
  return (
    <>
      <div role="status" className="grid gap-1">
        <Heading headingRef={headingRef}>
          {failedSome ? (
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
          )}
        </Heading>
        {sentence && <p className="m-0 text-[13px] text-foreground">{sentence}</p>}
        {outcome.leftAsIs > 0 && (
          <p className="m-0 text-[13px] text-foreground">
            {outcome.leftAsIs} changed {outcome.leftAsIs === 1 ? "file was" : "files were"} left as{" "}
            {outcome.leftAsIs === 1 ? "it is" : "they are"}.
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
            {outcome.refused} {outcome.refused === 1 ? "file was" : "files were"} refused; they are
            listed below.
          </p>
        )}
      </div>
      {failedSome && (
        <NoticeBox
          notice={{
            tone: "bad",
            title: `${plural(outcome.failed.length, "file")} could not be saved.`,
            body: "The others are in.",
          }}
        />
      )}
      {failedSome && (
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
      {outcome.indexError && (
        <NoticeBox
          notice={{
            tone: "warn",
            title: "Not searchable yet.",
            body: `The chats are saved, but the search index could not be updated (${outcome.indexError}). It catches up when HAEVN next starts.`,
          }}
        />
      )}
      {refusedGroups.length > 0 && (
        <FragmentPlanList
          {...list}
          label="Refused files"
          groups={refusedGroups}
          plan={plan}
          replace={replace}
        />
      )}
      <Footer
        left={
          <Button variant="outline" onClick={onImportMore}>
            Import more
          </Button>
        }
        right={
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={onShowFragments}>Show fragments</Button>
          </>
        }
      />
    </>
  );
};
