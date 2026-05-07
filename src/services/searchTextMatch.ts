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
  matchIndex: number;
  matchedLength: number;
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

function locateMatch(text: string, parsed: ParsedQuery): { index: number; length: number } | null {
  if (!text) return null;
  const hay = text.toLowerCase();

  for (const p of parsed.phrases) {
    const idx = hay.indexOf(p);
    if (idx >= 0) return { index: idx, length: p.length };
  }

  let bestIdx = -1;
  let bestLen = 0;
  for (const t of parsed.terms) {
    const i = hay.indexOf(t);
    if (i >= 0 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestLen = t.length;
    }
  }
  return bestIdx >= 0 ? { index: bestIdx, length: bestLen } : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSnippet(
  text: string,
  index: number,
  len: number,
  terms: string[],
  radius = 90,
): string {
  if (!text) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + len + radius);
  let snippet = text.slice(start, end);
  snippet = snippet.replace(/\s+/g, " ").trim();
  if (terms.length > 0) {
    const pattern = terms
      .map((t) => escapeRegExp(t))
      .filter((t) => !!t)
      .join("|");
    if (pattern) {
      const re = new RegExp(`(${pattern})`, "gi");
      snippet = snippet.replace(re, "{{HIGHLIGHT}}$1{{/HIGHLIGHT}}");
    }
  }
  return snippet;
}

function findAllMatchingMessages(chat: Chat, parsed: ParsedQuery): MatchCandidate[] {
  const messages = Object.values(chat.messages || {});
  const out: MatchCandidate[] = [];

  for (const cm of messages) {
    const { userText, userFirstTimestamp, assistantText, assistantFirstTimestamp } =
      flattenChatMessageText(cm);

    if (userText && messageMatches(userText, parsed)) {
      const m = locateMatch(userText, parsed);
      if (m) {
        out.push({
          chatMessage: cm,
          role: "user",
          text: userText,
          matchIndex: m.index,
          matchedLength: m.length,
          timestampMs: cm.timestamp || userFirstTimestamp,
        });
      }
    }

    if (assistantText && messageMatches(assistantText, parsed)) {
      const m = locateMatch(assistantText, parsed);
      if (m) {
        out.push({
          chatMessage: cm,
          role: "assistant",
          text: assistantText,
          matchIndex: m.index,
          matchedLength: m.length,
          timestampMs: cm.timestamp || assistantFirstTimestamp,
        });
      }
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
  const highlightTerms = [...parsed.phrases.flatMap((p) => p.split(/\s+/)), ...parsed.terms];

  return matches.map((match) => ({
    chatId: chat.id as string,
    chatTitle: chat.title,
    source: chat.source,
    messageId: match.chatMessage.id,
    messageContent: match.text,
    messageSnippet: buildSnippet(
      match.text,
      match.matchIndex,
      match.matchedLength,
      highlightTerms,
      radius,
    ),
    messageRole: match.role,
    messageTimestamp: match.timestampMs,
    model: match.chatMessage.model || undefined,
    params: chat.params,
  }));
}
