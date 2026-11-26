/**
 * Types for fragments (HVN-163): recovered chats that no platform holds any more, imported from
 * Markdown files with YAML frontmatter. The design is /project/haevn/architecture/fragments.
 */

import type { RoughDate } from "../../model/roughDate";

/** One file as the caller read it. `name` is what the plan calls it (the CLI passes the path). */
export interface FragmentFile {
  name: string;
  content: string;
}

/**
 * The version of the parser's forms, kept in `params.fragment.v`. A file that has not changed is
 * still `changed` when the stored version is lower than this one, so that a new form reaches the
 * fragments imported before it existed.
 */
export const FRAGMENT_PARSER_VERSION = 2;

export type FragmentRole = "user" | "assistant" | "system";

/** The reasons a file is refused. Each is a plan state (see `FragmentState`). */
export type FragmentRefusal = "no-id" | "bad-id" | "bad-date" | "unreadable";

export type FragmentState =
  | "new"
  | "changed"
  | "unchanged"
  | "same-file"
  | "duplicate-id"
  | FragmentRefusal;

/** The states that stop a file from being imported. A refused file does not stop the others. */
export const REFUSED_STATES: ReadonlySet<FragmentState> = new Set([
  "no-id",
  "bad-id",
  "bad-date",
  "unreadable",
  "duplicate-id",
]);

export type FragmentWarningCode =
  | "speakers-bad-type"
  | "speakers-unknown-key"
  | "speakers-duplicate-label"
  | "speakers-no-match"
  | "speakers-one-side"
  | "speakers-unused"
  | "no-title-no-generate"
  | "bad-field"
  | "model-unknown"
  | "copy";

/** A thing the person may want to know about a file, that does not stop it being imported. */
export interface FragmentWarning {
  code: FragmentWarningCode;
  message: string;
}

/**
 * One turn of the body. `role` is null for a block: text nobody is named for (the whole body when
 * no speaker is marked, or the text before the first mark).
 */
export interface FragmentTurn {
  role: FragmentRole | null;
  text: string;
}

/** The frontmatter fields the importer reads, after they have been checked. */
export interface FragmentFields {
  title: string;
  models: string[];
  platform?: string;
  /** `tags` as written, then nothing else: the platform and the collection are added by the transformer */
  tags: string[];
  collection?: string;
  part?: string;
  system?: string;
  description?: string;
  synopsis?: string;
  categories: string[];
  keywords: string[];
  /** false: never send it for metadata generation */
  generate?: boolean;
  /** `speakers` as parsed from the frontmatter, kept whole (unknown keys too) */
  speakers?: unknown;
}

export interface ParsedFragment {
  name: string;
  /** The frontmatter `id`, lower-cased */
  id: string;
  fields: FragmentFields;
  /** The date as given: a rough date, an exact time (`roughDate` undefined) or none (precision `unknown`) */
  roughDate?: RoughDate;
  /** Middle of the range, the instant of an exact time, or 0 for none: `Chat.timestamp` */
  timestamp: number;
  /** The text between the fences, as written (YAML comments included) */
  frontmatter: string;
  /** Everything after the closing fence */
  body: string;
  turns: FragmentTurn[];
  /** `body == seams[0] + turns[0].text + seams[1] + ... + tail` */
  seams: string[];
  tail: string;
  warnings: FragmentWarning[];
}

export type ParseOutcome =
  | { ok: true; fragment: ParsedFragment }
  | { ok: false; state: FragmentRefusal; message: string };

/** A parsed fragment with the hashes the plan and the transformer need. */
export interface HashedFragment extends ParsedFragment {
  /** SHA-256 of the whole file as text */
  fileSha256: string;
  /** SHA-256 of the body */
  bodySha256: string;
}

export interface FragmentPlanEntry {
  name: string;
  state: FragmentState;
  /** The fragment's id, when the file has a valid one */
  id?: string;
  title?: string;
  /** The date as the file wrote it */
  date?: string;
  /** Messages the fragment will have */
  turns?: number;
  warnings: FragmentWarning[];
  /** Why a file is refused, or which other file it repeats */
  message?: string;
}

/** What the plan needs from the archive. The plan imports no service. */
export interface FragmentLookup {
  /** The stored fragment with this id (live, not deleted), as the hashes and version it was saved with */
  stored(id: string): Promise<{ fileSha256: string; v: number } | undefined>;
  /** A stored fragment whose body has this hash: its id and the file name it came from */
  withBody(bodySha256: string): Promise<{ id: string; fileName: string } | undefined>;
}

/** What `params.fragment` holds on a stored chat. */
export interface FragmentParams {
  v: number;
  fileName: string;
  fileSha256: string;
  bodySha256: string;
  platform?: string;
  collection?: string;
  part?: string;
  speakers?: unknown;
  generate?: boolean;
  frontmatter: string;
  seams: string[];
  tail: string;
  /** Indexes of the messages whose text nobody is named for */
  unattributed: number[];
  /** System turns of the body: their place among the turns and their text (they are not messages) */
  systemTurns?: { at: number; text: string }[];
}
