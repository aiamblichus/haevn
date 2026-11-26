import { describe, expect, it, vi } from "vitest";
import type { ReadFragments } from "../src/options/import/fragmentFiles";
import type { FragmentAnswer } from "../src/options/import/fragmentImportApi";
import {
  FragmentImportRun,
  type ImportRunState,
  type RunSession,
} from "../src/options/import/fragmentImportRun";
import type { FragmentFile, FragmentPlanEntry } from "../src/providers/fragment/model";

// HVN-178: the dialog's import, away from React. These tests drive the run with a fake session and
// a fake service that waits until the test answers it, and hold what the panel used to keep in its
// effects: what is locked and held while an import runs, what each ending shows, and that a run
// the dialog has outlived says nothing.

const entry = (name: string, state: FragmentPlanEntry["state"]): FragmentPlanEntry => ({
  name,
  state,
  title: name,
  warnings: [],
});

const refusedHere: FragmentPlanEntry = { name: "latin1.md", state: "unreadable", warnings: [] };
const files: FragmentFile[] = [
  { name: "a.md", content: "a" },
  { name: "b.md", content: "b" },
];
const planOf = [entry("a.md", "new"), entry("b.md", "changed")];

/** What the service says it did of those files */
const saved = (n: number, extra: object = {}): FragmentAnswer => ({
  ok: true,
  reply: { plan: planOf, imported: { processed: n, saved: n, skipped: 0, errors: 0, ...extra } },
});

function harness(read: ReadFragments | null = { files, refused: [refusedHere] }) {
  const events: string[] = [];
  const states: ImportRunState[] = [];
  const statuses: { text: string; tone: string }[] = [];
  const asks: {
    files: FragmentFile[];
    overwrite: boolean;
    answer: (a: FragmentAnswer) => void;
  }[] = [];
  const reloads: (() => void)[] = [];
  const session: RunSession = {
    read,
    lock: (on) => events.push(`lock:${on}`),
  };
  const run = new FragmentImportRun(session, {
    ask: (sent, options) =>
      new Promise<FragmentAnswer>((resolve) => {
        asks.push({ files: sent, overwrite: options.overwrite, answer: resolve });
      }),
    onChange: (state) => {
      states.push(state);
      events.push(`state:${state.kind}`);
    },
    onBusyChange: (busy) => events.push(`busy:${busy}`),
    onImported: () =>
      new Promise<void>((resolve) => {
        events.push("reload");
        reloads.push(resolve);
      }),
    onStatus: (text, tone) => {
      statuses.push({ text, tone });
      events.push("status");
    },
  });
  const asked = (n: number) => vi.waitFor(() => expect(asks.length).toBeGreaterThanOrEqual(n));
  return { run, states, statuses, asks, reloads, events, asked };
}

describe("confirming an import (HVN-178)", () => {
  it("holds the dialog and the session while it runs, and lets go when the answer is in", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    expect(h.events).toEqual(["lock:true", "state:importing", "busy:true"]);
    expect(h.states[0]).toEqual({ kind: "importing", count: 2 });
    expect(h.asks[0]).toMatchObject({ files, overwrite: true });

    h.asks[0].answer(saved(2));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    expect(h.events.slice(3)).toEqual(["busy:false", "lock:false", "state:done", "reload"]);
    h.reloads[0]();
    await confirmed;
  });

  it("shows the result with the files refused here ahead of the service's plan", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer(saved(2));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    h.reloads[0]();
    await confirmed;

    const done = h.run.snapshot;
    if (done.kind !== "done") throw new Error(`expected done, got ${done.kind}`);
    expect(done.replace).toBe(true);
    expect(done.plan.map((e) => e.name)).toEqual(["latin1.md", "a.md", "b.md"]);
    expect(done.outcome).toMatchObject({ saved: 2, newSaved: 1, replaced: 1, refused: 1 });
  });

  it("says the status last, after the archive's list has reloaded", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer(saved(2));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    expect(h.statuses).toEqual([]);

    h.reloads[0]();
    await confirmed;
    expect(h.statuses).toEqual([{ text: "Imported 2 fragments.", tone: "ok" }]);
    expect(h.events[h.events.length - 1]).toBe("status");
  });

  it("warns in the status when a file could not be saved or the index is behind", async () => {
    for (const extra of [
      { failed: [{ name: "b.md", message: "disk full" }] },
      { indexError: "the index is locked" },
    ]) {
      const h = harness();
      const confirmed = h.run.confirm(planOf, true);
      await h.asked(1);
      h.asks[0].answer(saved(1, extra));
      await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
      h.reloads[0]();
      await confirmed;
      expect(h.statuses[0], JSON.stringify(extra)).toEqual({
        text: "Imported 1 fragment.",
        tone: "warn",
      });
    }
  });

  it("counts and sends the Replace choice it was given: off leaves the changed files out", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, false);
    await h.asked(1);
    expect(h.states[0]).toEqual({ kind: "importing", count: 1 });
    expect(h.asks[0].overwrite).toBe(false);

    h.asks[0].answer(saved(1));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    h.reloads[0]();
    await confirmed;
    const done = h.run.snapshot;
    expect(done.kind === "done" && done.outcome.leftAsIs).toBe(1);
    expect(done.kind === "done" && done.replace).toBe(false);
  });

  it("does nothing when no files have been read", async () => {
    const h = harness(null);

    await h.run.confirm(planOf, true);

    expect(h.events).toEqual([]);
    expect(h.asks).toHaveLength(0);
  });
});

describe("an import that does not run (HVN-178)", () => {
  it("says another operation holds the lock, and releases the dialog and the session", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer({ ok: false, busy: "bulkSync" });
    await confirmed;

    expect(h.events).toEqual([
      "lock:true",
      "state:importing",
      "busy:true",
      "busy:false",
      "lock:false",
      "state:idle",
    ]);
    const idle = h.run.snapshot;
    expect(idle).toMatchObject({ kind: "idle", notice: { tone: "bad", title: "Not imported." } });
    expect(idle.kind === "idle" && idle.notice?.body).toContain("bulk sync");
    expect(h.statuses).toEqual([]);
  });

  it("says the import stopped, with the service's own reason, and writes no status", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer({ ok: false, error: "Quota exceeded." });
    await confirmed;

    expect(h.run.snapshot).toMatchObject({
      kind: "idle",
      notice: { tone: "bad", title: "The import stopped: quota exceeded." },
    });
    expect(h.statuses).toEqual([]);
    expect(h.events).not.toContain("reload");
  });

  it("can be tried again after a notice: the second run is a run of its own", async () => {
    const h = harness();

    const first = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer({ ok: false, busy: "import" });
    await first;
    const second = h.run.confirm(planOf, true);
    await h.asked(2);
    h.asks[1].answer(saved(2));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    h.reloads[0]();
    await second;

    expect(h.run.snapshot.kind).toBe("done");
  });

  it("gives way when the session says something new", async () => {
    const h = harness();
    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.asks[0].answer({ ok: false, error: "no" });
    await confirmed;
    expect(h.run.snapshot).toMatchObject({ kind: "idle", notice: expect.anything() });

    h.run.reset();

    expect(h.run.snapshot).toEqual({ kind: "idle" });
  });
});

describe("a run the dialog has outlived (HVN-178)", () => {
  it("releases the dialog and the session, and says nothing, when it ends after the dialog", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.run.dispose();
    h.asks[0].answer(saved(2));
    await confirmed;

    expect(h.events).toEqual([
      "lock:true",
      "state:importing",
      "busy:true",
      "busy:false",
      "lock:false",
    ]);
    expect(h.statuses).toEqual([]);
  });

  it("says nothing of a failure either", async () => {
    const h = harness();

    const confirmed = h.run.confirm(planOf, true);
    await h.asked(1);
    h.run.dispose();
    h.asks[0].answer({ ok: false, busy: "import" });
    await confirmed;

    expect(h.states.map((s) => s.kind)).toEqual(["importing"]);
  });

  it("drops the answer of a run that a newer one has taken the place of", async () => {
    const h = harness();

    const first = h.run.confirm(planOf, true);
    await h.asked(1);
    const second = h.run.confirm(planOf, false);
    await h.asked(2);
    h.asks[0].answer(saved(2));
    await first;
    // the first answer is in, and it is not the latest: nothing but the second's state shows
    expect(h.states.map((s) => s.kind)).toEqual(["importing", "importing"]);
    expect(h.events).not.toContain("reload");

    h.asks[1].answer(saved(1));
    await vi.waitFor(() => expect(h.reloads).toHaveLength(1));
    h.reloads[0]();
    await second;
    const done = h.run.snapshot;
    expect(done.kind === "done" && done.replace).toBe(false);
    expect(h.statuses).toEqual([{ text: "Imported 1 fragment.", tone: "ok" }]);
  });
});
