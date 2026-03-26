import { Type } from "@sinclair/typebox";
import { createPromptWithSchema, parseResponse } from "structalign";
import { safeSendMessage } from "../background/utils/messageUtils";
import { log } from "../utils/logger";
import type { ChatMetadataRecord, StoredChatMessage } from "./db";
import { getDB } from "./db";
import * as MetadataRepository from "./metadataRepository";
import type { CategoryConfig } from "./settingsService";
import { getMetadataAIConfig } from "./settingsService";

const METADATA_QUEUE_ALARM = "metadataQueueAlarm";
const MAX_RETRIES = 3;

// ─── Title Resolution ──────────────────────────────────────────────────────────

/**
 * Returns the best display title for a chat:
 *   1. metadata.title (if set)
 *   2. chatTitle (from the platform)
 *   3. "(Untitled)"
 */
export function getDisplayTitle(
  chatTitle: string,
  metadata: ChatMetadataRecord | null | undefined,
): string {
  if (metadata?.title) return metadata.title;
  if (chatTitle) return chatTitle;
  return "(Untitled)";
}

// ─── Queue Management ─────────────────────────────────────────────────────────

/**
 * Enqueue a chat for AI metadata generation.
 * Idempotent — re-queuing a chatId resets it to pending.
 */
export async function queueGeneration(chatId: string): Promise<void> {
  await getDB().metadataQueue.put({
    chatId,
    status: "pending",
    retries: 0,
    addedAt: Date.now(),
  });
  chrome.alarms.create(METADATA_QUEUE_ALARM, { delayInMinutes: 0.1 });
}

/**
 * Process one pending queue item. Called by the alarm listener.
 * Reschedules the alarm if more items remain.
 */
export async function processQueueTick(): Promise<void> {
  const item = await getDB().metadataQueue.where("status").equals("pending").first();

  if (!item) return;

  await getDB().metadataQueue.update(item.chatId, {
    status: "processing",
    lastAttemptAt: Date.now(),
  });

  try {
    const record = await generateForChat(item.chatId);
    await getDB().metadataQueue.delete(item.chatId);
    log.info(`[MetadataService] Generated metadata for chat ${item.chatId}`);
    safeSendMessage({ action: "metadataGenerated", chatId: item.chatId, title: record.title });
  } catch (err) {
    const retries = item.retries + 1;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[MetadataService] Generation failed for ${item.chatId} (attempt ${retries})`, err);

    if (retries >= MAX_RETRIES) {
      await getDB().metadataQueue.update(item.chatId, {
        status: "failed",
        retries,
        error: errMsg,
      });
      safeSendMessage({ action: "metadataGenerationFailed", chatId: item.chatId, error: errMsg });
    } else {
      await getDB().metadataQueue.update(item.chatId, {
        status: "pending",
        retries,
        error: errMsg,
      });
    }
  }

  // Reschedule if more items remain
  const remaining = await getDB().metadataQueue.where("status").equals("pending").count();
  if (remaining > 0) {
    chrome.alarms.create(METADATA_QUEUE_ALARM, { delayInMinutes: 0.1 });
  }
}

/**
 * Enqueue all chats that have no meaningful metadata (source === "unset" or no record)
 * and reset any previously-failed queue items back to "pending".
 * Returns the total number of items added or reset.
 */
export async function enqueueAllMissing(): Promise<number> {
  const db = getDB();

  // All non-deleted chat IDs
  const allChatIds = (await db.chats.where("deleted").equals(0).primaryKeys()) as string[];

  // Chat IDs that already have real metadata (source !== "unset")
  const allMetadata = await db.chatMetadata.toArray();
  const indexedSet = new Set(allMetadata.filter((m) => m.source !== "unset").map((m) => m.chatId));

  // Chat IDs already pending or processing — skip those
  const inFlightIds = (await db.metadataQueue
    .where("status")
    .anyOf(["pending", "processing"])
    .primaryKeys()) as string[];
  const inFlightSet = new Set(inFlightIds);

  const toAdd = allChatIds.filter((id) => !indexedSet.has(id) && !inFlightSet.has(id));

  // Reset failed items back to pending
  const failedIds = (await db.metadataQueue
    .where("status")
    .equals("failed")
    .primaryKeys()) as string[];

  const total = toAdd.length + failedIds.length;
  if (total === 0) return 0;

  const now = Date.now();
  if (toAdd.length > 0) {
    await db.metadataQueue.bulkPut(
      toAdd.map((chatId) => ({ chatId, status: "pending" as const, retries: 0, addedAt: now })),
    );
  }
  if (failedIds.length > 0) {
    await db.metadataQueue.bulkPut(
      failedIds.map((chatId) => ({
        chatId,
        status: "pending" as const,
        retries: 0,
        addedAt: now,
      })),
    );
  }

  chrome.alarms.create(METADATA_QUEUE_ALARM, { delayInMinutes: 0.1 });
  log.info(`[MetadataService] Enqueued ${toAdd.length} missing + reset ${failedIds.length} failed`);
  return total;
}

export interface MetadataQueueStatus {
  pending: number;
  processing: number;
  failed: number;
  /** Chats with no/unset metadata not currently in the queue. */
  missing: number;
}

/**
 * Returns current queue counts plus the number of chats that have no metadata
 * and are not already queued.
 */
export async function getQueueStatus(): Promise<MetadataQueueStatus> {
  const db = getDB();

  const [pending, processing, failed, allChatIds, allMetadata, inFlightIds] = await Promise.all([
    db.metadataQueue.where("status").equals("pending").count(),
    db.metadataQueue.where("status").equals("processing").count(),
    db.metadataQueue.where("status").equals("failed").count(),
    db.chats.where("deleted").equals(0).primaryKeys() as Promise<string[]>,
    db.chatMetadata.toArray(),
    db.metadataQueue.where("status").anyOf(["pending", "processing"]).primaryKeys() as Promise<
      string[]
    >,
  ]);

  const indexedSet = new Set(allMetadata.filter((m) => m.source !== "unset").map((m) => m.chatId));
  const inFlightSet = new Set(inFlightIds);
  const missing = allChatIds.filter((id) => !indexedSet.has(id) && !inFlightSet.has(id)).length;

  return { pending, processing, failed, missing };
}

/**
 * On service worker startup, reset any items stuck in 'processing'
 * back to 'pending' (they were interrupted by SW termination).
 */
export async function resetStuckQueueItems(): Promise<void> {
  const stuck = await getDB().metadataQueue.where("status").equals("processing").toArray();
  if (stuck.length === 0) return;

  for (const item of stuck) {
    await getDB().metadataQueue.update(item.chatId, { status: "pending" });
  }
  log.info(`[MetadataService] Reset ${stuck.length} stuck queue items to pending`);

  chrome.alarms.create(METADATA_QUEUE_ALARM, { delayInMinutes: 0.1 });
}

// ─── AI Generation ────────────────────────────────────────────────────────────

/**
 * Fetch chat content, call the configured LLM, parse the response with structalign,
 * and persist the resulting metadata record.
 */
export async function generateForChat(chatId: string): Promise<ChatMetadataRecord> {
  const config = await getMetadataAIConfig();
  if (!config.enabled) throw new Error("AI metadata generation is not enabled");
  if (!config.url) throw new Error("AI metadata URL is not configured");

  const chat = await getDB().chats.get(chatId);
  if (!chat) throw new Error(`Chat ${chatId} not found`);

  const messages = await getDB().chatMessages.where("chatId").equals(chatId).toArray();

  // Build a compact text representation for the prompt
  const conversationText = buildConversationText(chat, messages);

  // Build schema dynamically from current category list
  const schema = buildMetadataSchema(config.categories);
  const prompt = createPromptWithSchema(
    `Analyze the following AI conversation and extract structured metadata for it.\n\n${conversationText}`,
    schema,
  );

  const rawResponse = await callLLM(config.url, config.apiKey, config.model, prompt);
  const result = parseResponse(rawResponse, schema);

  if (!result.success) {
    throw new Error(
      `Failed to parse LLM response: ${result.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const parsed = result.value as {
    title: string;
    description: string;
    synopsis: string;
    categories: string[];
    keywords: string[];
  };

  const now = Date.now();
  await MetadataRepository.set(chatId, {
    title: parsed.title ?? "",
    description: parsed.description ?? "",
    synopsis: parsed.synopsis ?? "",
    categories: parsed.categories ?? [],
    keywords: parsed.keywords ?? [],
    source: "ai",
    generatedAt: now,
    updatedAt: now,
  });

  const saved = await MetadataRepository.get(chatId);
  if (!saved) throw new Error(`Failed to read back metadata for chat ${chatId}`);
  return saved;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OTHER_CATEGORY = "Other";

// ─── Message Sampling ─────────────────────────────────────────────────────────

/** Total messages to include in the LLM prompt. */
const SAMPLE_TARGET = 50;
/** Max characters per message excerpt (~750 tokens each at average density). */
const CHARS_PER_MSG = 3000;

/**
 * Extract the display role and plain text from a stored ChatMessage.
 * Handles the ModelMessage format (kind: "request" | "response" with parts).
 * Returns null if no text content is found.
 */
function getMessageRoleAndText(
  cm: StoredChatMessage,
): { role: "user" | "assistant"; text: string } | null {
  for (const mm of cm.message ?? []) {
    const parts: string[] = [];

    if (mm.kind === "request") {
      for (const part of mm.parts) {
        const p = part as { part_kind?: string; content?: unknown };
        if (p.part_kind === "user-prompt" || p.part_kind === "system-prompt") {
          if (typeof p.content === "string") {
            parts.push(p.content);
          } else if (Array.isArray(p.content)) {
            for (const c of p.content) {
              if (typeof c === "string") parts.push(c);
            }
          }
        }
      }
      const text = parts.join(" ").trim();
      if (text) return { role: "user", text };
    } else if (mm.kind === "response") {
      for (const part of mm.parts) {
        const p = part as { part_kind?: string; content?: string };
        if ((p.part_kind === "text" || p.part_kind === "thinking") && p.content) {
          parts.push(p.content);
        }
      }
      const text = parts.join(" ").trim();
      if (text) return { role: "assistant", text };
    }
  }
  return null;
}

/**
 * Walk the deepest path from startId, always following the child with the
 * largest subtree at each branching point.
 */
function walkDeepestPath(
  startId: string,
  byId: Map<string, StoredChatMessage>,
  subtreeSize: Map<string, number>,
): StoredChatMessage[] {
  const path: StoredChatMessage[] = [];
  let current = byId.get(startId);
  while (current) {
    path.push(current);
    const children = (current.childrenIds ?? []).filter((cid) => byId.has(cid));
    if (children.length === 0) break;
    const nextId = children.reduce((best, cid) =>
      (subtreeSize.get(cid) ?? 0) > (subtreeSize.get(best) ?? 0) ? cid : best,
    );
    current = byId.get(nextId);
  }
  return path;
}

/** Sample n items evenly distributed from arr. */
function evenSample<T>(arr: T[], n: number): T[] {
  if (n <= 0 || arr.length === 0) return [];
  if (arr.length <= n) return [...arr];
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor((i / n) * arr.length)]);
  }
  return result;
}

interface ConversationSection {
  label: string | null;
  messages: StoredChatMessage[];
}

/**
 * Build sampled conversation sections from a flat message list.
 *
 * For short conversations (≤ SAMPLE_TARGET), returns everything as a single section.
 * For longer ones:
 *   - Builds the message tree from parentId/childrenIds
 *   - Walks the main thread (deepest path — at each fork, follows the child with most descendants)
 *   - Samples beginning (40%), middle (35%), end (25%) of the main thread
 *   - Appends a short sample from any significant alternate branches (≥ 3 messages)
 */
function buildSampledSections(messages: StoredChatMessage[]): ConversationSection[] {
  if (messages.length === 0) return [];

  const byId = new Map<string, StoredChatMessage>();
  for (const m of messages) byId.set(m.id, m);

  if (messages.length <= SAMPLE_TARGET) {
    return [{ label: null, messages }];
  }

  // Compute subtree sizes via memoized recursion
  const subtreeSize = new Map<string, number>();
  function getSize(id: string): number {
    const cached = subtreeSize.get(id);
    if (cached !== undefined) return cached;
    const msg = byId.get(id);
    if (!msg) return 0;
    const size =
      1 +
      (msg.childrenIds ?? [])
        .filter((cid) => byId.has(cid))
        .reduce((s, cid) => s + getSize(cid), 0);
    subtreeSize.set(id, size);
    return size;
  }
  for (const m of messages) getSize(m.id);

  // Identify roots (no parent, or parent not present in this chat)
  const roots = messages.filter((m) => !m.parentId || !byId.has(m.parentId));
  const bestRoot = roots.reduce((best, m) => (getSize(m.id) > getSize(best.id) ? m : best));

  const mainThread = walkDeepestPath(bestRoot.id, byId, subtreeSize);
  const mainSet = new Set(mainThread.map((m) => m.id));

  // Collect significant alternate branches (≥ 3 messages) off the main thread
  const branchMessages: StoredChatMessage[] = [];
  for (const msg of mainThread) {
    const altChildren = (msg.childrenIds ?? []).filter((cid) => byId.has(cid) && !mainSet.has(cid));
    for (const cid of altChildren) {
      if (getSize(cid) >= 3) {
        const branch = walkDeepestPath(cid, byId, subtreeSize);
        branchMessages.push(...branch.slice(0, 4));
      }
    }
  }

  // Budget allocation
  const branchBudget = Math.min(
    branchMessages.length,
    Math.min(9, Math.floor(SAMPLE_TARGET * 0.15)),
  );
  const mainBudget = SAMPLE_TARGET - branchBudget;

  // Divide main budget: beginning 40%, middle 35%, end 25%
  const beginCount = Math.ceil(mainBudget * 0.4);
  const endCount = Math.ceil(mainBudget * 0.25);
  const midCount = mainBudget - beginCount - endCount;

  const begin = mainThread.slice(0, beginCount);
  const end = mainThread.slice(-endCount);
  const midPool = mainThread.slice(beginCount, mainThread.length - endCount);
  const mid = evenSample(midPool, midCount);

  const sections: ConversationSection[] = [
    { label: null, messages: begin },
    { label: "Mid-conversation sample", messages: mid },
    { label: "End of conversation", messages: end },
  ];

  if (branchBudget > 0) {
    sections.push({
      label: "Alternate branch sample",
      messages: branchMessages.slice(0, branchBudget),
    });
  }

  return sections.filter((s) => s.messages.length > 0);
}

function buildMetadataSchema(categories: CategoryConfig[]) {
  // Build the union of all configured category names plus the always-present "Other"
  const allNames = [...categories.map((c) => c.name), OTHER_CATEGORY];

  const categoryListText =
    categories.length > 0
      ? [
          ...categories.map((c) =>
            c.description ? `- ${c.name}: ${c.description}` : `- ${c.name}`,
          ),
          `- ${OTHER_CATEGORY}: Use when the conversation doesn't fit any of the above categories.`,
        ].join("\n")
      : "";

  const categoriesSchema = Type.Array(Type.Union(allNames.map((n) => Type.Literal(n))), {
    description:
      categories.length > 0
        ? `Select the most relevant categories. Use "${OTHER_CATEGORY}" only if none of the defined categories fit.\n\nAvailable categories:\n${categoryListText}`
        : `Select relevant categories, or use "${OTHER_CATEGORY}" if none fit.`,
  });

  return Type.Object({
    title: Type.String({
      description: "A concise, descriptive title for this conversation (max 100 characters)",
    }),
    description: Type.String({
      description: "A 1–2 sentence description of what this conversation is about",
    }),
    synopsis: Type.String({
      description: "A 3–5 sentence summary covering the main topics, questions, and outcomes",
    }),
    categories: categoriesSchema,
    keywords: Type.Array(Type.String(), {
      description: "5–10 relevant keywords or phrases from the conversation",
    }),
  });
}

function buildConversationText(
  chat: { title?: string; source?: string },
  messages: StoredChatMessage[],
): string {
  const lines: string[] = [];
  if (chat.title) lines.push(`Title: ${chat.title}`);
  if (chat.source) lines.push(`Platform: ${chat.source}`);

  for (const section of buildSampledSections(messages)) {
    lines.push("");
    if (section.label) lines.push(`--- ${section.label} ---`);
    for (const msg of section.messages) {
      const extracted = getMessageRoleAndText(msg);
      if (!extracted) continue;
      const role = extracted.role === "user" ? "User" : "Assistant";
      lines.push(`${role}: ${extracted.text.slice(0, CHARS_PER_MSG)}`);
    }
  }

  return lines.join("\n");
}

async function callLLM(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const endpoint = `${url.replace(/\/$/, "")}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("LLM response contained no content");
  return text;
}
