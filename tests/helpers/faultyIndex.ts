import type { IndexBuild, SearchIndex } from "../../src/services/searchIndex";

/**
 * Writes that fail on demand, for the tests of a rebuild that goes wrong. A real index fails for a
 * full disk or a quota; the wrapper makes either implementation fail the same way, at a chosen
 * write.
 */
export const faults: {
  /** The error that every `put` after the first `putAfter` ones throws. */
  put?: Error;
  putAfter: number;
  /** The error that `commit` throws. */
  commit?: Error;
  /** The error that the next `openFailures` calls of `open` throw. */
  open?: Error;
  openFailures: number;
} = { putAfter: 0, openFailures: 0 };

/** How many times `open` was called since `resetFaults`. */
export const opens = { count: 0 };

export function resetFaults(): void {
  faults.put = undefined;
  faults.putAfter = 0;
  faults.commit = undefined;
  faults.open = undefined;
  faults.openFailures = 0;
  opens.count = 0;
}

let puts = 0;

function checkedPut(put: () => void): void {
  const written = puts++;
  if (faults.put && written >= faults.putAfter) throw faults.put;
  put();
}

/** `index`, with the faults above. */
export function withFaults(index: SearchIndex): SearchIndex {
  puts = 0;
  const wrapped = Object.create(index) as SearchIndex;
  wrapped.put = (chat) => checkedPut(() => index.put(chat));
  wrapped.open = async () => {
    opens.count++;
    if (faults.open && faults.openFailures-- > 0) throw faults.open;
    return index.open();
  };
  wrapped.beginRebuild = (): IndexBuild => {
    const build = index.beginRebuild();
    return {
      ...build,
      put: (chat) => checkedPut(() => build.put(chat)),
      transaction: (fn) => build.transaction(fn),
      commit: () => {
        if (faults.commit) throw faults.commit;
        build.commit();
      },
    };
  };
  for (const name of [
    "remove",
    "transaction",
    "chats",
    "search",
    "passages",
    "passagesFor",
    "describe",
    "close",
  ] as const) {
    (wrapped as unknown as Record<string, unknown>)[name] = (
      index[name] as (...a: unknown[]) => unknown
    ).bind(index);
  }
  return wrapped;
}
