import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilesRegion } from "../src/options/components/Modals/FilesRegion";

// HVN-163, slice 3, walk B1: a row's "Warning:" label is `sr-only` (position: absolute). In a
// scroller that is not itself positioned it is placed against the fixed dialog and stretches the
// dialog's scroll area to a few thousand pixels, and the plan scrolls out of the dialog. A node
// test has no layout, so this holds the cause: a region that scrolls is positioned.

describe("the files region of the fragment import dialog (HVN-163, slice 3)", () => {
  const html = renderToStaticMarkup(
    <FilesRegion label="Files">
      <span className="sr-only">Warning: </span>
    </FilesRegion>,
  );
  const classes = (/<div[^>]*role="region"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");

  it("scrolls, and is the positioned ancestor of what it holds", () => {
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("relative");
  });

  it("is a labelled region a keyboard can reach and scroll", () => {
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('tabindex="0"');
  });
});
