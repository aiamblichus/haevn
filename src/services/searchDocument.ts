import type {
  Chat,
  ChatMessage,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";

/**
 * What the index holds of a chat: one row for the title, one for the system prompt, one for what
 * the user said and one for what the assistant said in each message, and one for each model and
 * each tag the chat carries (HVN-164). A passage that a search shows is one of these rows, so the
 * granularity of the index is the granularity of the results.
 */
export interface IndexedMessage {
  /** The message's id; `system` for the system prompt. */
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  model?: string;
}

/** The two kinds of label a chat is found by: `model:` and `tag:` in a query. */
export type LabelKind = "model" | "tag";

/**
 * The `messageId` of a passage that is a label, not a message. A label row is one model or one
 * tag. Like `title` and `system`, these are ids the index makes up; the prefix is there so that a
 * message is not taken for one.
 */
export const LABEL_IDS: Record<LabelKind, string> = {
  model: "haevn:model",
  tag: "haevn:tag",
};

/** The kind of label a passage's `messageId` names, or undefined when it is a message. */
export function labelKindOf(messageId: string): LabelKind | undefined {
  if (messageId === LABEL_IDS.model) return "model";
  if (messageId === LABEL_IDS.tag) return "tag";
  return undefined;
}

/** Most labels of one kind a chat gets a row for; a long agent session can name many models. */
export const MAX_LABELS = 50;

export interface IndexedChat {
  id: string;
  title: string;
  source: string;
  timestamp: number;
  /** The models the chat names, and the model of each of its messages; one row for each. */
  models: string[];
  /** The chat's tags; one row for each. */
  tags: string[];
  messages: IndexedMessage[];
}

/** A character the index uses to mark a hit; text that has one is indexed with a space instead. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const RESERVED = /[\u0001\u0002]/g;

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

function flatten(cm: ChatMessage): {
  user: string;
  assistant: string;
  userTime?: number;
  assistantTime?: number;
} {
  const user: string[] = [];
  const assistant: string[] = [];
  let userTime: number | undefined;
  let assistantTime: number | undefined;

  for (const entry of cm.message || []) {
    if (entry.kind === "request") {
      for (const part of entry.parts || []) {
        if (part.part_kind === "user-prompt") {
          const prompt = part as UserPromptPart;
          if (typeof prompt.content === "string") user.push(prompt.content);
          else if (Array.isArray(prompt.content)) {
            for (const piece of prompt.content) if (typeof piece === "string") user.push(piece);
          }
          userTime ??= parseTime(prompt.timestamp);
        } else if (part.part_kind === "system-prompt") {
          const prompt = part as SystemPromptPart;
          if (typeof prompt.content === "string") user.push(prompt.content);
        }
      }
    } else if (entry.kind === "response") {
      assistantTime ??= parseTime(entry.timestamp);
      for (const part of entry.parts || []) {
        if (part.part_kind === "text" || part.part_kind === "thinking") {
          const content = (part as TextPart | ThinkingPart).content;
          if (typeof content === "string") assistant.push(content);
        }
      }
    }
  }

  return {
    user: user.join(" ").trim(),
    assistant: assistant.join(" ").trim(),
    userTime,
    assistantTime,
  };
}

/**
 * The labels of one kind, as the rows they become: trimmed, each once (case aside), without the
 * characters the index keeps for its marks, and without `skip` (a placeholder that names nothing).
 */
function labelsOf(values: unknown[], skip?: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const label = value.replace(RESERVED, " ").trim();
    const key = label.toLowerCase();
    if (!label || key === skip || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= MAX_LABELS) break;
  }
  return labels;
}

/**
 * The one place that decides what text of a chat is searchable: every site that indexes a chat
 * (a save, a rebuild, a catch-up) goes through here, and the passages a search shows are cut from
 * the text it returns (HVN-76). Nothing is cut off: the text of a long chat is searchable to its
 * end. Null for a chat with no id.
 */
export function extractIndexedChat(chat: Chat): IndexedChat | null {
  if (!chat.id) return null;
  const messages: IndexedMessage[] = [];
  const add = (message: IndexedMessage) => {
    const text = message.text.replace(RESERVED, " ");
    if (text) messages.push({ ...message, text });
  };

  if (chat.system) add({ id: "system", role: "user", text: chat.system.trim() });

  for (const cm of Object.values(chat.messages || {})) {
    const { user, assistant, userTime, assistantTime } = flatten(cm);
    const model = cm.model || undefined;
    add({ id: cm.id, role: "user", text: user, timestamp: cm.timestamp || userTime, model });
    add({
      id: cm.id,
      role: "assistant",
      text: assistant,
      timestamp: cm.timestamp || assistantTime,
      model,
    });
  }

  // The chat's own list first, then any model a message names that the list does not. "unknown"
  // is what the Markdown importer writes when a file names none: it is no model to search for.
  const models = labelsOf(
    [...(chat.models || []), ...Object.values(chat.messages || {}).map((cm) => cm.model)],
    "unknown",
  );

  return {
    id: chat.id,
    title: (chat.title || "").replace(RESERVED, " ").trim(),
    source: chat.source,
    timestamp: chat.timestamp ?? 0,
    models,
    tags: labelsOf(chat.tags || []),
    messages,
  };
}
