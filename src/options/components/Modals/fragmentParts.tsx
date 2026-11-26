/**
 * The small pieces the fragment import panel and its views share (HVN-178): the status heading
 * that takes focus, the notice, the progress bar and the footer.
 */

import type { ReactNode, RefObject } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type { ToneNotice } from "../../import/fragmentSession";

export const DOCS = "https://haevn.pages.dev/user-guide/fragments/";

/** The heading of the state on show: focus goes to it when the state changes */
export const Heading = ({
  headingRef,
  children,
}: {
  headingRef: RefObject<HTMLHeadingElement>;
  children: ReactNode;
}) => (
  <h3
    ref={headingRef}
    tabIndex={-1}
    className="m-0 w-fit text-[15px] font-bold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    {children}
  </h3>
);

/** A notice; with `headingRef` its title is the heading that takes focus */
export const NoticeBox = ({
  notice,
  headingRef,
}: {
  notice: ToneNotice;
  headingRef?: RefObject<HTMLHeadingElement>;
}) => (
  <div
    role="alert"
    className={cn(
      "border px-3 py-2.5 text-[13px] text-foreground",
      notice.tone === "bad" && "border-destructive/60 bg-destructive/10",
      notice.tone === "warn" && "border-secondary/60 bg-secondary/10",
      notice.tone === "info" && "border-border",
    )}
  >
    {headingRef ? (
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

/** A bar that fills as `value` does, or one that only says something is going on */
export const Bar = ({ value, label }: { value?: number; label?: string }) =>
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

/** The buttons of a state: some on the left, the way out on the right */
export const Footer = ({ left, right }: { left?: ReactNode; right: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-end gap-2">
    {left}
    <span className="flex-1" />
    {/* One group, so that Cancel and Import wrap together on a narrow dialog */}
    <div className="ml-auto flex flex-wrap gap-2">{right}</div>
  </div>
);

/** The footer of the states that only wait or ask: Cancel, and nothing else */
export const CancelFooter = ({ onClose }: { onClose: () => void }) => (
  <Footer
    right={
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    }
  />
);
