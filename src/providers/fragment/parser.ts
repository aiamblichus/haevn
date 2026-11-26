/**
 * The fragment parser (HVN-163): pure, no I/O, no clock. A file is YAML frontmatter and a body.
 * The parser reads the frontmatter, splits the body into turns where the person has marked them,
 * and keeps every byte it does not put in a turn, so the body can be put back as written.
 */

import { parse as parseYaml } from "yaml";
import type { RoughDate } from "../../model/roughDate";
import type {
  FragmentFields,
  FragmentFile,
  FragmentRefusal,
  FragmentRole,
  FragmentTurn,
  FragmentWarning,
  ParseOutcome,
} from "./model";
import { FRAGMENT_BASE_VERSION, FRAGMENT_PARSER_VERSION } from "./model";

// ─── Rough dates ───────────────────────────────────────────────────────────────

export type DateParse =
  | {
      ok: true;
      /** Undefined for an exact time: the chat's `timestamp` says it all */
      roughDate?: RoughDate;
      timestamp: number;
    }
  | { ok: false; message: string };

interface Span {
  from: number;
  /** exclusive */
  to: number;
  precision: "year" | "month" | "day" | "exact";
}

/** A UTC instant from calendar fields; `Date.UTC` would read the years 0 to 99 as 1900 to 1999. */
function utc(y: number, m0: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m0, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

const YEAR = /^(\d{4})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXACT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** One date in a form of the table, as the range it stands for; undefined for any other text. */
function spanOf(token: string): Span | undefined {
  let match = YEAR.exec(token);
  if (match) {
    const y = Number(match[1]);
    return { from: utc(y, 0, 1), to: utc(y + 1, 0, 1), precision: "year" };
  }
  match = MONTH.exec(token);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (m < 1 || m > 12) return undefined;
    return { from: utc(y, m - 1, 1), to: utc(y, m, 1), precision: "month" };
  }
  match = DAY.exec(token);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!validDay(y, m, d)) return undefined;
    return { from: utc(y, m - 1, d), to: utc(y, m - 1, d + 1), precision: "day" };
  }
  match = EXACT.exec(token);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const [h, mi, s] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
    if (!validDay(y, m, d) || h > 23 || mi > 59 || s > 59) return undefined;
    const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
    let instant = utc(y, m - 1, d, h, mi, s, ms);
    const zone = match[8];
    if (zone && zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const [hours, minutes] = [Number(digits.slice(0, 2)), Number(digits.slice(2))];
      // No zone in use is further than 14:00 from UTC, and a minute is under 60
      if (minutes > 59 || hours * 60 + minutes > 14 * 60) return undefined;
      instant -= sign * (hours * 60 + minutes) * 60_000;
    }
    return { from: instant, to: instant + 1, precision: "exact" };
  }
  return undefined;
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const check = new Date(utc(y, m - 1, d));
  return check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/** A YAML `date:` value as the text it was written as; undefined for a value that has no such text. */
function dateText(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // A YAML 1.1 reader gives a Date for `2024-03-15`; midnight UTC is the day, anything else a time
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  return undefined;
}

const BAD_DATE =
  "date is none of: 2024, 2024-03, 2024-03-15, 2024-03-15T14:30:00Z, 2023-11..2024-02, 2024-03.., or unknown";

/**
 * Reads the `date:` of a file (the table in /project/haevn/architecture/fragments, Rough dates).
 * The same text gives the same numbers in every time zone: a time with no offset is UTC.
 */
export function parseRoughDate(value: unknown): DateParse {
  const given = dateText(value);
  if (given === undefined) return { ok: false, message: BAD_DATE };
  if (given === "" || given.toLowerCase() === "unknown") {
    return {
      ok: true,
      timestamp: 0,
      roughDate: { text: given, precision: "unknown", approximate: false, from: 0, to: 0 },
    };
  }

  const approximate = given.startsWith("~");
  const text = (approximate ? given.slice(1) : given).trim();
  const bad = { ok: false, message: BAD_DATE } as const;

  const dots = text.indexOf("..");
  if (dots === -1) {
    const span = spanOf(text);
    if (!span) return bad;
    if (span.precision === "exact") {
      // `~` has no honest meaning on an instant, and the claim must not be lost without a word
      if (approximate) return bad;
      return { ok: true, timestamp: span.from };
    }
    return {
      ok: true,
      timestamp: Math.floor((span.from + span.to) / 2),
      roughDate: {
        text: given,
        precision: span.precision,
        approximate,
        from: span.from,
        to: span.to,
      },
    };
  }

  const first = spanOf(text.slice(0, dots).trim());
  const rest = text.slice(dots + 2).trim();
  if (!first || rest.includes("..")) return bad;

  if (rest === "") {
    return {
      ok: true,
      timestamp: first.from,
      roughDate: { text: given, precision: "after", approximate, from: first.from, to: null },
    };
  }
  const last = spanOf(rest);
  if (!last || last.to <= first.from) return bad;
  return {
    ok: true,
    timestamp: Math.floor((first.from + last.to) / 2),
    roughDate: { text: given, precision: "range", approximate, from: first.from, to: last.to },
  };
}

// ─── Frontmatter ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Split {
  /** The text between the fences, without the line break before the closing fence */
  frontmatter: string;
  body: string;
}

/**
 * Splits a file at its frontmatter fences: a first line that is `---` and the next line that is
 * `---`. A byte-order mark in front of the first fence is ignored. A file whose first line is not a
 * fence, or whose fence is never closed, has no frontmatter.
 */
export function splitFrontmatter(content: string): Split | undefined {
  const text = content.startsWith("﻿") ? content.slice(1) : content;
  const open = /^---[ \t]*(\r?\n|$)/.exec(text);
  if (!open) return undefined;

  let pos = open[0].length;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(pos, newline === -1 ? text.length : newline).replace(/\r$/, "");
    if (line.trimEnd() === "---") {
      const inner = text.slice(open[0].length, pos).replace(/\r?\n$/, "");
      return { frontmatter: inner, body: text.slice(next) };
    }
    pos = next;
  }
  return undefined;
}

function refuse(state: FragmentRefusal, message: string): ParseOutcome {
  return { ok: false, state, message };
}

/** A YAML error as one line that says where, and does not quote the file. */
function yamlProblem(err: unknown): string {
  const line = (err as { linePos?: Array<{ line?: number }> })?.linePos?.[0]?.line;
  return line ? `frontmatter is not valid YAML (line ${line})` : "frontmatter is not valid YAML";
}

function warn(warnings: FragmentWarning[], code: FragmentWarning["code"], message: string): void {
  warnings.push({ code, message });
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A string or a list of strings (numbers count as their text), trimmed; empty ones left out. */
function listOf(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    const text = textOf(item);
    if (text === undefined) return undefined;
    if (text) out.push(text);
  }
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function readFields(record: Record<string, unknown>, warnings: FragmentWarning[]): FragmentFields {
  const field = <T>(
    key: string,
    read: (value: unknown) => T | undefined,
    kind: string,
  ): T | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    const result = read(value);
    if (result === undefined) warn(warnings, "bad-field", `${key} is not ${kind}; it is not read`);
    return result;
  };
  const nonEmpty = (value: string | undefined) => (value ? value : undefined);

  const models = unique(field("model", listOf, "a name or a list of names") ?? []);
  if (models.some((model) => model.toLowerCase() === "unknown")) {
    warn(
      warnings,
      "model-unknown",
      'model "unknown" is kept as written; leave model out when it is not known',
    );
  }

  const fields: FragmentFields = {
    title: field("title", textOf, "text") ?? "",
    models,
    platform: nonEmpty(field("platform", textOf, "text")),
    tags: unique(field("tags", listOf, "a tag or a list of tags") ?? []),
    collection: nonEmpty(field("collection", textOf, "text")),
    part: nonEmpty(field("part", textOf, "text or a number")),
    system: typeof record.system === "string" && record.system.trim() ? record.system : undefined,
    description: nonEmpty(field("description", textOf, "text")),
    synopsis: nonEmpty(field("synopsis", textOf, "text")),
    categories: unique(field("categories", listOf, "a list of names") ?? []),
    keywords: unique(field("keywords", listOf, "a list of words") ?? []),
    generate: field("generate", (v) => (typeof v === "boolean" ? v : undefined), "true or false"),
  };
  if (record.system !== undefined && record.system !== null && typeof record.system !== "string") {
    warn(warnings, "bad-field", "system is not text; it is not read");
  }
  if (record.speakers !== undefined && record.speakers !== null) {
    fields.speakers = record.speakers;
  }
  return fields;
}

// ─── Turns ─────────────────────────────────────────────────────────────────────

interface Line {
  start: number;
  /** end of the text, before the line break */
  end: number;
  /** start of the next line */
  next: number;
  text: string;
}

function scanLines(body: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos < body.length) {
    const newline = body.indexOf("\n", pos);
    const next = newline === -1 ? body.length : newline + 1;
    let end = newline === -1 ? body.length : newline;
    if (end > pos && body[end - 1] === "\r") end--;
    lines.push({ start: pos, end, next, text: body.slice(pos, end) });
    pos = next;
  }
  return lines;
}

const isBlank = (line: Line) => line.text.trim() === "";

/** A line that starts a turn (or, for a prompt, is one). */
interface Mark {
  line: number;
  /** null for a block */
  role: FragmentRole | null;
  /** Where the turn's own text begins on the marker's line, when it begins there */
  inlineFrom?: number;
  /** A prompt: the turn is the rest of this line, and what follows is the assistant's */
  prompt?: boolean;
}

const HAEVN_MARKER = /^\s*<!--\s*HAEVN:\s*role=["'](user|assistant|system)["']\s*-->\s*$/i;
const HEADING = /^#{1,3}[ \t]+(user|assistant|system)[ \t]*$/i;

function marksByPattern(lines: Line[], pattern: RegExp): Mark[] {
  const marks: Mark[] = [];
  lines.forEach((line, index) => {
    const match = pattern.exec(line.text);
    if (match) marks.push({ line: index, role: match[1].toLowerCase() as FragmentRole });
  });
  return marks;
}

/** What a declared label does when a line matches it: a turn of a speaker, or a block. */
type LabelKind = FragmentRole | "break";

interface SpeakerConfig {
  labels: Map<string, LabelKind>;
  prompts: string[];
  /** Who speaks the text before the first mark, when the file says */
  lead?: FragmentRole;
  /**
   * It declares at least one label (a `break` too) or prompt that can match. `lead` is not one: it
   * names the speaker of a stretch of text and competes with no mark.
   */
  usable: boolean;
}

const LABEL_KEYS: FragmentRole[] = ["user", "assistant", "system"];
/** The keys that are read. Any other key under `speakers` is kept, never read, never a refusal */
const READ_KEYS = new Set<string>([...LABEL_KEYS, "break", "prompt", "lead"]);

function readSpeakers(speakers: unknown, warnings: FragmentWarning[]): SpeakerConfig {
  const config: SpeakerConfig = { labels: new Map(), prompts: [], usable: false };
  if (speakers === undefined) return config;
  if (!speakers || typeof speakers !== "object" || Array.isArray(speakers)) {
    warn(warnings, "speakers-bad-type", "speakers is not a map of labels; it is not read");
    return config;
  }
  const record = speakers as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!READ_KEYS.has(key)) {
      warn(warnings, "speakers-unknown-key", `speakers.${key} is not read`);
    }
  }
  // The first of these has a label that is under two of them
  for (const key of [...LABEL_KEYS, "break"] as const) {
    if (record[key] === undefined) continue;
    const labels = listOf(record[key]);
    if (!labels) {
      warn(warnings, "speakers-bad-type", `speakers.${key} must be a label or a list of labels`);
      continue;
    }
    for (const label of labels) {
      const owner = config.labels.get(label);
      if (owner) {
        warn(
          warnings,
          "speakers-duplicate-label",
          `speakers: "${label}" is under both ${owner} and ${key}; ${owner} is used`,
        );
      } else {
        config.labels.set(label, key);
      }
    }
  }
  if (record.prompt !== undefined) {
    const prompts = listOf(record.prompt);
    if (!prompts) {
      warn(warnings, "speakers-bad-type", "speakers.prompt must be a prefix or a list of prefixes");
    } else {
      config.prompts = prompts.sort((a, b) => b.length - a.length);
    }
  }
  if (record.lead !== undefined) {
    const lead = textOf(record.lead)?.toLowerCase();
    if (lead === "user" || lead === "assistant" || lead === "system") {
      config.lead = lead;
    } else {
      warn(warnings, "speakers-bad-type", "speakers.lead must be user, assistant or system");
    }
  }
  config.usable = config.labels.size > 0 || config.prompts.length > 0;
  return config;
}

/**
 * Whether a line is one of the declared labels: the line, trimmed, equals the label or the label
 * and a colon; or it starts with the label, a colon and a space, and the rest of it is the start
 * of the text. The match is exact and case-sensitive.
 */
function labelMark(line: Line, index: number, config: SpeakerConfig): Mark | undefined {
  const trimmed = line.text.trim();
  if (!trimmed) return undefined;
  const lead = line.text.length - line.text.trimStart().length;
  for (const [label, role] of config.labels) {
    // A break starts a block, which nobody speaks
    const speaker = role === "break" ? null : role;
    if (trimmed === label || trimmed === `${label}:`) return { line: index, role: speaker };
    if (trimmed.startsWith(`${label}: `)) {
      const from = line.start + lead + label.length + 2;
      if (line.text.slice(from - line.start).trim() === "") return { line: index, role: speaker };
      return { line: index, role: speaker, inlineFrom: from };
    }
  }
  return undefined;
}

function promptMark(line: Line, index: number, config: SpeakerConfig): Mark | undefined {
  for (const prefix of config.prompts) {
    if (!line.text.startsWith(prefix)) continue;
    let from = line.start + prefix.length;
    while (
      from < line.end &&
      (line.text[from - line.start] === " " || line.text[from - line.start] === "\t")
    ) {
      from++;
    }
    return {
      line: index,
      role: "user",
      prompt: true,
      inlineFrom:
        from < line.end && line.text.slice(from - line.start).trim() !== "" ? from : undefined,
    };
  }
  return undefined;
}

function declaredMarks(lines: Line[], config: SpeakerConfig): Mark[] {
  const marks: Mark[] = [];
  lines.forEach((line, index) => {
    const mark = labelMark(line, index, config) ?? promptMark(line, index, config);
    if (mark) marks.push(mark);
  });
  return marks;
}

interface Candidate {
  role: FragmentRole | null;
  /** The text before the first mark (all of it, when there is none), named by `speakers.lead` */
  lead?: boolean;
  /** Offsets into the body: the text is body.slice(from, to) */
  from: number;
  to: number;
}

/**
 * The text of a region of whole lines [first, last): from the first line that is not blank to the
 * end of the last that is not. `inlineFrom` starts it inside the first line. A region of blank
 * lines is empty (from === to).
 */
function regionText(
  lines: Line[],
  first: number,
  last: number,
  inlineFrom?: number,
): { from: number; to: number } {
  let a = first;
  let b = last - 1;
  if (inlineFrom === undefined) {
    while (a <= b && isBlank(lines[a])) a++;
  }
  while (b >= a && isBlank(lines[b])) b--;
  if (a > b) return { from: 0, to: 0 };
  return { from: inlineFrom ?? lines[a].start, to: lines[b].end };
}

function candidatesFor(lines: Line[], marks: Mark[], lead?: FragmentRole): Candidate[] {
  const out: Candidate[] = [];
  const add = (
    role: FragmentRole | null,
    first: number,
    last: number,
    inlineFrom?: number,
    isLead = false,
  ) => {
    const { from, to } = regionText(lines, first, last, inlineFrom);
    if (to > from) out.push({ role, from, to, ...(isLead ? { lead: true } : {}) });
  };

  // With no mark at all the whole body is the text before the first mark: one block, or the
  // speaker's when `lead` says whose it is
  const before = marks.length === 0 ? lines.length : marks[0].line;
  if (before > 0) add(lead ?? null, 0, before, undefined, lead !== undefined);
  marks.forEach((mark, i) => {
    const stop = marks[i + 1]?.line ?? lines.length;
    if (mark.prompt) {
      // A prompt prefix with nothing after it is no turn; the reply under it still is
      if (mark.inlineFrom !== undefined) add("user", mark.line, mark.line + 1, mark.inlineFrom);
      add("assistant", mark.line + 1, stop);
    } else if (mark.inlineFrom !== undefined) {
      add(mark.role, mark.line, stop, mark.inlineFrom);
    } else {
      add(mark.role, mark.line + 1, stop);
    }
  });
  return out;
}

interface Segmented {
  turns: FragmentTurn[];
  seams: string[];
  tail: string;
}

function segment(body: string, candidates: Candidate[]): Segmented {
  const turns: FragmentTurn[] = [];
  const seams: string[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    seams.push(body.slice(cursor, candidate.from));
    turns.push({ role: candidate.role, text: body.slice(candidate.from, candidate.to) });
    cursor = candidate.to;
  }
  return { turns, seams, tail: body.slice(cursor) };
}

interface SplitTurns extends Segmented {
  /** The lowest parser version that reads this file as it is stored (see `ParsedFragment`) */
  minVersion: number;
}

function splitTurns(body: string, speakers: unknown, warnings: FragmentWarning[]): SplitTurns {
  const lines = scanLines(body);
  const config = readSpeakers(speakers, warnings);

  let marks = marksByPattern(lines, HAEVN_MARKER);
  if (marks.length === 0) marks = marksByPattern(lines, HEADING);
  const own = marks.length > 0;
  let noMatchWarned = false;
  if (own) {
    if (config.usable) {
      warn(
        warnings,
        "speakers-unused",
        "speakers is declared, but the body has its own speaker marks; those are used",
      );
    }
  } else {
    marks = declaredMarks(lines, config);
    if (config.usable && marks.length === 0) {
      warn(warnings, "speakers-no-match", "speakers declared, no line matched");
      noMatchWarned = true;
    }
  }

  // The version a reader needs for this file: a `break` that is read, or a `lead`, is a form the
  // first parser did not know. Any other file is stored the same by both, and is left alone.
  const breakRead = !own && [...config.labels.values()].includes("break");
  const minVersion =
    breakRead || config.lead !== undefined ? FRAGMENT_PARSER_VERSION : FRAGMENT_BASE_VERSION;

  const candidates = candidatesFor(lines, marks, config.lead);
  // A body whose marks have nothing after them, or only a system prompt, is one block as written
  if (!candidates.some((candidate) => candidate.role !== "system")) {
    if (candidates.some((candidate) => candidate.lead) && !noMatchWarned) {
      warn(
        warnings,
        "speakers-no-match",
        "speakers.lead is system and no other text is marked: the file is one block",
      );
    }
    return { ...segment(body, candidatesFor(lines, [])), minVersion };
  }
  if (!own && config.usable) oneSidedWarning(candidates, config, warnings);
  return { ...segment(body, candidates), minVersion };
}

/**
 * Every turn the declared labels found belongs to one side: the person may have meant `break`.
 * A file that declares a `break` has thought of it, and the text before the first mark, whoever
 * `lead` names, is not a turn a label found.
 */
function oneSidedWarning(
  candidates: Candidate[],
  config: SpeakerConfig,
  warnings: FragmentWarning[],
): void {
  if (config.prompts.length > 0) return;
  if ([...config.labels.values()].includes("break")) return;
  const spoken = candidates.filter(
    (candidate) => !candidate.lead && (candidate.role === "user" || candidate.role === "assistant"),
  );
  const sides = new Set(spoken.map((candidate) => candidate.role));
  if (spoken.length < 2 || sides.size !== 1) return;
  warn(
    warnings,
    "speakers-one-side",
    `${spoken.length} turns, all the ${[...sides][0]}'s: if this label only marks where an exchange starts, declare it under \`break\``,
  );
}

// ─── The file ──────────────────────────────────────────────────────────────────

/**
 * Reads one fragment file. A file that cannot be imported is refused with its reason; every other
 * oddity is a warning on the fragment, and the file is imported all the same.
 */
export function parseFragment(file: FragmentFile): ParseOutcome {
  const split = splitFrontmatter(file.content);
  if (!split) {
    return refuse("no-id", "no frontmatter: the file must start with a --- block that has an id");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatter);
  } catch (err) {
    return refuse("unreadable", yamlProblem(err));
  }
  if (parsed === null || parsed === undefined) {
    return refuse("no-id", "the frontmatter has no id");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("unreadable", "frontmatter is not a map of keys");
  }
  const record = parsed as Record<string, unknown>;

  if (record.id === undefined) return refuse("no-id", "the frontmatter has no id");
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!UUID.test(id)) {
    return refuse("bad-id", "id is not a UUID (8-4-4-4-12 hexadecimal digits)");
  }

  const date = parseRoughDate(record.date);
  if (!date.ok) return refuse("bad-date", date.message);

  if (split.body.trim() === "") return refuse("unreadable", "the body is empty");

  const warnings: FragmentWarning[] = [];
  const fields = readFields(record, warnings);
  if (fields.generate === false && !fields.title) {
    warn(
      warnings,
      "no-title-no-generate",
      "no title, and generate is false: nothing will ever name this chat",
    );
  }
  const { turns, seams, tail, minVersion } = splitTurns(split.body, fields.speakers, warnings);

  return {
    ok: true,
    fragment: {
      name: file.name,
      id: id.toLowerCase(),
      fields,
      roughDate: date.roughDate,
      timestamp: date.timestamp,
      frontmatter: split.frontmatter,
      body: split.body,
      turns,
      seams,
      tail,
      minVersion,
      warnings,
    },
  };
}
