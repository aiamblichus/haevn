import type {
  Chat,
  ChatMessage,
  SearchResult,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";
import type { ParsedQuery } from "./searchQuery";
import { buildSnippet, type TextRange } from "./searchSnippet";

function messageMatches(text: string, parsed: ParsedQuery): boolean {
  const hay = text.toLowerCase();
  for (const p of parsed.phrases) {
    if (!hay.includes(p)) return false;
  }
  for (const t of parsed.terms) {
    if (!hay.includes(t)) return false;
  }
  return parsed.phrases.length > 0 || parsed.terms.length > 0;
}

type MatchCandidate = {
  chatMessage: ChatMessage;
  role: "user" | "assistant";
  text: string;
  timestampMs?: number;
};

function flattenChatMessageText(cm: ChatMessage): {
  userText: string;
  assistantText: string;
  userFirstTimestamp?: number;
  assistantFirstTimestamp?: number;
} {
  const userTextParts: string[] = [];
  const assistantTextParts: string[] = [];
  let userFirstTimestamp: number | undefined;
  let assistantFirstTimestamp: number | undefined;

  const arr = cm?.message || [];
  for (const mm of arr) {
    if (mm.kind === "request") {
      const req = mm;
      for (const part of req.parts) {
        const partAny = part as { part_kind?: string };
        if (partAny.part_kind === "user-prompt") {
          const up = part as UserPromptPart;
          if (typeof up.content === "string") userTextParts.push(up.content);
          else if (Array.isArray(up.content)) {
            for (const c of up.content) if (typeof c === "string") userTextParts.push(c);
          }
          if (!userFirstTimestamp) {
            try {
              userFirstTimestamp = up.timestamp ? new Date(up.timestamp).getTime() : undefined;
            } catch {
              // ignore
            }
          }
        } else if (partAny.part_kind === "system-prompt") {
          const sp = part as SystemPromptPart;
          if (typeof sp.content === "string") {
            userTextParts.push(sp.content);
          }
        }
      }
    } else if (mm.kind === "response") {
      const res = mm;
      if (!assistantFirstTimestamp) {
        try {
          assistantFirstTimestamp = res.timestamp ? new Date(res.timestamp).getTime() : undefined;
        } catch {
          // ignore
        }
      }
      for (const part of res.parts) {
        const partAny = part as { part_kind?: string };
        const pk = partAny.part_kind;
        if (pk === "text") assistantTextParts.push((part as TextPart).content);
        else if (pk === "thinking") assistantTextParts.push((part as ThinkingPart).content);
      }
    }
  }

  return {
    userText: userTextParts.join(" ").trim(),
    assistantText: assistantTextParts.join(" ").trim(),
    userFirstTimestamp,
    assistantFirstTimestamp,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every case-insensitive occurrence of each needle in the text, as the text spells it. */
function occurrences(text: string, needles: string[]): TextRange[] {
  const found: TextRange[] = [];
  for (const needle of needles) {
    if (!needle) continue;
    const re = new RegExp(escapeRegExp(needle), "gi");
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      found.push({ start: m.index, length: m[0].length });
    }
  }
  return found;
}

function findAllMatchingMessages(chat: Chat, parsed: ParsedQuery): MatchCandidate[] {
  const messages = Object.values(chat.messages || {});
  const out: MatchCandidate[] = [];

  for (const cm of messages) {
    const { userText, userFirstTimestamp, assistantText, assistantFirstTimestamp } =
      flattenChatMessageText(cm);

    if (userText && messageMatches(userText, parsed)) {
      out.push({
        chatMessage: cm,
        role: "user",
        text: userText,
        timestampMs: cm.timestamp || userFirstTimestamp,
      });
    }

    if (assistantText && messageMatches(assistantText, parsed)) {
      out.push({
        chatMessage: cm,
        role: "assistant",
        text: assistantText,
        timestampMs: cm.timestamp || assistantFirstTimestamp,
      });
    }
  }

  return out;
}

export function buildSearchResultsForChat(
  chat: Chat,
  parsed: ParsedQuery,
  options: { radius?: number } = {},
): SearchResult[] {
  const radius = options.radius ?? 90;
  const matches = findAllMatchingMessages(chat, parsed);
  if (matches.length === 0 || !chat.id) return [];

  matches.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
  // The windows are centred on the phrases and terms as the query wrote them; every word of a
  // phrase is marked wherever it falls inside a window.
  const anchorNeedles = [...parsed.phrases, ...parsed.terms];
  const highlightTerms = [...parsed.phrases.flatMap((p) => p.split(/\s+/)), ...parsed.terms];

  return matches.map((match) => ({
    chatId: chat.id as string,
    chatTitle: chat.title,
    source: chat.source,
    messageId: match.chatMessage.id,
    messageContent: match.text,
    messageSnippet: buildSnippet(match.text, occurrences(match.text, anchorNeedles), {
      radius,
      marks: occurrences(match.text, highlightTerms),
    }),
    messageRole: match.role,
    messageTimestamp: match.timestampMs,
    model: match.chatMessage.model || undefined,
    params: chat.params,
  }));
}
