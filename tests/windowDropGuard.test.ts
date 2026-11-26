import { describe, expect, it } from "vitest";
import { guardWindowDrops, hasFiles } from "../src/options/import/windowDropGuard";

// HVN-177: while the Import dialog is open, a file let go beside the drop zone must not open in
// the tab, for every format and not only fragments. The guard cancels the drop of files and
// leaves a drop of text or a link alone (those are not ours to cancel).

function drag(type: "dragover" | "drop", types: string[] | null): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: types && { types } });
  return event;
}

describe("the window's drop guard (HVN-177)", () => {
  it("cancels a dragover and a drop that carry files", () => {
    const target = new EventTarget();
    guardWindowDrops(target);

    for (const type of ["dragover", "drop"] as const) {
      const event = drag(type, ["Files"]);
      target.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
  });

  it("leaves text, links and a drag with no data alone", () => {
    const target = new EventTarget();
    guardWindowDrops(target);

    for (const types of [["text/plain"], ["text/uri-list", "text/html"], [], null]) {
      for (const type of ["dragover", "drop"] as const) {
        const event = drag(type, types);
        target.dispatchEvent(event);
        expect(event.defaultPrevented, `${type} ${JSON.stringify(types)}`).toBe(false);
      }
    }
  });

  it("takes the guard off when the dialog closes", () => {
    const target = new EventTarget();
    const off = guardWindowDrops(target);
    off();

    for (const type of ["dragover", "drop"] as const) {
      const event = drag(type, ["Files"]);
      target.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(false);
    }
  });

  it("tells a drag of files from one of text", () => {
    expect(hasFiles(drag("drop", ["text/plain", "Files"]) as DragEvent)).toBe(true);
    expect(hasFiles(drag("drop", ["text/plain"]) as DragEvent)).toBe(false);
  });
});
