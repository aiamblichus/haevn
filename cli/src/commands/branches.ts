/**
 * Branches command – visualise the tree structure of a chat.
 */

import { defineCommand } from "citty";
import { toJsonString } from "../formatters/json";
import { daemonRequest } from "../daemon/client.js";
import type { TreeNode } from "../types";
import type { Chat, ChatMessage } from "../types/chat";
import { consola, pc, truncate } from "../utils/output";
import { buildMessageRefIndex, getMessageRef } from "../utils/messageRefs";
import {
  getAllBranches,
  getMessagePreview,
  getMessageRole,
  getMessageText,
  getPrimaryBranch,
} from "../utils/tree";

export default defineCommand({
  meta: {
    name: "branches",
    description: "Show the tree structure of a chat with all branches",
  },
  args: {
    chatId: {
      type: "positional",
      description: "Chat ID to inspect",
      required: true,
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format (tree, json)",
      default: "tree",
    },
    "show-ids": {
      type: "boolean",
      description: "Show raw message IDs in addition to short refs",
      default: false,
    },
  },
  async run({ args }) {
    const { chatId, format, "show-ids": showIds } = args;

    let chat: Chat;
    try {
      chat = await daemonRequest<Chat>({ action: "branches", chatId });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format === "json") {
      consola.log(formatBranchesJson(chat));
    } else {
      consola.log(formatTreeText(chat, showIds));
    }
  },
});

// ─── Tree building ────────────────────────────────────────────────────────────

export function buildTree(chat: Chat): TreeNode {
  const primaryPath = getPrimaryBranch(chat);
  const primarySet = new Set(primaryPath);

  function buildNode(messageId: string): TreeNode {
    const msg = chat.messages[messageId] as ChatMessage | undefined;
    if (!msg) throw new Error(`Message not found: ${messageId}`);

    return {
      messageId,
      role: getMessageRole(msg),
      preview: getMessagePreview(msg, 40),
      isLeaf: msg.childrenIds.length === 0,
      isOnPrimaryPath: primarySet.has(messageId),
      children: msg.childrenIds.map(buildNode),
    };
  }

  for (const msg of Object.values(chat.messages)) {
    if (!msg.parentId) return buildNode(msg.id);
  }

  throw new Error("No root message found");
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function summarizeNode(chat: Chat, messageId: string): string {
  const msg = chat.messages[messageId];
  if (!msg) return truncate(messageId, 12);
  const role = getMessageRole(msg);
  const roleLabel = role === "system" ? "S" : role === "user" ? "U" : "A";
  return `${roleLabel}:${truncate(getMessagePreview(msg, 22), 22)}`;
}

export function formatTreeText(chat: Chat, showIds = false): string {
  const branches = getAllBranches(chat);
  const primaryBranch = branches.find((b) => b.isPrimary);
  const tree = buildTree(chat);
  const refs = buildMessageRefIndex(chat);

  const lines: string[] = [];
  lines.push(
    pc.bold(
      `${chat.id}  "${truncate(chat.title, 50)}"  ${pc.dim(`${branches.length} branch${branches.length === 1 ? "" : "es"}`)}`,
    ),
  );
  lines.push("");
  lines.push(renderTreeNodeCompressed(tree, "", true, showIds, refs));

  if (primaryBranch) {
    lines.push("");
    const pathPreview = primaryBranch.path
      .slice(-3)
      .map((id) => summarizeNode(chat, id))
      .join(" → ");
    lines.push(`Primary branch: ${pc.dim(pathPreview)}  (${primaryBranch.messageCount} messages)`);
  }

  return lines.join("\n");
}

function formatNodeLine(node: TreeNode, showIds: boolean): string {
  const roleLabel =
    node.role === "system"
      ? pc.yellow("[sys]")
      : node.role === "user"
        ? pc.cyan("[user]")
        : pc.magenta("[asst]");
  const preview = pc.dim(truncate(node.preview, 40));
  const leafId = showIds && node.isLeaf ? ` ${pc.yellow(`→ ${node.messageId}`)}` : "";
  const inlineId = showIds && !node.isLeaf ? ` ${pc.dim(`(${truncate(node.messageId, 12)})`)}` : "";
  const star = node.isOnPrimaryPath ? pc.bold("*") : " ";
  return `${star} ${roleLabel} ${preview}${inlineId}${leafId}`;
}

function renderTreeNodeCompressed(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  showIds: boolean,
  refs: ReturnType<typeof buildMessageRefIndex>,
): string {
  const lines: string[] = [];

  // Collapse linear runs (single-child chains) into one indentation level.
  const chain: TreeNode[] = [node];
  let cursor = node;
  while (cursor.children.length === 1) {
    cursor = cursor.children[0];
    chain.push(cursor);
  }

  for (let i = 0; i < chain.length; i++) {
    const connector = i === 0 ? (isLast ? "└─ " : "├─ ") : "   ";
    const ref = pc.bold(pc.dim(`[${getMessageRef(refs, chain[i].messageId)}]`));
    lines.push(`${prefix}${connector}${ref} ${formatNodeLine(chain[i], showIds)}`);
  }

  if (cursor.children.length > 1) {
    const branchPrefix = prefix + (isLast ? "   " : "│  ");
    lines.push(`${branchPrefix}${pc.dim(`┬ fork (${cursor.children.length} branches)`)}`);

    for (let i = 0; i < cursor.children.length; i++) {
      lines.push(
        renderTreeNodeCompressed(
          cursor.children[i],
          branchPrefix,
          i === cursor.children.length - 1,
          showIds,
          refs,
        ),
      );
    }
  }

  return lines.join("\n");
}

export function formatBranchesJson(chat: Chat): string {
  const branches = getAllBranches(chat);
  const refs = buildMessageRefIndex(chat);

  const tree = (() => {
    const root = buildTree(chat);
    const toNodeJson = (node: TreeNode): unknown => ({
      ref: getMessageRef(refs, node.messageId),
      role: node.role,
      preview: node.preview,
      content: getMessageText(chat.messages[node.messageId] as ChatMessage),
      isLeaf: node.isLeaf,
      isOnPrimaryPath: node.isOnPrimaryPath,
      children: node.children.map(toNodeJson),
    });
    return toNodeJson(root);
  })();

  return toJsonString({
    chatId: chat.id,
    title: chat.title,
    branchCount: branches.length,
    primaryBranch: (() => {
      const leaf = branches.find((b) => b.isPrimary)?.leafMessageId;
      return leaf ? getMessageRef(refs, leaf) : undefined;
    })(),
    branches: branches.map((b) => ({
      leafMessageRef: getMessageRef(refs, b.leafMessageId),
      messageCount: b.messageCount,
      firstPrompt: b.firstPrompt,
      isPrimary: b.isPrimary,
      path: b.path.map((id) => getMessageRef(refs, id)),
    })),
    tree,
  });
}
