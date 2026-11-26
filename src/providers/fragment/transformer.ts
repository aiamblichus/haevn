/**
 * Fragment to HAEVN.Chat (HVN-163).
 *
 * The chat's id is `fragment:<uuid>`, so a fragment can only replace a fragment: a person who
 * recovers a chat that Claude once held may paste its old id, and that must not reach the synced
 * chat. Every turn is an exact slice of the file; `reassembleFragment` puts the body back.
 */

import type {
  Chat,
  ChatMessage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "../../model/haevn_model";
import { FRAGMENT_PARSER_VERSION, type FragmentParams, type HashedFragment } from "./model";

export const FRAGMENT_SOURCE = "fragment";

/** The id a fragment's chat has: the frontmatter id behind a prefix. */
export function fragmentChatId(id: string): string {
  return `${FRAGMENT_SOURCE}:${id.toLowerCase()}`;
}

function messageId(index: number, count: number): string {
  // At least four digits, so that the order of ids is the order of the file
  const width = Math.max(4, String(count).length);
  return `t${String(index + 1).padStart(width, "0")}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

/** The metadata the file gives; undefined when it gives none and does not exempt itself. */
function givenMetadata(fragment: HashedFragment): Chat["haevnMetadata"] {
  const { title, description, synopsis, categories, keywords, generate } = fragment.fields;
  const given: NonNullable<Chat["haevnMetadata"]> = {};
  if (title) given.title = title;
  if (description) given.description = description;
  if (synopsis) given.synopsis = synopsis;
  if (categories.length > 0) given.categories = categories;
  if (keywords.length > 0) given.keywords = keywords;
  if (Object.keys(given).length > 0) return given;
  // `generate: false` is a record of the person's own that holds the title: nothing queues it
  return generate === false ? { title } : undefined;
}

/** True when the file itself gives a metadata field (the record is then the person's). */
export function givesMetadata(fragment: HashedFragment): boolean {
  const { title, description, synopsis, categories, keywords } = fragment.fields;
  return Boolean(title || description || synopsis || categories.length || keywords.length);
}

export function transformFragmentToHaevnChat(
  fragment: HashedFragment,
  now: number = Date.now(),
): Chat {
  const { fields } = fragment;
  const chatId = fragmentChatId(fragment.id);
  const model = fields.models[0] ?? "";

  const systemTurns: { at: number; text: string }[] = [];
  const spoken: { role: "user" | "assistant" | null; text: string }[] = [];
  fragment.turns.forEach((turn, at) => {
    if (turn.role === "system") systemTurns.push({ at, text: turn.text });
    else spoken.push({ role: turn.role, text: turn.text });
  });
  const system = [fields.system, ...systemTurns.map((turn) => turn.text)]
    .filter((text): text is string => Boolean(text))
    .join("\n\n");

  const messages: Record<string, ChatMessage> = {};
  const unattributed: number[] = [];
  let previous: string | undefined;
  let systemPlaced = false;

  spoken.forEach((turn, index) => {
    const id = messageId(index, spoken.length);
    // Order is known even when time is not: turn i is i ms after the date
    const timestamp = fragment.timestamp + index;
    const iso = new Date(timestamp).toISOString();

    let message: ModelMessage;
    if (turn.role === "user") {
      const request: ModelRequest = {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: turn.text, timestamp: iso }],
      };
      if (system && !systemPlaced) {
        request.parts.unshift({ part_kind: "system-prompt", content: system, timestamp: iso });
        systemPlaced = true;
      }
      message = request;
    } else {
      const response: ModelResponse = {
        kind: "response",
        parts: [{ part_kind: "text", content: turn.text }],
        timestamp: iso,
      };
      if (model) response.model_name = model;
      message = response;
      if (turn.role === null) unattributed.push(index);
    }

    messages[id] = {
      id,
      parentId: previous,
      childrenIds: [],
      message: [message],
      model,
      done: true,
      timestamp,
      chatId,
    };
    if (previous) messages[previous].childrenIds.push(id);
    previous = id;
  });

  const platform = fields.platform;
  const fragmentParams: FragmentParams = {
    v: FRAGMENT_PARSER_VERSION,
    fileName: fragment.name.split(/[\\/]/).pop() ?? fragment.name,
    fileSha256: fragment.fileSha256,
    bodySha256: fragment.bodySha256,
    ...(platform ? { platform } : {}),
    ...(fields.collection ? { collection: fields.collection } : {}),
    ...(fields.part ? { part: fields.part } : {}),
    ...(fields.speakers !== undefined ? { speakers: fields.speakers } : {}),
    ...(fields.generate !== undefined ? { generate: fields.generate } : {}),
    frontmatter: fragment.frontmatter,
    seams: fragment.seams,
    tail: fragment.tail,
    unattributed,
    ...(systemTurns.length > 0 ? { systemTurns } : {}),
  };

  const haevnMetadata = givenMetadata(fragment);
  const chat: Chat = {
    id: chatId,
    source: FRAGMENT_SOURCE,
    sourceId: fragment.id,
    title: fields.title,
    models: fields.models,
    ...(system ? { system } : {}),
    params: {
      ...(fragment.roughDate ? { roughDate: fragment.roughDate } : {}),
      fragment: fragmentParams,
    },
    currentId: previous ?? "",
    messages,
    tags: unique([
      ...fields.tags,
      ...(platform ? [platform] : []),
      ...(fields.collection ? [fields.collection] : []),
    ]),
    timestamp: fragment.timestamp,
    lastSyncedTimestamp: now,
    // The archive's "Modified Time" sort reads this: a fragment always carries it (HVN-165)
    providerLastModifiedTimestamp: fragment.timestamp,
    checksum: "",
    syncStatus: "new",
    deleted: 0,
    ...(haevnMetadata ? { haevnMetadata } : {}),
  };
  return chat;
}

/** The text a message holds: the one part that is the turn (a system prompt part is not). */
function turnText(message: ChatMessage): string {
  const model = message.message[0];
  if (!model) return "";
  if (model.kind === "response") {
    const part = model.parts.find((p) => p.part_kind === "text");
    return part?.part_kind === "text" ? part.content : "";
  }
  const part = model.parts.find((p) => p.part_kind === "user-prompt");
  return part?.part_kind === "user-prompt" && typeof part.content === "string" ? part.content : "";
}

/**
 * The body of the file a fragment came from, byte for byte: the seams, the turns' text and the
 * tail, put together. It is what "kept as written" means, and a test holds it for every fixture.
 * `chat` is the whole chat, messages included.
 */
export function reassembleFragment(chat: Pick<Chat, "params" | "messages">): string {
  const params = chat.params?.fragment as FragmentParams | undefined;
  if (!params) throw new Error("Not a fragment: params.fragment is missing");

  const spoken = Object.values(chat.messages)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(turnText);
  const system = new Map((params.systemTurns ?? []).map((turn) => [turn.at, turn.text]));

  let body = "";
  let next = 0;
  for (let at = 0; at < params.seams.length; at++) {
    body += params.seams[at] + (system.get(at) ?? spoken[next++] ?? "");
  }
  return body + params.tail;
}
