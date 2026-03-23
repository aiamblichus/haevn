/**
 * Branches command – visualise the tree structure of a chat.
 */

import { defineCommand } from "citty";
import { toJsonString } from "../formatters/json";
import { daemonRequest } from "../daemon/client.js";
import type { TreeNode } from "../types";
import type { Chat, ChatMessage } from "../types/chat";
import { consola, pc, truncate } from "../utils/output";
import { getAllBranches, getMessagePreview, getMessageRole, getPrimaryBranch } from "../utils/tree";

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
  },
  async run({ args }) {
    const { chatId, format } = args;

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
      consola.log(formatTreeText(chat));
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

export function formatTreeText(chat: Chat): string {
  const branches = getAllBranches(chat);
  const primaryBranch = branches.find((b) => b.isPrimary);
  const tree = buildTree(chat);

  const lines: string[] = [];
  lines.push(
    pc.bold(
      `${chat.id}  "${truncate(chat.title, 50)}"  ${pc.dim(`${branches.length} branch${branches.length === 1 ? "" : "es"}`)}`,
    ),
  );
  lines.push("");
  lines.push(renderTreeNode(tree, "", true));

  if (primaryBranch) {
    lines.push("");
    const pathPreview = primaryBranch.path.slice(-3).join(" → ");
    lines.push(`Primary branch: ${pc.dim(pathPreview)}  (${primaryBranch.messageCount} messages)`);
  }

  return lines.join("\n");
}

function renderTreeNode(node: TreeNode, prefix: string, isLast: boolean): string {
  const lines: string[] = [];
  const connector = isLast ? "└─ " : "├─ ";
  const roleLabel = node.role === "user" ? pc.cyan("[user]") : pc.magenta("[asst]");
  const preview = pc.dim(truncate(node.preview, 40));
  const leafId = node.isLeaf ? ` ${pc.yellow(`→ ${node.messageId}`)}` : "";
  const star = node.isOnPrimaryPath ? pc.bold("*") : " ";

  lines.push(`${prefix}${connector}${star} ${roleLabel} ${preview}${leafId}`);

  const childPrefix = prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    lines.push(renderTreeNode(node.children[i], childPrefix, i === node.children.length - 1));
  }

  return lines.join("\n");
}

export function formatBranchesJson(chat: Chat): string {
  const branches = getAllBranches(chat);
  return toJsonString({
    chatId: chat.id,
    title: chat.title,
    branchCount: branches.length,
    primaryBranch: branches.find((b) => b.isPrimary)?.leafMessageId,
    branches: branches.map((b) => ({
      leafMessageId: b.leafMessageId,
      messageCount: b.messageCount,
      firstPrompt: b.firstPrompt,
      isPrimary: b.isPrimary,
      path: b.path,
    })),
  });
}
