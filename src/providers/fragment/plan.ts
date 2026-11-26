/**
 * The plan of a fragment import (HVN-163): every file gets one state, before anything is written.
 * A dry run prints this plan; a real import carries out its `new` and `changed` entries. The plan
 * imports no service: what the archive holds comes in through `FragmentLookup`.
 */

import { formatRoughDate } from "../../model/roughDate";
import { sha256Hex } from "../../utils/jsonImporter";
import {
  FRAGMENT_PARSER_VERSION,
  type FragmentFile,
  type FragmentLookup,
  type FragmentPlanEntry,
  type HashedFragment,
} from "./model";
import { parseFragment } from "./parser";

export interface PlannedFragment {
  entry: FragmentPlanEntry;
  fragment: HashedFragment;
}

export interface FragmentPlan {
  /** One entry per file, in the order the files came */
  entries: FragmentPlanEntry[];
  /** The `new` and `changed` files, parsed, in the same order */
  importable: PlannedFragment[];
}

function dateLabel(fragment: HashedFragment): string {
  if (fragment.roughDate) return formatRoughDate(fragment.roughDate);
  return new Date(fragment.timestamp).toISOString();
}

export async function planFragmentImport(
  files: FragmentFile[],
  lookup: FragmentLookup,
): Promise<FragmentPlan> {
  const entries: FragmentPlanEntry[] = [];
  const parsed = new Map<number, HashedFragment>();

  for (const [index, file] of files.entries()) {
    const outcome = parseFragment(file);
    if (!outcome.ok) {
      entries.push({
        name: file.name,
        state: outcome.state,
        message: outcome.message,
        warnings: [],
      });
      continue;
    }
    const fragment: HashedFragment = {
      ...outcome.fragment,
      fileSha256: await sha256Hex(file.content),
      bodySha256: await sha256Hex(outcome.fragment.body),
    };
    parsed.set(index, fragment);
    entries.push({
      name: file.name,
      // settled below, once every id of the import is known
      state: "new",
      id: fragment.id,
      title: fragment.fields.title,
      date: dateLabel(fragment),
      turns: fragment.turns.filter((turn) => turn.role !== "system").length,
      warnings: [...fragment.warnings],
    });
  }

  // One id in two files: byte-equal copies are one import, files that differ refuse each other
  const byId = new Map<string, number[]>();
  for (const [index, fragment] of parsed) {
    byId.set(fragment.id, [...(byId.get(fragment.id) ?? []), index]);
  }
  const skipped = new Set<number>();
  for (const indexes of byId.values()) {
    if (indexes.length < 2) continue;
    const hashes = new Set(indexes.map((index) => parsed.get(index)?.fileSha256));
    if (hashes.size > 1) {
      for (const index of indexes) {
        entries[index].state = "duplicate-id";
        entries[index].message = `${indexes.length} files share this id and they differ`;
        skipped.add(index);
      }
    } else {
      for (const index of indexes.slice(1)) {
        entries[index].state = "same-file";
        entries[index].message = `same file as ${entries[indexes[0]].name}`;
        skipped.add(index);
      }
    }
  }

  const importable: PlannedFragment[] = [];
  const bodies = new Map<string, string>();
  for (const [index, fragment] of parsed) {
    if (skipped.has(index)) continue;
    const entry = entries[index];

    const stored = await lookup.stored(fragment.id);
    if (!stored) {
      entry.state = "new";
    } else if (stored.fileSha256 === fragment.fileSha256 && stored.v >= FRAGMENT_PARSER_VERSION) {
      entry.state = "unchanged";
    } else {
      entry.state = "changed";
    }

    if (entry.state === "new") {
      // `--assign-ids` on a second copy of a folder gives every file a second identity: say so
      const sameImport = bodies.get(fragment.bodySha256);
      const held = sameImport ? undefined : await lookup.withBody(fragment.bodySha256);
      const copyOf = sameImport ?? held?.fileName;
      if (copyOf !== undefined) {
        entry.warnings.push({
          code: "copy",
          message: sameImport
            ? `this looks like a copy of ${copyOf}, in this import under another id`
            : `this looks like a copy of ${copyOf}, already in the archive under another id`,
        });
      }
      bodies.set(fragment.bodySha256, entry.name);
    }

    if (entry.state === "new" || entry.state === "changed") importable.push({ entry, fragment });
  }

  return { entries, importable };
}
