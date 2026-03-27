import { Type } from "@sinclair/typebox";
import { createPromptWithSchema, parseResponse } from "structalign";
import { safeSendMessage } from "../background/utils/messageUtils";
import { log } from "../utils/logger";
import type { ChatMetadataRecord, MetadataQueueRecord, StoredChatMessage } from "./db";
import { getDB } from "./db";
import * as MetadataRepository from "./metadataRepository";
import type { CategoryConfig } from "./settingsService";
import { getMetadataAIConfig } from "./settingsService";

export const METADATA_PROCESS_ALARM = "metadataQueueProcessAlarm";
export const METADATA_REFRESH_ALARM = "metadataQueueRefreshAlarm";
const METADATA_QUEUE_PERIOD_MINUTES = 5;
const METADATA_MAX_RETRIES = 3;
const METADATA_MAX_COMPLETION_TOKENS = 2000;
const METADATA_MAX_INPUT_TOKENS = 5000;
const METADATA_EST_CHARS_PER_TOKEN = 4;
const METADATA_MAX_PROMPT_CHARS = METADATA_MAX_INPUT_TOKENS * METADATA_EST_CHARS_PER_TOKEN;
const METADATA_PROMPT_OVERHEAD_CHARS = 4500;
const METADATA_MIN_CONVERSATION_CHARS = 3000;
const METADATA_MAX_CONVERSATION_CHARS = Math.max(
  METADATA_MIN_CONVERSATION_CHARS,
  METADATA_MAX_PROMPT_CHARS - METADATA_PROMPT_OVERHEAD_CHARS,
);

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

function hasMeaningfulMetadata(metadata: ChatMetadataRecord | null | undefined): boolean {
  return !!metadata && metadata.source !== "unset";
}

async function scheduleProcessTick(): Promise<void> {
  chrome.alarms.create(METADATA_PROCESS_ALARM, { delayInMinutes: 0.1 });
}

export async function syncMetadataQueueAlarms(): Promise<void> {
  const config = await getMetadataAIConfig();
  const shouldRun = config.enabled;

  if (!shouldRun) {
    await Promise.all([
      chrome.alarms.clear(METADATA_PROCESS_ALARM),
      chrome.alarms.clear(METADATA_REFRESH_ALARM),
    ]);
    return;
  }

  if (config.indexMissing) {
    chrome.alarms.create(METADATA_REFRESH_ALARM, {
      delayInMinutes: 0.1,
      periodInMinutes: METADATA_QUEUE_PERIOD_MINUTES,
    });
  } else {
    await chrome.alarms.clear(METADATA_REFRESH_ALARM);
  }

  const pendingCount = await getDB().metadataQueue.where("status").equals("pending").count();
  if (pendingCount > 0) {
    await scheduleProcessTick();
  }
}

/**
 * Enqueue a chat for AI metadata generation.
 * Idempotent — re-queuing a chatId resets it to pending.
 */
export async function queueGeneration(chatId: string): Promise<void> {
  const existing = await MetadataRepository.get(chatId);
  if (hasMeaningfulMetadata(existing)) {
    await dequeueGeneration(chatId);
    return;
  }

  const db = getDB();
  const existingQueueItem = await db.metadataQueue.get(chatId);
  if (existingQueueItem?.status === "failed") {
    // Terminal failure: requires explicit user reset.
    return;
  }

  await db.metadataQueue.put({
    chatId,
    status: "pending",
    retries: 0,
    addedAt: Date.now(),
    error: undefined,
  });
  await scheduleProcessTick();
}

export async function dequeueGeneration(chatId: string): Promise<void> {
  await getDB().metadataQueue.delete(chatId);
}

/**
 * Process one pending queue item. Called by the alarm listener.
 * Reschedules the alarm if more items remain.
 */
export async function processQueueTick(): Promise<void> {
  const db = getDB();
  const config = await getMetadataAIConfig();

  if (!config.enabled) {
    await syncMetadataQueueAlarms();
    return;
  }

  const item = (await db.metadataQueue.where("status").equals("pending").sortBy("addedAt"))[0];

  if (!item) {
    await chrome.alarms.clear(METADATA_PROCESS_ALARM);
    return;
  }

  const metadata = await MetadataRepository.get(item.chatId);
  if (hasMeaningfulMetadata(metadata)) {
    await dequeueGeneration(item.chatId);
    const remaining = await db.metadataQueue.where("status").equals("pending").count();
    if (remaining > 0) {
      await scheduleProcessTick();
    }
    return;
  }

  await db.metadataQueue.update(item.chatId, {
    status: "processing",
    lastAttemptAt: Date.now(),
  });

  try {
    const record = await generateForChat(item.chatId);
    await dequeueGeneration(item.chatId);
    log.info(`[MetadataService] Generated metadata for chat ${item.chatId}`);
    safeSendMessage({ action: "metadataGenerated", chatId: item.chatId, title: record.title });
  } catch (err) {
    const retries = item.retries + 1;
    const errMsg = err instanceof Error ? err.message : String(err);
    const terminal = retries >= METADATA_MAX_RETRIES;
    log.warn(`[MetadataService] Generation failed for ${item.chatId} (attempt ${retries})`, err);

    await getDB().metadataQueue.update(item.chatId, {
      status: terminal ? "failed" : "pending",
      retries,
      error: errMsg,
      lastAttemptAt: Date.now(),
      addedAt: terminal ? item.addedAt : Date.now(),
    });
    safeSendMessage({
      action: "metadataGenerationFailed",
      chatId: item.chatId,
      error: errMsg,
      retries,
      maxRetries: METADATA_MAX_RETRIES,
      terminal,
    });
  }

  const remaining = await db.metadataQueue.where("status").equals("pending").count();
  if (remaining > 0) {
    await scheduleProcessTick();
  } else {
    await chrome.alarms.clear(METADATA_PROCESS_ALARM);
  }
}

export async function refreshQueueTick(): Promise<void> {
  const config = await getMetadataAIConfig();
  if (!config.enabled || !config.indexMissing) {
    return;
  }
  const added = await enqueueAllMissing();
  if (added > 0) {
    await scheduleProcessTick();
  }
}

/**
 * Enqueue all chats that have no meaningful metadata (source === "unset" or no record)
 * and are not already in flight.
 * Returns the total number of items added.
 */
export async function enqueueAllMissing(): Promise<number> {
  const db = getDB();

  // All non-deleted chat IDs
  const allChatIds = (await db.chats.where("deleted").equals(0).primaryKeys()) as string[];

  // Chat IDs that already have real metadata (source !== "unset")
  const allMetadata = await db.chatMetadata.toArray();
  const indexedSet = new Set(
    allMetadata.filter((m) => hasMeaningfulMetadata(m)).map((m) => m.chatId),
  );

  const queueItems = await db.metadataQueue.toArray();
  const staleQueuedIds = queueItems
    .filter((item) => indexedSet.has(item.chatId))
    .map((item) => item.chatId);
  if (staleQueuedIds.length > 0) {
    await db.metadataQueue.bulkDelete(staleQueuedIds);
  }

  const queuedIds = new Set(
    queueItems.filter((item) => !indexedSet.has(item.chatId)).map((item) => item.chatId),
  );

  const toAdd = allChatIds.filter((id) => !indexedSet.has(id) && !queuedIds.has(id));

  const total = toAdd.length;
  if (total === 0) return 0;

  const now = Date.now();
  await db.metadataQueue.bulkPut(
    toAdd.map((chatId) => ({ chatId, status: "pending" as const, retries: 0, addedAt: now })),
  );
  log.info(`[MetadataService] Enqueued ${toAdd.length} missing chats`);
  return total;
}

export interface MetadataQueueStatus {
  pending: number;
  processing: number;
  failed: number;
}

export async function getQueueItem(chatId: string): Promise<MetadataQueueRecord | undefined> {
  return getDB().metadataQueue.get(chatId);
}

/**
 * Reset a terminally failed queue item so it can be processed again.
 */
export async function resetFailedQueueItem(chatId: string): Promise<void> {
  const existing = await getDB().metadataQueue.get(chatId);
  if (!existing || existing.status !== "failed") return;

  await getDB().metadataQueue.update(chatId, {
    status: "pending",
    retries: 0,
    error: undefined,
    addedAt: Date.now(),
    lastAttemptAt: Date.now(),
  });
  await scheduleProcessTick();
}

/**
 * Returns current queue counts.
 */
export async function getQueueStatus(): Promise<MetadataQueueStatus> {
  const db = getDB();

  const [pending, processing, failed] = await Promise.all([
    db.metadataQueue.where("status").equals("pending").count(),
    db.metadataQueue.where("status").equals("processing").count(),
    db.metadataQueue.where("status").equals("failed").count(),
  ]);

  return { pending, processing, failed };
}

/**
 * On service worker startup, reset any items stuck in 'processing'
 * back to 'pending' and synchronize alarms.
 */
export async function resetStuckQueueItems(): Promise<void> {
  const db = getDB();
  const processingItems = await db.metadataQueue.where("status").equals("processing").toArray();

  if (processingItems.length > 0) {
    const now = Date.now();
    for (const item of processingItems) {
      await db.metadataQueue.update(item.chatId, {
        status: "pending",
        addedAt: now,
      });
    }
    log.info(
      `[MetadataService] Reset ${processingItems.length} stuck metadata queue items to pending`,
    );
  }

  await syncMetadataQueueAlarms();

  const config = await getMetadataAIConfig();
  if (config.enabled && config.indexMissing) {
    const added = await enqueueAllMissing();
    if (added > 0 || processingItems.length > 0) {
      await scheduleProcessTick();
    }
  } else if (processingItems.length > 0) {
    await scheduleProcessTick();
  }
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

  // Build schema dynamically from current category list
  const schema = buildMetadataSchema(config.categories);

  // Build a compact, budgeted conversation excerpt.
  // We enforce a hard prompt-size budget (~5000 input tokens estimated)
  // by limiting conversation chars and re-fitting once using real prompt overhead.
  let conversationText = buildConversationText(chat, messages, METADATA_MAX_CONVERSATION_CHARS);
  let prompt = createPromptWithSchema(
    `Analyze the following AI conversation and extract structured metadata for it. You will be an excerpt from the chat with several significant messages inside <chat-to-analyze> tags. You should format your analysis using JSON ONLY as described below the chat.\n\n${conversationText}`,
    schema,
  );

  if (prompt.length > METADATA_MAX_PROMPT_CHARS) {
    const overheadChars = Math.max(0, prompt.length - conversationText.length);
    const reducedConversationBudget = Math.max(
      METADATA_MIN_CONVERSATION_CHARS,
      METADATA_MAX_PROMPT_CHARS - overheadChars,
    );
    conversationText = buildConversationText(chat, messages, reducedConversationBudget);
    prompt = createPromptWithSchema(
      `Analyze the following AI conversation and extract structured metadata for it.\n\n${conversationText}`,
      schema,
    );
  }

  if (prompt.length > METADATA_MAX_PROMPT_CHARS) {
    throw new Error(
      `Metadata prompt exceeds max input budget (~${METADATA_MAX_INPUT_TOKENS} tokens est).`,
    );
  }

  const rawResponse = await callLLM(config.url, config.apiKey, config.model, prompt);
  const result = parseResponse(rawResponse, schema);

  if (!result.success) {
    log.warn("[MetadataService] Parse diagnostics", {
      chatId,
      promptChars: prompt.length,
      estimatedPromptTokens: Math.round(prompt.length / METADATA_EST_CHARS_PER_TOKEN),
      responseChars: rawResponse.length,
      responseStartsWithBrace: rawResponse.trimStart().startsWith("{"),
      responsePreviewStart: rawResponse.slice(0, 240),
      responsePreviewEnd: rawResponse.slice(-240),
    });
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

/** Total sampled messages considered before dedupe and final budgeting. */
const SAMPLE_TARGET = 50;
/** Hard per-message cap before global prompt budgeting. */
const METADATA_PER_MESSAGE_CHAR_CAP = 1000;

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

interface ConversationExcerpt {
  id: string;
  label: string | null;
  role: "user" | "assistant";
  text: string;
}

function excerptFingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 240);
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
  maxConversationChars: number,
): string {
  const maxChars = Math.max(METADATA_MIN_CONVERSATION_CHARS, maxConversationChars);
  const lines: string[] = [];

  lines.push("<chat-to-analyse>");
  if (chat.title) lines.push(`<title>${chat.title}</title>`);
  if (chat.source) lines.push(`<platform>${chat.source}</platform>`);

  const excerpts: ConversationExcerpt[] = [];
  for (const section of buildSampledSections(messages)) {
    for (const msg of section.messages) {
      const extracted = getMessageRoleAndText(msg);
      if (!extracted) continue;
      excerpts.push({
        id: msg.id,
        label: section.label,
        role: extracted.role,
        text: extracted.text,
      });
    }
  }

  // Dedupe by message id first, then by text fingerprint to reduce repeated content
  // across branch sampling.
  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const deduped: ConversationExcerpt[] = [];

  for (const ex of excerpts) {
    if (seenIds.has(ex.id)) continue;
    seenIds.add(ex.id);

    const fp = excerptFingerprint(ex.text);
    if (!fp || seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    deduped.push(ex);
  }

  let currentLength = lines.join("\n").length;
  let lastLabel: string | null = null;

  for (const ex of deduped) {
    const remaining = maxChars - currentLength;
    if (remaining <= 32) break;

    if (ex.label && ex.label !== lastLabel) {
      const labelLine = `--- ${ex.label} ---`;
      const withSpacing = `\n${labelLine}\n`;
      if (withSpacing.length < remaining) {
        lines.push("");
        lines.push(labelLine);
        currentLength += withSpacing.length;
      }
      lastLabel = ex.label;
    }

    const role = ex.role === "user" ? "User" : "Assistant";
    const prefix = `${role}: `;
    const lineBudget = Math.min(
      METADATA_PER_MESSAGE_CHAR_CAP,
      Math.max(0, maxChars - currentLength - prefix.length - 1),
    );

    if (lineBudget <= 0) break;

    const text = ex.text.slice(0, lineBudget);
    lines.push(`<message role="${prefix}">${text}</message>`);
    currentLength += prefix.length + text.length + 1;
  }

  lines.push("</chat-to-analyze>");

  return lines.join("\n");
}

async function callLLM(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const endpoint = `${url.replace(/\/$/, "")}/chat/completions`;
  const requestBody = {
    model: model || "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: METADATA_MAX_COMPLETION_TOKENS,
  };
  const requestHeaders = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  log.debug("[MetadataService] LLM request", {
    endpoint,
    headers: {
      ...requestHeaders,
      ...(apiKey ? { Authorization: "Bearer [REDACTED]" } : {}),
    },
    body: requestBody,
    promptChars: prompt.length,
    estimatedPromptTokens: Math.round(prompt.length / METADATA_EST_CHARS_PER_TOKEN),
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(requestBody),
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
