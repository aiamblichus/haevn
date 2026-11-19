/**
 * Transform an OpenRouter chatroom export to HAEVN.Chat format: one chat per room.
 *
 * How a room is read (measured on a real export, `orpg.3.0`):
 * - A user message has no `parentMessageId`; an assistant message points at the user message it
 *   answers. A turn is therefore linked to its own reply only. The order of the turns is the order
 *   of `createdAt`, so each user message hangs under the last message of the turn before it.
 * - A room may hold several models: their replies to one user message are siblings (branches).
 * - A message is made of items, in order: `reasoning` and `message`. A reasoning item is readable
 *   (`content`, type `reasoning_text`) or only `encrypted_content`, which cannot be read and is left out.
 * - The room has no id of its own. The chat id is the id of its first user message (the earliest
 *   message with no parent): it is fixed for the life of the room, unlike the title, so importing
 *   the same export again, or a later export of the same room, replaces the chat.
 */

import type {
  Chat,
  ChatMessage,
  ModelRequest,
  ModelResponse,
  ModelResponsePart,
} from "../../model/haevn_model";
import { isImportableRoom } from "./importer";
import type {
  OpenRouterCharacter,
  OpenRouterCitation,
  OpenRouterContentBlock,
  OpenRouterItemData,
  OpenRouterMessage,
  OpenRouterRawExtraction,
  OpenRouterRoom,
} from "./model";

export const OPENROUTER_SOURCE = "openrouter";

function parseMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function blockText(blocks: OpenRouterContentBlock[] | undefined, types?: string[]): string {
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block.text !== "string") continue;
    if (types && !(typeof block.type === "string" && types.includes(block.type))) continue;
    texts.push(block.text);
  }
  return texts.join("\n\n");
}

/** The readable text of a reasoning item: its reasoning_text blocks, or else its summary. */
function reasoningText(data: OpenRouterItemData): string {
  const text = blockText(data.content, ["reasoning_text"]);
  if (text.trim()) return text;
  if (Array.isArray(data.summary)) {
    return data.summary
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

interface Prepared {
  message: OpenRouterMessage;
  createdMs: number;
}

/** The message's items, in the order the message lists them. */
function itemsOf(room: OpenRouterRoom, message: OpenRouterMessage): OpenRouterItemData[] {
  const items = room.items ?? {};
  const refs = Array.isArray(message.items) ? message.items : [];
  const data: OpenRouterItemData[] = [];
  for (const ref of refs) {
    const item = ref?.id ? items[ref.id] : undefined;
    if (item?.data) data.push(item.data);
  }
  return data;
}

interface FoundCitation {
  url: string;
  title?: string;
  content?: string;
  start_index?: number;
  end_index?: number;
}

function citationsOf(message: OpenRouterMessage, items: OpenRouterItemData[]): FoundCitation[] {
  const found: FoundCitation[] = [];
  const seen = new Set<string>();
  const add = (entry: Partial<FoundCitation>) => {
    if (typeof entry.url !== "string" || !entry.url) return;
    const key = `${entry.url}|${entry.start_index ?? ""}|${entry.end_index ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...entry, url: entry.url });
  };

  for (const citation of (message.citations ?? []) as OpenRouterCitation[]) {
    const c = citation?.url_citation;
    if (c) {
      add(
        compact({
          url: c.url,
          title: c.title,
          content: c.content,
          start_index: c.start_index,
          end_index: c.end_index,
        }),
      );
    }
  }
  // The same links also sit on the text as annotations; they fill in when the message lists none.
  if (found.length === 0) {
    for (const data of items) {
      for (const block of data.content ?? []) {
        for (const annotation of block?.annotations ?? []) {
          add(
            compact({
              url: annotation.url,
              title: annotation.title,
              start_index: annotation.start_index,
              end_index: annotation.end_index,
            }),
          );
        }
      }
    }
  }
  return found;
}

function selectedProvider(message: OpenRouterMessage): string | undefined {
  const metadata = message.metadata;
  if (!metadata) return undefined;
  if (typeof metadata.provider === "string" && metadata.provider) return metadata.provider;
  const selected = metadata.routerMetadata?.endpoints?.available?.find((e) => e.selected);
  return typeof selected?.provider === "string" ? selected.provider : undefined;
}

function modelOf(room: OpenRouterRoom, message: OpenRouterMessage): string {
  const metadata = message.metadata;
  const fromMessage = metadata?.variantSlug || metadata?.requestedModel;
  if (typeof fromMessage === "string" && fromMessage) return fromMessage;
  const character: OpenRouterCharacter | undefined = message.characterId
    ? room.characters?.[message.characterId]
    : undefined;
  return typeof character?.model === "string" ? character.model : "";
}

function buildRequest(
  room: OpenRouterRoom,
  message: OpenRouterMessage,
  timestampIso: string,
): ModelRequest {
  const text = itemsOf(room, message)
    .filter((data) => data.type === "message")
    .map((data) => blockText(data.content))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return {
    kind: "request",
    parts: [{ part_kind: "user-prompt", content: text, timestamp: timestampIso }],
  };
}

function buildResponse(
  room: OpenRouterRoom,
  message: OpenRouterMessage,
  model: string,
  timestampIso: string,
): { response: ModelResponse; citationUrls: string[] } {
  const items = itemsOf(room, message);
  const parts: ModelResponsePart[] = [];

  for (const data of items) {
    if (data.type === "reasoning") {
      const content = reasoningText(data);
      if (content.trim()) {
        parts.push({
          part_kind: "thinking",
          content,
          ...(typeof data.id === "string" ? { id: data.id } : {}),
        });
      }
    } else if (data.type === "message") {
      const content = blockText(data.content);
      if (content) parts.push({ part_kind: "text", content });
    }
  }
  // A reply that holds nothing readable (it failed, or it is only encrypted reasoning) stays in
  // the tree as an empty answer rather than leaving its turn without one.
  if (!parts.some((part) => part.part_kind === "text")) {
    parts.push({ part_kind: "text", content: "" });
  }

  const metadata = message.metadata ?? {};
  const cost = typeof metadata.cost === "string" ? Number(metadata.cost) : undefined;
  const citations = citationsOf(message, items);

  const usage = compact({
    total_tokens: typeof metadata.tokensCount === "number" ? metadata.tokensCount : undefined,
    cost: cost !== undefined && Number.isFinite(cost) ? cost : undefined,
    tokens_per_second:
      typeof metadata.tokensPerSecond === "number" ? metadata.tokensPerSecond : undefined,
  });
  const vendorDetails = compact({
    provider: selectedProvider(message),
    generation_id: metadata.generationId,
    requested_model: metadata.requestedModel,
    variant_slug: metadata.variantSlug,
    duration_ms: metadata.duration,
    generate_duration_ms: metadata.generateDuration,
    latency_ms: metadata.latencyDuration,
    region: metadata.routerMetadata?.region,
    is_byok: metadata.routerMetadata?.is_byok,
    citations: citations.length > 0 ? citations : undefined,
  });

  const response: ModelResponse = {
    kind: "response",
    parts,
    timestamp: timestampIso,
    ...(model ? { model_name: model } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(Object.keys(vendorDetails).length > 0 ? { vendor_details: vendorDetails } : {}),
  };
  return { response, citationUrls: Array.from(new Set(citations.map((c) => c.url))) };
}

function extractTitle(room: OpenRouterRoom, firstUserText: string): string {
  if (typeof room.title === "string" && room.title.trim()) return room.title.trim();
  const firstLine = firstUserText.split("\n")[0].trim();
  if (firstLine) return firstLine.length > 100 ? `${firstLine.substring(0, 97)}...` : firstLine;
  return "Untitled OpenRouter Chat";
}

/**
 * The room's artifact maps, kept as they are when any holds something. No export seen so far has
 * an artifact, so there is no known shape to map them to messages: they are archived, not shown.
 */
function artifactParams(room: OpenRouterRoom): Record<string, unknown> | undefined {
  const maps = compact({
    artifacts: room.artifacts,
    artifactFiles: room.artifactFiles,
    artifactVersions: room.artifactVersions,
    artifactFileContents: room.artifactFileContents,
  });
  const filled = Object.entries(maps).filter(
    ([, value]) => value && typeof value === "object" && Object.keys(value).length > 0,
  );
  return filled.length > 0 ? Object.fromEntries(filled) : undefined;
}

export function transformOpenRouterRoomToHaevnChat(room: OpenRouterRoom, exportVersion = ""): Chat {
  // A message is known by its key in the room's map, which is unique. Its own `id` field is the
  // same in every export seen; were it not, two entries could share an id and the tree below
  // would fold onto itself.
  const rawMessages = Object.entries(room.messages ?? {}).map(([key, message]) => ({
    ...message,
    id: key,
  }));
  if (rawMessages.length === 0) {
    throw new Error("OpenRouter room has no messages");
  }

  const fallbackMs =
    rawMessages.map((m) => parseMs(m.createdAt)).find((ms): ms is number => ms !== null) ??
    Date.now();
  const prepared: Prepared[] = rawMessages
    .map((message) => ({ message, createdMs: parseMs(message.createdAt) ?? fallbackMs }))
    .sort(
      (a, b) =>
        a.createdMs - b.createdMs ||
        Number(b.message.type === "user") - Number(a.message.type === "user") ||
        (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0),
    );

  // A message links to its parent only when the parent sorts before it. With ids that are unique
  // (the map keys) this rules out a message being its own parent and any cycle, so the links form
  // a forest and the walk below ends.
  const indexOf = new Map(prepared.map((p, i) => [p.message.id, i]));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>(prepared.map((p) => [p.message.id, []]));
  const roots: string[] = [];
  prepared.forEach(({ message }, index) => {
    const parent = message.parentMessageId;
    const parentIndex = parent ? indexOf.get(parent) : undefined;
    if (parent && parentIndex !== undefined && parentIndex < index) {
      parentOf.set(message.id, parent);
      childrenOf.get(parent)?.push(message.id);
    } else {
      roots.push(message.id);
    }
  });

  // The turns are not linked in the file: each user message (a root) follows the turn before it.
  const latestInSubtree = (rootId: string): string => {
    let latest = rootId;
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if ((indexOf.get(id) ?? 0) > (indexOf.get(latest) ?? 0)) latest = id;
      stack.push(...(childrenOf.get(id) ?? []));
    }
    return latest;
  };
  for (let i = 1; i < roots.length; i++) {
    const parent = latestInSubtree(roots[i - 1]);
    parentOf.set(roots[i], parent);
    childrenOf.get(parent)?.push(roots[i]);
  }

  const chatId = roots[0];
  const messages: Record<string, ChatMessage> = {};
  const models: string[] = [];
  const addModel = (model: string) => {
    if (model && !models.includes(model)) models.push(model);
  };
  const unmapped: Record<string, Record<string, unknown[]>> = {};
  let firstUserText = "";

  for (const { message, createdMs } of prepared) {
    const timestampIso = new Date(createdMs).toISOString();
    const isUser = message.type === "user";
    const model = isUser ? "" : modelOf(room, message);
    addModel(model);

    let modelMessage: ModelRequest | ModelResponse;
    let citationUrls: string[] = [];
    if (isUser) {
      const request = buildRequest(room, message, timestampIso);
      const prompt = request.parts[0];
      if (
        !firstUserText &&
        prompt.part_kind === "user-prompt" &&
        typeof prompt.content === "string"
      ) {
        firstUserText = prompt.content;
      }
      modelMessage = request;
    } else {
      const built = buildResponse(room, message, model, timestampIso);
      modelMessage = built.response;
      citationUrls = built.citationUrls;
    }

    // Attachments, files and images have no known shape yet (every one seen was empty).
    const extra: Record<string, unknown[]> = {};
    for (const key of ["attachments", "files", "images"] as const) {
      const value = message[key];
      if (Array.isArray(value) && value.length > 0) extra[key] = value;
    }
    if (Object.keys(extra).length > 0) unmapped[message.id] = extra;

    messages[message.id] = {
      id: message.id,
      parentId: parentOf.get(message.id),
      childrenIds: childrenOf.get(message.id) ?? [],
      message: [modelMessage],
      model,
      done: message.isGenerating !== true,
      ...(citationUrls.length > 0 ? { citations: citationUrls } : {}),
      timestamp: createdMs,
      chatId,
    };
  }

  for (const character of Object.values(room.characters ?? {})) {
    if (typeof character?.model === "string") addModel(character.model);
  }

  const lastUpdated = prepared.reduce((latest, { message, createdMs }) => {
    const updated = parseMs(message.updatedAt) ?? createdMs;
    return Math.max(latest, updated);
  }, 0);

  const characters = Object.values(room.characters ?? {}).map((c) =>
    compact({
      id: c.id,
      model: c.model,
      name: c.name ?? undefined,
      samplingParameters: c.samplingParameters,
      reasoning: c.reasoning ?? undefined,
      isDisabled: c.isDisabled,
      isRemoved: c.isRemoved,
    }),
  );
  const artifacts = artifactParams(room);

  return {
    id: chatId,
    source: OPENROUTER_SOURCE,
    sourceId: chatId,
    title: extractTitle(room, firstUserText),
    models,
    params: compact({
      exportVersion: exportVersion || undefined,
      characters: characters.length > 0 ? characters : undefined,
      artifacts,
      unmappedMessageData: Object.keys(unmapped).length > 0 ? unmapped : undefined,
    }),
    currentId: latestInSubtree(roots[roots.length - 1]),
    messages,
    tags: [],
    timestamp: prepared[0].createdMs,
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: lastUpdated,
    // Sync metadata: placeholders, set by SyncService.saveChat()
    checksum: "",
    syncStatus: "new",
    deleted: 0,
  };
}

/** One chat per room that has a message; a room without one is skipped. */
export function transformOpenRouterExportToHaevnChats(extraction: OpenRouterRawExtraction): Chat[] {
  return extraction.rooms
    .filter(isImportableRoom)
    .map((room) => transformOpenRouterRoomToHaevnChat(room, extraction.version));
}
