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
  /** Messages the links never reach (corrupt data), oldest first; never a real branch. */
  unlinked?: boolean;
}

interface Leaf {
  id: string;
  time: number;
}

interface Frame {
  id: string;
  children: string[];
  next: number;
  best?: Leaf;
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
function latestLeaf(chat: Chat, rootId: string, seen: Set<string>): Leaf {
  // Post-order walk on an explicit stack: a chat can be thousands of messages deep.
  const frame = (id: string): Frame => ({ id, children: childrenOf(chat, id), next: 0 });
  seen.add(rootId);
  const stack: Frame[] = [frame(rootId)];
  for (;;) {
    const top = stack[stack.length - 1];
    if (top.next < top.children.length) {
      const childId = top.children[top.next++];
      if (!seen.has(childId)) {
        seen.add(childId);
        stack.push(frame(childId));
      }
      continue;
    }
    stack.pop();
    const leaf = top.best ?? { id: top.id, time: messageTime(chat.messages[top.id]) };
    const parent = stack[stack.length - 1];
    if (!parent) return leaf;
    if (!parent.best || leaf.time >= parent.best.time) parent.best = leaf;
  }
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
  let best: Leaf | undefined;
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

/** Where the viewer opens: the root of the current branch and, per fork, which child to show. */
export interface OpeningBranch {
  /** The root of the current branch; undefined for a chat with no messages. */
  rootId?: string;
  /** Fork message id to the position of the child the current branch takes, in `childrenIds` order. */
  selections: Map<string, number>;
}

/**
 * The viewer's opening state: the path `currentBranchIds` gives (the one the Markdown export
 * writes), read as a root and one child position per fork. A step the parent does not list as a
 * child (corrupt links) sets no selection, so that fork keeps the viewer's default (the first
 * child). Positions count the children that exist, in `childrenIds` order, as the viewer does.
 */
export function openingBranch(chat: Chat): OpeningBranch {
  const path = currentBranchIds(chat);
  const selections = new Map<string, number>();
  for (let i = 0; i + 1 < path.length; i++) {
    const position = childrenOf(chat, path[i]).indexOf(path[i + 1]);
    if (position > 0) selections.set(path[i], position);
  }
  return { rootId: path[0], selections };
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
 * Siblings go oldest first. Each message appears in exactly one chain: a message the links
 * never reach (a `parentId` its parent does not list, a cycle with no root) goes last, in an
 * `unlinked` section, so nothing is dropped silently.
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

  if (main.length > 0) place(main);

  // Other roots (the first message was edited): alternatives that fork from the start.
  for (const rootId of rootIds(chat)) {
    if (placed.has(rootId)) continue;
    place(pathDown(chat, rootId).filter((id) => !placed.has(id)));
  }

  const unlinked = Object.values(chat.messages)
    .filter((m) => !placed.has(m.id))
    .sort((a, b) => messageTime(a) - messageTime(b))
    .map((m) => m.id);
  if (unlinked.length > 0) sections.push({ chain: unlinked, unlinked: true });
  return sections;
}

/** 1-based position of a message in its root-to-message path ("message 4"). */
export function messageNumber(chat: Chat, id: string): number {
  return pathTo(chat, id).length;
}
