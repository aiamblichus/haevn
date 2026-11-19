// src/providers/shared/chatInvariants.ts
//
// One definition of "works" for a transformed chat (HVN-107, step 2 of
// /project/haevn/architecture/provider-health). A pure function over a HAEVN.Chat: no I/O, no
// clock unless the caller hands one in, no chat text in anything it returns. The live health
// check, the unit tests and (later) the local-import script all call this and nothing else.
//
// It returns findings, not a boolean. A finding names a rule (`code`), a level, a count, and the
// positions of the first offenders in the message map's own order. It never carries a message id,
// a title or text, so a report built from findings can be pasted into a ticket.

import type { Chat, ChatMessage, ModelMessage } from "../../model/haevn_model";

export type FindingLevel = "fail" | "warn";

/**
 * Every rule the ruler has. The level is part of the rule: a `fail` says the chat is damaged or
 * the transformer lost something; a `warn` says the chat is odd and a person should look.
 */
export const FINDING_LEVELS = {
  // Identity
  "chat.id-missing": "fail",
  "chat.source-missing": "fail",
  "chat.source-id-missing": "fail",
  "title.empty": "warn",
  "title.fallback": "warn",
  // Messages and the tree
  "messages.none": "fail",
  "message.no-parts": "fail",
  "message.empty-parts": "warn",
  "tree.current-missing": "fail",
  "tree.current-unreachable": "fail",
  "tree.parent-dangling": "fail",
  "tree.child-dangling": "fail",
  "tree.link-mismatch": "fail",
  "tree.cycle": "fail",
  "tree.multiple-roots": "warn",
  // Who spoke
  "turns.no-user": "warn",
  "turns.no-model": "warn",
  "roles.model-first": "warn",
  "roles.not-alternating": "warn",
  // Text
  "text.empty": "fail",
  // Time
  "time.invalid": "fail",
  "time.out-of-range": "fail",
  "time.all-equal": "warn",
  // Models
  "models.none": "warn",
} as const satisfies Record<string, FindingLevel>;

export type FindingCode = keyof typeof FINDING_LEVELS;

const MESSAGES: Record<FindingCode, string> = {
  "chat.id-missing": "the chat has no id",
  "chat.source-missing": "the chat names no source provider",
  "chat.source-id-missing": "the chat has no id on its own site",
  "title.empty": "the title is empty",
  "title.fallback": "the title is the provider's fallback, not a name from the site",
  "messages.none": "the chat holds no messages",
  "message.no-parts": "a message's list of model messages is empty",
  "message.empty-parts": "a model message holds no parts (a site's hidden turn, or a dropped one)",
  "tree.current-missing": "currentId is empty or names no message",
  "tree.current-unreachable": "the path from currentId up does not end at a root",
  "tree.parent-dangling": "a message's parentId names no message",
  "tree.child-dangling": "a childrenIds entry names no message",
  "tree.link-mismatch": "a parent and its child do not list each other",
  "tree.cycle": "the parent links run in a circle",
  "tree.multiple-roots": "more than one message has no parent",
  "turns.no-user": "no user turn in the chat",
  "turns.no-model": "no model turn in the chat",
  "roles.model-first": "the chat's first turn is the model's",
  "roles.not-alternating": "two turns in a row come from the same side",
  "text.empty": "a text, thinking or prompt part is an empty string",
  "time.invalid": "a timestamp is not a date",
  "time.out-of-range": "a timestamp is before 2015 or after tomorrow",
  "time.all-equal": "every message carries the same instant",
  "models.none": "the chat names no model",
};

export interface Finding {
  code: FindingCode;
  level: FindingLevel;
  /** The rule in words. A constant sentence: it never holds chat text, a title or an id. */
  message: string;
  /** How many places broke the rule (1 for a rule about the chat as a whole). */
  count: number;
  /**
   * Where, for a rule about messages: the first few positions (1 is the first message in the
   * chat's message map). A position says nothing about the content.
   */
  at?: number[];
}

export interface CheckOptions {
  /** The clock, in ms. Defaults to Date.now(); a test fixes it. */
  now?: number;
}

/** What a site's own default titles look like. A match is a warning, not proof. */
const FALLBACK_TITLES: ReadonlySet<string> = new Set([
  "new chat",
  "new conversation",
  "deepseek chat",
  "chatgpt conversation",
  "open webui chat",
]);

const EARLIEST_MS = Date.UTC(2015, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POSITIONS = 5;

function isFallbackTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return t.startsWith("untitled") || FALLBACK_TITLES.has(t);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

type Tally = Map<FindingCode, { count: number; at: number[] }>;

function note(tally: Tally, code: FindingCode, position?: number): void {
  const entry = tally.get(code) ?? { count: 0, at: [] };
  entry.count++;
  if (position !== undefined && entry.at.length < MAX_POSITIONS && !entry.at.includes(position)) {
    entry.at.push(position);
  }
  tally.set(code, entry);
}

/** A part's kind, read defensively: a transformer that produced junk must not crash the ruler. */
function partsOf(message: ModelMessage): { part_kind?: unknown; content?: unknown }[] {
  return Array.isArray(message?.parts) ? (message.parts as { part_kind?: unknown }[]) : [];
}

/** The text a user prompt carries; an array of content is empty text only when it holds none. */
function promptIsEmpty(content: unknown): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    // An array of nothing but blank strings has no text and no media.
    return content.every((item) => typeof item === "string" && item.trim() === "");
  }
  return content === undefined || content === null;
}

/** Epoch ms for a number or an ISO string; NaN when it is neither. */
function toMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function checkOne(chat: Chat, now: number, tally: Tally): void {
  const messages: Record<string, ChatMessage> = isRecord(chat.messages) ? chat.messages : {};
  const ids = Object.keys(messages);
  const position = new Map(ids.map((id, index) => [id, index + 1]));

  // 1. Identity
  if (!hasText(chat.id)) note(tally, "chat.id-missing");
  if (!hasText(chat.source)) note(tally, "chat.source-missing");
  if (!hasText(chat.sourceId)) note(tally, "chat.source-id-missing");
  if (!hasText(chat.title)) note(tally, "title.empty");
  else if (isFallbackTitle(chat.title)) note(tally, "title.fallback");

  // 2. Messages and the tree
  if (ids.length === 0) {
    note(tally, "messages.none");
  }

  const hasCurrent = hasText(chat.currentId) && chat.currentId in messages;
  if (ids.length > 0 && !hasCurrent) note(tally, "tree.current-missing");

  const roots: string[] = [];
  for (const id of ids) {
    const message = messages[id];
    const at = position.get(id);
    const parentId = message.parentId;
    if (parentId === undefined || parentId === null || parentId === "") {
      roots.push(id);
    } else if (!(parentId in messages)) {
      note(tally, "tree.parent-dangling", at);
    } else if (!(messages[parentId].childrenIds ?? []).includes(id)) {
      note(tally, "tree.link-mismatch", at);
    }
    for (const childId of message.childrenIds ?? []) {
      if (!(childId in messages)) note(tally, "tree.child-dangling", at);
      else if (messages[childId].parentId !== id) note(tally, "tree.link-mismatch", at);
    }
  }
  if (roots.length > 1) note(tally, "tree.multiple-roots");

  // The path from the current message up to a root. A cycle and a break in the path are different
  // faults: the walk stops at a message it has already seen, or at a parent that is no message.
  const path: string[] = [];
  if (hasCurrent) {
    const seen = new Set<string>();
    let cursor: string | undefined = chat.currentId;
    let ending: "root" | "cycle" | "broken" = "broken";
    while (cursor !== undefined && cursor in messages) {
      if (seen.has(cursor)) {
        ending = "cycle";
        break;
      }
      seen.add(cursor);
      path.push(cursor);
      const parent: string | undefined = messages[cursor].parentId;
      if (parent === undefined || parent === null || parent === "") {
        ending = "root";
        break;
      }
      cursor = parent;
    }
    if (ending === "cycle") note(tally, "tree.cycle");
    else if (ending === "broken") note(tally, "tree.current-unreachable");
    // Whether the chat alternates is judged on a whole branch only; half a branch would start
    // mid-conversation and report a fault the break already told.
    if (ending === "root") path.reverse();
    else path.length = 0;
  }

  // 3-4. Turns, parts and text
  let userTurns = 0;
  let modelTurns = 0;
  for (const id of ids) {
    const message = messages[id];
    const at = position.get(id);
    const models: ModelMessage[] = Array.isArray(message.message) ? message.message : [];
    if (models.length === 0) {
      note(tally, "message.no-parts", at);
      continue;
    }
    for (const model of models) {
      const parts = partsOf(model);
      if (parts.length === 0) {
        note(tally, "message.empty-parts", at);
        continue;
      }
      if (model.kind === "request") {
        if (parts.some((p) => p.part_kind === "user-prompt")) userTurns++;
      } else if (model.kind === "response") {
        modelTurns++;
      }
      for (const part of parts) {
        if (part.part_kind === "text" || part.part_kind === "thinking") {
          if (!hasText(part.content)) note(tally, "text.empty", at);
        } else if (part.part_kind === "user-prompt") {
          if (promptIsEmpty(part.content)) note(tally, "text.empty", at);
        }
      }
    }
  }
  if (ids.length > 0 && userTurns === 0) note(tally, "turns.no-user");
  if (ids.length > 0 && modelTurns === 0) note(tally, "turns.no-model");

  // Alternation along the current branch. A request that is only a system prompt is set-up, not a
  // turn, so it does not count as a side.
  const sides: ("request" | "response")[] = [];
  for (const id of path) {
    const models: ModelMessage[] = Array.isArray(messages[id].message) ? messages[id].message : [];
    for (const model of models) {
      const parts = partsOf(model);
      if (parts.length === 0) continue;
      if (model.kind === "request") {
        if (parts.every((p) => p.part_kind === "system-prompt")) continue;
        sides.push("request");
      } else if (model.kind === "response") {
        sides.push("response");
      }
    }
  }
  if (sides[0] === "response") note(tally, "roles.model-first");
  for (let i = 1; i < sides.length; i++) {
    if (sides[i] === sides[i - 1]) note(tally, "roles.not-alternating");
  }

  // 5. Time
  const latest = now + DAY_MS;
  const checkInstant = (value: unknown, at?: number): void => {
    const ms = toMs(value);
    if (!Number.isFinite(ms)) note(tally, "time.invalid", at);
    else if (ms < EARLIEST_MS || ms > latest) note(tally, "time.out-of-range", at);
  };
  checkInstant(chat.timestamp);
  if (chat.providerLastModifiedTimestamp !== undefined) {
    checkInstant(chat.providerLastModifiedTimestamp);
  }
  const instants: number[] = [];
  for (const id of ids) {
    const message = messages[id];
    const at = position.get(id);
    if (message.timestamp !== undefined) {
      checkInstant(message.timestamp, at);
      if (typeof message.timestamp === "number") instants.push(message.timestamp);
    }
    for (const model of Array.isArray(message.message) ? message.message : []) {
      if (model.timestamp !== undefined) checkInstant(model.timestamp, at);
      for (const part of partsOf(model)) {
        const stamp = (part as { timestamp?: unknown }).timestamp;
        if (stamp !== undefined) checkInstant(stamp, at);
      }
    }
  }
  if (instants.length >= 2 && instants.every((t) => t === instants[0])) {
    note(tally, "time.all-equal");
  }

  // 6. Models
  const named = Array.isArray(chat.models) && chat.models.some(hasText);
  if (!named) note(tally, "models.none");
}

/**
 * Check one transformed chat, or the several a transform may return, against the invariants.
 * Returns one finding per rule broken, with a count across the chats given; an empty array means
 * the chat works.
 */
export function checkChat(chat: Chat | readonly Chat[], options: CheckOptions = {}): Finding[] {
  const now = options.now ?? Date.now();
  const chats: readonly Chat[] = Array.isArray(chat) ? chat : [chat as Chat];
  const tally: Tally = new Map();
  for (const one of chats) {
    if (!isRecord(one)) {
      note(tally, "messages.none");
      continue;
    }
    checkOne(one, now, tally);
  }
  return [...tally.entries()].map(([code, { count, at }]) => ({
    code,
    level: FINDING_LEVELS[code],
    message: MESSAGES[code],
    count,
    ...(at.length > 0 ? { at } : {}),
  }));
}

/** What a chat is made of: counts and kinds only, so a report shows what was looked at. */
export interface ChatShape {
  messages: number;
  userTurns: number;
  modelTurns: number;
  /** How many parts of each kind, by part_kind. */
  parts: Record<string, number>;
}

export function describeChat(chat: Chat): ChatShape {
  const shape: ChatShape = { messages: 0, userTurns: 0, modelTurns: 0, parts: {} };
  const messages: Record<string, ChatMessage> = isRecord(chat?.messages) ? chat.messages : {};
  for (const message of Object.values(messages)) {
    shape.messages++;
    for (const model of Array.isArray(message.message) ? message.message : []) {
      const parts = partsOf(model);
      if (model.kind === "request" && parts.some((p) => p.part_kind === "user-prompt")) {
        shape.userTurns++;
      } else if (model.kind === "response" && parts.length > 0) {
        shape.modelTurns++;
      }
      for (const part of parts) {
        const kind = typeof part.part_kind === "string" ? part.part_kind : "unknown";
        shape.parts[kind] = (shape.parts[kind] ?? 0) + 1;
      }
    }
  }
  return shape;
}
