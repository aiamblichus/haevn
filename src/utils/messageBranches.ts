// Branch selection over a HAEVN.Chat message tree (`parentId` / `childrenIds` / `currentId`).
// Pure functions; used by the Markdown exporter to write one chain, or every chain as sections.

import type { Chat, ChatMessage, ModelResponse } from "../model/haevn_model";

/** One chain of messages, root-to-leaf for the main path, fork-to-leaf for an alternative. */
export interface BranchSection {
  chain: string[];
  /** The message this chain forks from; undefined for the main path and for alternative roots. */
  forkId?: string;
  /** Index (in the returned list) of the section that holds `forkId`. */
  forkSection?: number;
}

function messageTime(message: ChatMessage): number {
  if (typeof message.timestamp === "number") return message.timestamp;
  const first = message.message[0];
  const stamp = first && first.kind === "response" ? (first as ModelResponse).timestamp : undefined;
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function childrenOf(chat: Chat, id: string): string[] {
  return (chat.messages[id]?.childrenIds ?? []).filter((childId) => chat.messages[childId]);
}

/** True when the messages carry any parent or child links; a flat bag of messages has no tree. */
export function hasMessageTree(chat: Chat): boolean {
  return Object.values(chat.messages).some(
    (m) => (m.parentId && chat.messages[m.parentId]) || childrenOf(chat, m.id).length > 0,
  );
}

function rootIds(chat: Chat): string[] {
  return Object.values(chat.messages)
    .filter((m) => !m.parentId || !chat.messages[m.parentId])
    .sort((a, b) => messageTime(a) - messageTime(b))
    .map((m) => m.id);
}

/** The most recently created leaf at or under `id`; ties go to the later child. */
function latestLeaf(chat: Chat, id: string, seen: Set<string>): { id: string; time: number } {
  seen.add(id);
  let best: { id: string; time: number } | undefined;
  for (const childId of childrenOf(chat, id)) {
    if (seen.has(childId)) continue;
    const leaf = latestLeaf(chat, childId, seen);
    if (!best || leaf.time >= best.time) best = leaf;
  }
  return best ?? { id, time: messageTime(chat.messages[id]) };
}

/** Root-to-`id` path through `parentId`, guarded against cycles. */
function pathTo(chat: Chat, id: string): string[] {
  const reversed: string[] = [];
  const seen = new Set<string>();
  let current: ChatMessage | undefined = chat.messages[id];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    reversed.push(current.id);
    current = current.parentId ? chat.messages[current.parentId] : undefined;
  }
  return reversed.reverse();
}

/** `id` down to the most recently created leaf below it, following `childrenIds`. */
function pathDown(chat: Chat, id: string): string[] {
  const leaf = latestLeaf(chat, id, new Set()).id;
  const up = pathTo(chat, leaf);
  const start = up.indexOf(id);
  return start === -1 ? [id] : up.slice(start);
}

function mainLeafId(chat: Chat): string | undefined {
  if (chat.currentId && chat.messages[chat.currentId]) return chat.currentId;
  const seen = new Set<string>();
  let best: { id: string; time: number } | undefined;
  for (const rootId of rootIds(chat)) {
    const leaf = latestLeaf(chat, rootId, seen);
    if (!best || leaf.time >= best.time) best = leaf;
  }
  return best?.id;
}

/**
 * The current branch in tree order: root to `currentId`, or, when `currentId` is missing or
 * unknown, root to the most recently created leaf.
 */
export function currentBranchIds(chat: Chat): string[] {
  const leaf = mainLeafId(chat);
  return leaf ? pathTo(chat, leaf) : [];
}

/** How many leaves lie off the current branch, that is, how many alternatives it leaves out. */
export function otherBranchCount(chat: Chat): number {
  const onPath = new Set(currentBranchIds(chat));
  return Object.values(chat.messages).filter(
    (m) => !onPath.has(m.id) && childrenOf(chat, m.id).length === 0,
  ).length;
}

/**
 * Every message, as chains: the main path in full, then each alternative from its fork point
 * (to its most recently created leaf), then the alternatives nested inside it, depth first.
 * Siblings go oldest first. Each message appears in exactly one chain.
 */
export function branchSections(chat: Chat): BranchSection[] {
  const main = currentBranchIds(chat);
  const sections: BranchSection[] = [];
  const placed = new Set<string>();

  const place = (chain: string[], forkId?: string, forkSection?: number): void => {
    const index = sections.length;
    sections.push({ chain, forkId, forkSection });
    for (const id of chain) placed.add(id);
    for (const id of chain) {
      const siblings = childrenOf(chat, id)
        .filter((childId) => !placed.has(childId))
        .sort((a, b) => messageTime(chat.messages[a]) - messageTime(chat.messages[b]));
      for (const childId of siblings) {
        if (placed.has(childId)) continue; // placed by an earlier sibling's descent
        place(
          pathDown(chat, childId).filter((cid) => !placed.has(cid)),
          id,
          index,
        );
      }
    }
  };

  if (main.length === 0) return sections;
  place(main);

  // Other roots (the first message was edited): alternatives that fork from the start.
  for (const rootId of rootIds(chat)) {
    if (placed.has(rootId)) continue;
    place(pathDown(chat, rootId).filter((id) => !placed.has(id)));
  }
  return sections;
}

/** 1-based position of a message in its root-to-message path ("message 4"). */
export function messageNumber(chat: Chat, id: string): number {
  return pathTo(chat, id).length;
}
