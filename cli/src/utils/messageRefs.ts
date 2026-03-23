import { createHash } from "node:crypto";
import type { Chat } from "../types/chat";

const REF_LENGTH_STEPS = [12, 16, 20, 24, 32, 64];

export interface MessageRefIndex {
  fullToRef: Map<string, string>;
  refToFull: Map<string, string>;
}

function hashRef(chatId: string, messageId: string): string {
  return createHash("sha256").update(`${chatId}:${messageId}`).digest("hex");
}

export function createMessageRef(chatId: string, messageId: string, length = 12): string {
  return hashRef(chatId, messageId).slice(0, length);
}

export function buildMessageRefIndex(chat: Chat): MessageRefIndex {
  const fullToDigest = new Map<string, string>();
  const messageIds = Object.keys(chat.messages || {});
  const chatId = chat.id ?? "";

  for (const messageId of messageIds) {
    fullToDigest.set(messageId, hashRef(chatId, messageId));
  }

  for (const length of REF_LENGTH_STEPS) {
    const candidateMap = new Map<string, string>();
    let collision = false;
    for (const messageId of messageIds) {
      const digest = fullToDigest.get(messageId);
      if (!digest) continue;
      const short = digest.slice(0, length);
      const existing = candidateMap.get(short);
      if (existing && existing !== messageId) {
        collision = true;
        break;
      }
      candidateMap.set(short, messageId);
    }
    if (!collision) {
      return {
        fullToRef: new Map(Array.from(candidateMap.entries()).map(([short, full]) => [full, short])),
        refToFull: candidateMap,
      };
    }
  }

  // The final step is full digest length, so collisions should be impossible.
  return {
    fullToRef: new Map(),
    refToFull: new Map(),
  };
}

export function getMessageRef(index: MessageRefIndex, messageId: string): string {
  return index.fullToRef.get(messageId) ?? messageId;
}

export function resolveMessageRef(
  chat: Chat,
  rawRef: string,
): { messageId?: string; error?: string } {
  if (!rawRef) return { error: "Empty message reference" };
  if (chat.messages[rawRef]) return { messageId: rawRef };
  const normalizedRef = rawRef.toLowerCase();

  const index = buildMessageRefIndex(chat);
  const exact = index.refToFull.get(normalizedRef);
  if (exact) return { messageId: exact };

  const prefixMatches = Array.from(index.refToFull.entries())
    .filter(([short]) => short.startsWith(normalizedRef))
    .map(([, full]) => full);

  if (prefixMatches.length === 1) {
    return { messageId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return { error: `Ambiguous message reference "${rawRef}"` };
  }

  return { error: `Unknown message reference "${rawRef}"` };
}
