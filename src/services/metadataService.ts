import { Type } from "@sinclair/typebox";
import { createPromptWithSchema, parseResponse } from "structalign";
import { log } from "../utils/logger";
import type { ChatMetadataRecord } from "./db";
import { getDB } from "./db";
import * as MetadataRepository from "./metadataRepository";
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
    await generateForChat(item.chatId);
    await getDB().metadataQueue.delete(item.chatId);
    log.info(`[MetadataService] Generated metadata for chat ${item.chatId}`);
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

function buildMetadataSchema(categories: string[]) {
  const categoriesSchema =
    categories.length > 0
      ? Type.Array(Type.Union(categories.map((c) => Type.Literal(c))), {
          description: `Select relevant categories from this list: ${categories.join(", ")}`,
        })
      : Type.Array(Type.String(), { description: "Relevant categories or topics" });

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
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const lines: string[] = [];
  if (chat.title) lines.push(`Title: ${chat.title}`);
  if (chat.source) lines.push(`Platform: ${chat.source}`);
  lines.push("");

  for (const msg of messages.slice(0, 40)) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const content = extractTextContent(msg.content);
    if (content) {
      lines.push(`${role}: ${content.slice(0, 500)}`);
    }
  }

  return lines.join("\n");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return "";
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
