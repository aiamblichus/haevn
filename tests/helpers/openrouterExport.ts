/**
 * A small synthetic OpenRouter chatroom export (`orpg.3.0`), in the shape of a real one: a user
 * message has no parent, an assistant message points at the user message it answers, and a
 * message's items sit in the room's `items` map. Every text here is invented.
 */

import type {
  OpenRouterItem,
  OpenRouterMessage,
  OpenRouterRawExtraction,
  OpenRouterRoom,
} from "../../src/providers/openrouter/model";

export interface TurnSpec {
  /** The user's text. */
  user: string;
  /** One entry per model that answers; the key is a character id of the room. */
  replies: Array<{
    character: string;
    text: string;
    /** Readable reasoning, shown as a thinking part. */
    reasoning?: string;
    /** An encrypted-only reasoning item, which must be left out. */
    encrypted?: boolean;
    metadata?: Record<string, unknown>;
    citations?: OpenRouterMessage["citations"];
  }>;
}

export interface RoomSpec {
  title: string;
  /** Epoch seconds of the first message; it is also in the ids, as in a real export. */
  start: number;
  /** Seconds between messages. */
  step?: number;
  characters?: Record<string, string>;
  turns: TurnSpec[];
}

const iso = (seconds: number, millis = 0) => new Date(seconds * 1000 + millis).toISOString();

/**
 * The ids are made from the room's start and the order of its messages, so the same spec with
 * more turns, or other texts, has the same ids for the messages it shares: the same room, later.
 */
export function makeRoom(spec: RoomSpec): OpenRouterRoom {
  let counter = 0;
  const next = () => (counter++).toString(36).padStart(4, "0");
  const step = spec.step ?? 60;
  const messages: Record<string, OpenRouterMessage> = {};
  const items: Record<string, OpenRouterItem> = {};
  const characters: OpenRouterRoom["characters"] = {};
  for (const [id, model] of Object.entries(spec.characters ?? {})) {
    characters[id] = { id, model, name: null, samplingParameters: { temperature: 0.7 } };
  }

  spec.turns.forEach((turn, turnIndex) => {
    const at = spec.start + turnIndex * step * 10;
    const userId = `msg-${at}-${next()}`;
    const userItemId = `item-${at}-${next()}`;
    items[userItemId] = {
      id: userItemId,
      messageId: userId,
      data: { type: "message", role: "user", content: [{ type: "input_text", text: turn.user }] },
    };
    messages[userId] = {
      id: userId,
      type: "user",
      context: "main-chat",
      contentType: "text",
      characterId: "user-char",
      createdAt: iso(at),
      updatedAt: iso(at),
      items: [{ id: userItemId, type: "message" }],
      attachments: [],
    };

    turn.replies.forEach((reply, replyIndex) => {
      const created = at + step * (replyIndex + 1);
      const id = `msg-${created}-${next()}`;
      const refs: OpenRouterMessage["items"] = [];
      const addItem = (itemId: string, data: OpenRouterItem["data"], type: string) => {
        items[itemId] = { id: itemId, messageId: id, data };
        refs.push({ id: itemId, type });
      };
      if (reply.reasoning) {
        addItem(
          `rs_tmp_${next()}`,
          {
            type: "reasoning",
            status: "completed",
            summary: [],
            content: [{ type: "reasoning_text", text: reply.reasoning }],
          },
          "reasoning",
        );
      }
      addItem(
        `msg_tmp_${next()}`,
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply.text, annotations: [] }],
        },
        "message",
      );
      if (reply.encrypted) {
        addItem(
          `rs_tmp_${next()}`,
          { type: "reasoning", status: "completed", summary: [], encrypted_content: "AAAA" },
          "reasoning",
        );
      }
      messages[id] = {
        id,
        parentMessageId: userId,
        type: "assistant",
        context: "main-chat",
        contentType: "text",
        characterId: reply.character,
        createdAt: iso(created),
        updatedAt: iso(created + 5),
        isGenerating: false,
        items: refs,
        metadata: {
          variantSlug: spec.characters?.[reply.character],
          tokensCount: 120,
          cost: "0.0125",
          ...reply.metadata,
        },
        ...(reply.citations ? { citations: reply.citations } : {}),
      };
    });
  });

  return {
    title: spec.title,
    characters,
    messages,
    items,
    artifacts: {},
    artifactFiles: {},
    artifactVersions: {},
    artifactFileContents: {},
  };
}

export function makeExport(rooms: OpenRouterRoom[]): OpenRouterRawExtraction {
  return { version: "orpg.3.0", rooms };
}

/** The id of the first message of a room (its first user message). */
export function firstMessageId(room: OpenRouterRoom): string {
  return Object.values(room.messages ?? {}).sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  )[0].id;
}
