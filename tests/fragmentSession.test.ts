import { describe, expect, it, vi } from "vitest";
import type { DroppedItem, FragmentSource } from "../src/options/import/fragmentFiles";
import type { FragmentAnswer } from "../src/options/import/fragmentImportApi";
import { FragmentSession, type SessionState } from "../src/options/import/fragmentSession";

// HVN-179: the dialog holds a set of files; each drop or pick is added to it, and the plan is the
// plan of the whole set. These tests drive the session with real File objects and a fake service,
// and hold the part that is easy to get wrong: which run may report.

const file = (name: string, content = `text of ${name}`) => new File([content], name);

/** A file that says it is this big, without being so */
function sized(name: string, bytes: number): File {
  const f = file(name);
  Object.defineProperty(f, "size", { value: bytes });
  return f;
}

const loose = (...files: File[]): FragmentSource[] =>
  files.map((f) => ({ kind: "file" as const, file: f }));

const folder = (name: string, ...files: File[]): FragmentSource => ({
  kind: "folder",
  name,
  entries: files.map((f) => ({ name: f.name, file: f })),
});

type Files = { name: string; content: string }[];

/** The fake service: every dry run waits until the test answers it */
function harness() {
  const asks: { files: Files; answer: (a?: FragmentAnswer) => void }[] = [];
  const states: SessionState[] = [];
  const errors: unknown[] = [];
  const session = new FragmentSession({
    ask: (files) =>
      new Promise<FragmentAnswer>((resolve) => {
        asks.push({
          files,
          answer: (answer) =>
            resolve(
              answer ?? {
                ok: true,
                reply: {
                  plan: files.map((f) => ({ name: f.name, state: "new" as const, warnings: [] })),
                },
              },
            ),
        });
      }),
    onChange: (state) => states.push(state),
    onError: (err) => errors.push(err),
  });
  const last = () => states[states.length - 1];
  const asked = (n: number) => vi.waitFor(() => expect(asks.length).toBeGreaterThanOrEqual(n));
  const names = (files: Files) => files.map((f) => f.name);
  return { session, asks, states, errors, last, asked, names };
}

describe("each drop is added to the files (HVN-179)", () => {
  it("asks for the plan of everything given so far, one dry run each time", async () => {
    const h = harness();

    h.session.add(loose(file("a.md"), file("b.md")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();
    expect(h.names(h.asks[0].files)).toEqual(["a.md", "b.md"]);
    expect(h.last().view.kind).toBe("plan");

    h.session.add(loose(file("c.md")));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();

    expect(h.names(h.asks[1].files)).toEqual(["a.md", "b.md", "c.md"]);
    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md", "b.md", "c.md"]);
    expect(h.session.read?.files).toHaveLength(3);
  });

  it("replaces a file of the same name with the newer copy, and says which", async () => {
    const h = harness();

    h.session.add(loose(file("a.md", "old"), file("b.md")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();
    h.session.add(loose(file("a.md", "new")));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();

    expect(h.asks[1].files).toEqual([
      { name: "a.md", content: "new" },
      { name: "b.md", content: "text of b.md" },
    ]);
    expect(h.last().replaced).toEqual(["a.md"]);
  });

  it("replaces a file of a folder by the folder's name and its own, and keeps the others", async () => {
    const h = harness();

    h.session.add([folder("notes", file("1.md", "one"), file("2.md", "two"))]);
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();
    h.session.add([folder("notes", file("1.md", "one, edited"))]);
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();

    expect(h.asks[1].files).toEqual([
      { name: "1.md", content: "one, edited" },
      { name: "2.md", content: "two" },
    ]);
    expect(h.last().replaced).toEqual(["notes/1.md"]);
  });

  it("keeps two folders of one name in the same drop apart", async () => {
    const h = harness();

    h.session.add([folder("notes", file("1.md", "a")), folder("notes", file("1.md", "b"))]);
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    expect(h.names(h.asks[0].files)).toEqual(["notes/1.md", "notes (2)/1.md"]);
    expect(h.last().replaced).toEqual([]);
  });

  it("does not read a file again that it has read", async () => {
    const h = harness();
    const a = file("a.md");
    const spy = vi.spyOn(a, "arrayBuffer");

    h.session.add(loose(a));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();
    h.session.add(loose(file("b.md")));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.asks[1].files).toHaveLength(2);
  });

  it("lets a drop of text files leave the plan as it was, and says so", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    h.session.add(loose(file("notes.txt")));
    await h.session.settled();

    expect(h.asks).toHaveLength(1);
    expect(h.last().view.kind).toBe("plan");
    expect(h.last().notice?.body).toContain("The files already here are as they were.");
    expect(h.session.gathered?.notMarkdown).toBe(1);
  });
});

describe("the limit holds for the whole set (HVN-179)", () => {
  const MB = 1024 * 1024;

  it("does not add a drop that takes the set over 16 MiB, and keeps the plan it had", async () => {
    const h = harness();
    h.session.add(loose(sized("a.md", 10 * MB)));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    h.session.add(loose(sized("b.md", 8 * MB)));
    await h.session.settled();

    expect(h.asks).toHaveLength(1);
    expect(h.last().view.kind).toBe("plan");
    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md"]);
    expect(h.last().notice).toMatchObject({
      tone: "bad",
      title: "Not added: too much for one import.",
    });
    expect(h.last().notice?.body).toContain("The 1 file already here is kept: import it first");
    expect(h.session.gathered?.candidates.map((c) => c.name)).toEqual(["a.md"]);
  });

  it("takes a replacement that keeps it under, though the two together would not be", async () => {
    const h = harness();
    h.session.add(loose(sized("a.md", 10 * MB)));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    h.session.add(loose(sized("a.md", 12 * MB)));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();

    expect(h.last().notice).toBeUndefined();
    expect(h.session.gathered?.totalBytes).toBe(12 * MB);
  });

  it("says the first drop's own words when nothing was there", async () => {
    const h = harness();

    h.session.add(loose(sized("a.md", 17 * MB)));
    await h.session.settled();

    expect(h.last().view.kind).toBe("empty");
    expect(h.last().notice?.body).toContain("Nothing was read.");
    expect(h.asks).toHaveLength(0);
  });
});

describe("Clear starts again with nothing (HVN-179)", () => {
  it("forgets the files, the plan and the replacements, and the next drop is the whole set", async () => {
    const h = harness();
    h.session.add(loose(file("a.md", "old")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();
    h.session.add(loose(file("a.md", "new")));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();
    expect(h.last().replaced).toEqual(["a.md"]);

    h.session.clear();

    expect(h.last()).toMatchObject({ view: { kind: "empty" }, plan: [], replaced: [] });
    expect(h.session.gathered).toBeNull();
    expect(h.session.read).toBeNull();

    h.session.add(loose(file("c.md")));
    await h.asked(3);
    h.asks[2].answer();
    await h.session.settled();
    expect(h.names(h.asks[2].files)).toEqual(["c.md"]);
  });

  it("is not answered by a check that was still out when it was pressed", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);

    h.session.clear();
    h.asks[0].answer();
    await h.session.settled();

    expect(h.last()).toMatchObject({ view: { kind: "empty" }, plan: [] });
  });
});

describe("a drop while a check is out (HVN-179)", () => {
  it("is added at once, and the plan shown is the plan of both drops, never the first's", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);

    h.session.add(loose(file("b.md")));
    await h.asked(2);
    // the first check answers late, for a set that is no longer the set
    h.asks[0].answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.last().view.kind).toBe("checking");
    expect(h.last().plan).toEqual([]);

    h.asks[1].answer();
    await h.session.settled();
    expect(h.names(h.asks[1].files)).toEqual(["a.md", "b.md"]);
    expect(h.last().view.kind).toBe("plan");
    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  it("does not let the first check's answer over the second's when it comes last", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);
    h.session.add(loose(file("b.md")));
    await h.asked(2);

    h.asks[1].answer();
    await h.session.settled();
    h.asks[0].answer();
    await h.session.settled();

    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  it("is added though the first drop is still being read", async () => {
    const h = harness();
    const slow = file("a.md");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = slow.arrayBuffer.bind(slow);
    slow.arrayBuffer = async () => {
      await held;
      return open();
    };

    h.session.add(loose(slow));
    await vi.waitFor(() => expect(h.last().view.kind).toBe("reading"));
    h.session.add(loose(file("b.md")));
    release();
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    expect(h.asks).toHaveLength(1);
    expect(h.names(h.asks[0].files)).toEqual(["a.md", "b.md"]);
    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md", "b.md"]);
  });

  it("is ignored while an import runs, and taken again when it has ended", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    h.session.lock(true);
    h.session.add(loose(file("b.md")));
    h.session.addDropped([{ file: file("c.md"), entry: null }]);
    await h.session.settled();
    expect(h.session.gathered?.candidates.map((c) => c.name)).toEqual(["a.md"]);
    expect(h.asks).toHaveLength(1);

    h.session.lock(false);
    h.session.add(loose(file("d.md")));
    await h.asked(2);
    h.asks[1].answer();
    await h.session.settled();
    expect(h.names(h.asks[1].files)).toEqual(["a.md", "d.md"]);
  });

  it("is not shown over an import that started while a check was out", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);

    h.session.lock(true);
    const before = h.states.length;
    h.asks[0].answer();
    await h.session.settled();

    expect(h.states.length).toBe(before);
  });
});

describe("a dropped folder is listed in the order it was dropped (HVN-179)", () => {
  /** A dropped folder whose listing ends when the test says so */
  function dropped(name: string, files: File[]) {
    let finish: () => void = () => {};
    let fail: (err: unknown) => void = () => {};
    const children = files.map((f) => ({
      isFile: true,
      isDirectory: false,
      name: f.name,
      file: (ok: (file: File) => void) => ok(f),
    }));
    const entry = {
      isDirectory: true,
      isFile: false,
      name,
      createReader: () => {
        let served = false;
        return {
          readEntries(ok: (batch: unknown[]) => void, no: (err: unknown) => void) {
            if (served) return ok([]);
            served = true;
            finish = () => ok(children);
            fail = no;
          },
        };
      },
    };
    const item = { file: null, entry } as unknown as DroppedItem;
    return { item, finish: () => finish(), fail: (err: unknown) => fail(err) };
  }

  it("keeps the drop order when the second folder is listed first", async () => {
    const h = harness();
    const first = dropped("first", [file("a.md")]);
    const second = dropped("second", [file("b.md")]);

    h.session.addDropped([first.item]);
    h.session.addDropped([second.item]);
    expect(h.last().view.kind).toBe("listing");
    await vi.waitFor(() => expect(h.session.snapshot.view.kind).toBe("listing"));
    second.finish();
    await Promise.resolve();
    first.finish();
    await h.asked(1);
    h.asks.at(-1)?.answer();
    await h.session.settled();

    expect(h.session.gathered?.candidates.map((c) => c.name)).toEqual(["first/a.md", "second/b.md"]);
    expect(h.session.gathered?.folders).toEqual(["first", "second"]);
  });

  it("shows the listing, and returns to the plan it had when the listing fails", async () => {
    const h = harness();
    h.session.add(loose(file("a.md")));
    await h.asked(1);
    h.asks[0].answer();
    await h.session.settled();

    const broken = dropped("broken", []);
    h.session.addDropped([broken.item]);
    expect(h.last().view.kind).toBe("listing");
    await vi.waitFor(() => expect(h.session.snapshot.view.kind).toBe("listing"));
    broken.fail(new Error("gone"));
    await h.session.settled();

    expect(h.last().view.kind).toBe("plan");
    expect(h.last().notice).toMatchObject({ tone: "bad", title: "The files could not be read." });
    expect(h.errors).toHaveLength(1);
    expect(h.last().plan.map((e) => e.name)).toEqual(["a.md"]);
  });

  it("drops a folder that was still being listed when Clear was pressed", async () => {
    const h = harness();
    const slow = dropped("slow", [file("a.md")]);

    h.session.addDropped([slow.item]);
    await vi.waitFor(() => expect(h.session.snapshot.view.kind).toBe("listing"));
    h.session.clear();
    slow.finish();
    await h.session.settled();

    expect(h.last()).toMatchObject({ view: { kind: "empty" }, plan: [] });
    expect(h.session.gathered).toBeNull();
    expect(h.asks).toHaveLength(0);
  });
});
