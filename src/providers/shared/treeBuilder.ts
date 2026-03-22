// src/providers/shared/treeBuilder.ts

import type { ChatMessage } from "../../model/haevn_model";

/**
 * Generic tree node interface that can be converted to a HAEVN ChatMessage.
 * @template T The type of data attached to each node (platform-specific)
 */
export interface TreeNode<T = unknown> {
  id: string;
  parentId?: string;
  data: T;
}

/**
 * Builds a message tree from a flat list of nodes.
 *
 * This function performs three key operations:
 * 1. Converts nodes to messages and identifies root nodes (no parent)
 * 2. Links children to their parents (populates childrenIds)
 * 3. Normalizes orphaned nodes (parent doesn't exist → becomes root)
 *
 * @template T The type of data attached to each node
 * @param nodes Array of tree nodes with id and parentId
 * @param nodeToMessage Function to convert a node to a HAEVN ChatMessage
 * @returns Object containing the messages map and root message IDs
 *
 * @example
 * ```typescript
 * const { messages, rootIds } = buildMessageTree(
 *   Object.values(nodes),
 *   (node) => ({
 *     id: node.id,
 *     parentId: node.parent,
 *     childrenIds: [],
 *     message: convertPlatformMessage(node.data),
 *     model: "claude",
 *     done: true,
 *     timestamp: node.timestamp,
 *     chatId: conversationId
 *   })
 * );
 * ```
 */
export function buildMessageTree<T>(
  nodes: TreeNode<T>[],
  nodeToMessage: (node: TreeNode<T>) => ChatMessage,
): { messages: Record<string, ChatMessage>; rootIds: string[] } {
  const messages: Record<string, ChatMessage> = {};
  const rootIds: string[] = [];

  // Step 1: Build messages and identify roots
  for (const node of nodes) {
    const message = nodeToMessage(node);
    messages[message.id] = message;
    if (!message.parentId) {
      rootIds.push(message.id);
    }
  }

  // Step 2: Link children to parents
  for (const node of nodes) {
    const message = messages[node.id];
    if (message.parentId && messages[message.parentId]) {
      messages[message.parentId].childrenIds.push(message.id);
    }
  }

  // Step 3: Normalize orphaned nodes (parent doesn't exist)
  for (const msg of Object.values(messages)) {
    if (msg.parentId && !messages[msg.parentId]) {
      msg.parentId = undefined;
      if (!rootIds.includes(msg.id)) {
        rootIds.push(msg.id);
      }
    }
  }

  return { messages, rootIds };
}
