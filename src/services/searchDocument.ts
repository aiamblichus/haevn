import type {
  Chat,
  ChatMessage,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";

/**
 * What the index holds of a chat: one row for the title, one for the system prompt, and one for
 * what the user said and one for what the assistant said in each message. A passage that a search
 * shows is one of these rows, so the granularity of the index is the granularity of the results.
 */
export interface IndexedMessage {
  /** The message's id; `system` for the system prompt. */
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  model?: string;
}

export interface IndexedChat {
  id: string;
  title: string;
  source: string;
  timestamp: number;
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

  return {
    id: chat.id,
    title: (chat.title || "").replace(RESERVED, " ").trim(),
    source: chat.source,
    timestamp: chat.timestamp ?? 0,
    messages,
  };
}
