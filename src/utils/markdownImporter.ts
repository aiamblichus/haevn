// Generic Markdown importer for HAEVN Chat format

import objectHash from "object-hash";
import { parse as parseYaml } from "yaml";
import type {
  Chat,
  ChatMessage,
  ModelRequest,
  ModelResponse,
  SystemPromptPart,
  TextPart,
  UserPromptPart,
} from "../model/haevn_model";
import type { RoughDate } from "../model/roughDate";
import { parseRoughDate } from "../providers/fragment/parser";
import { getAllProviders } from "../providers/provider";
import { log } from "./logger";

async function sha256Hex(text: string): Promise<string> {
  try {
    if (globalThis.crypto && "subtle" in globalThis.crypto) {
      const data = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fall through to objectHash
  }
  return objectHash(text, { algorithm: "sha1" });
}

/**
 * Parses a Markdown file containing a HAEVN chat export.
 *
 * Required format:
 * ---
 * title: Chat title
 * source: provider-name
 * conversation_id: chat-id (optional)
 * date: the date of a chat with no created_at, read as a fragment's date is (optional, HVN-175;
 *   a date it does not read dates the chat at the import)
 * system: system message (optional)
 * models_used: [model1, model2]
 * ---
 * <!-- HAEVN: role="user" -->
 * User message content
 *
 * <!-- HAEVN: role="assistant" -->
 * Assistant response
 */
export async function parseMarkdownFile(file: File): Promise<Chat> {
  const text = await file.text();
  return parseMarkdownContent(text);
}

/** When a file with no created_at is dated by its date: line (HVN-175). */
interface DateLine {
  timestamp: number;
  roughDate?: RoughDate;
}

interface ParsedHeader {
  title: string;
  source: string;
  conversationId?: string;
  system?: string;
  models: string[];
  createdAt?: number;
  /** Set only when the file has no created_at */
  dateLine?: DateLine;
  modifiedAt?: number;
  lastSyncedAt?: number;
}

/**
 * The date: line of a file with no created_at, read by the fragment parser (HVN-175): the same
 * forms, the same made-up times for a rough date, and undated when the line is absent. A date the
 * parser does not read is not a refusal: the importer never read date: before, so the chat is
 * dated at the import, as it was, and a warning says so.
 */
function readDateLine(value: unknown): DateLine | undefined {
  const date = parseRoughDate(value);
  if (date.ok) return { timestamp: date.timestamp, roughDate: date.roughDate };
  log.warn(`date "${String(value)}" is not a date HAEVN reads; the chat is dated at import`);
  return undefined;
}

function parseTimestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }

  return undefined;
}

/**
 * The registered provider id that a front matter `source` names, matched without regard to case,
 * so `Gemini` and `gemini` are one platform (HVN-145). A value no provider is registered under is
 * kept as written. The registry is filled by registerAllProviders(), which every context that
 * imports a Markdown file runs at start-up.
 */
function sourceProviderId(source: string): string {
  const wanted = source.toLowerCase();
  const provider = getAllProviders().find((candidate) => candidate.name.toLowerCase() === wanted);
  return provider ? provider.name : source;
}

function parseYamlFrontmatter(content: string): {
  header: ParsedHeader;
  body: string;
} {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const frontmatterMatch = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);

  if (!frontmatterMatch) {
    throw new Error("Missing YAML frontmatter. Expected file to start with ---");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterMatch[1]);
  } catch (err) {
    throw new Error(
      `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must be a key-value object");
  }

  const record = parsed as Record<string, unknown>;

  const titleValue = record.title;
  if (typeof titleValue !== "string" || !titleValue.trim()) {
    throw new Error("Missing title in YAML frontmatter (expected 'title')");
  }

  const sourceValue = record.source;
  const source =
    typeof sourceValue === "string" && sourceValue.trim()
      ? sourceProviderId(sourceValue.trim())
      : "unknown";

  const conversationValue =
    record.conversation_id ?? record.conversationId ?? record["conversation-id"];
  const conversationId =
    typeof conversationValue === "string" && conversationValue.trim()
      ? conversationValue.trim()
      : undefined;

  if (record.branches === "all") {
    throw new Error(
      "This file was exported with --all-branches, a reading format; re-export without it to import",
    );
  }

  const systemValue = record.system;
  const system = typeof systemValue === "string" && systemValue.trim() ? systemValue : undefined;

  const modelsUsedValue = record.models_used ?? record.models;
  let models: string[] = ["unknown"];
  if (Array.isArray(modelsUsedValue)) {
    const parsedModels = modelsUsedValue
      .filter((m): m is string => typeof m === "string")
      .map((m) => m.trim())
      .filter(Boolean);
    if (parsedModels.length > 0) models = parsedModels;
  } else if (typeof modelsUsedValue === "string") {
    const parsedModels = modelsUsedValue
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (parsedModels.length > 0) models = parsedModels;
  }

  const createdAt = parseTimestampValue(record.created_at ?? record.createdAt ?? record.timestamp);
  const dateLine = createdAt === undefined ? readDateLine(record.date) : undefined;
  const modifiedAt = parseTimestampValue(
    record.modified_at ??
      record.modifiedAt ??
      record.provider_last_modified_timestamp ??
      record.providerLastModifiedTimestamp,
  );
  const lastSyncedAt = parseTimestampValue(
    record.last_synced_timestamp ?? record.lastSyncedTimestamp,
  );

  return {
    header: {
      title: titleValue.trim(),
      source,
      conversationId,
      system,
      models,
      createdAt,
      dateLine,
      modifiedAt,
      lastSyncedAt,
    },
    body: normalized.slice(frontmatterMatch[0].length),
  };
}

export async function parseMarkdownContent(content: string): Promise<Chat> {
  const { header, body } = parseYamlFrontmatter(content);
  const dated = header.dateLine;

  let systemPrompt = header.system;

  // Stable chat ID: prefer explicit conversation ID from frontmatter, fall back to SHA-256 of content
  const chatId = header.conversationId || (await sha256Hex(content));

  const messages: { [key: string]: ChatMessage } = {};
  let messageIndex = 0;

  const rolePattern = /<!--\s*HAEVN:\s*role=["'](\w+)["']\s*-->/gi;
  const roleMatches = Array.from(body.matchAll(rolePattern));

  if (roleMatches.length === 0) {
    throw new Error(
      'No HAEVN role markers found. Expected markers like <!-- HAEVN: role="user" -->',
    );
  }

  for (let i = 0; i < roleMatches.length; i++) {
    const roleMatch = roleMatches[i];
    const role = roleMatch[1].toLowerCase();
    const markerStart = roleMatch.index ?? 0;
    const markerEnd = markerStart + roleMatch[0].length;
    const nextMarkerStart = roleMatches[i + 1]?.index ?? body.length;

    let messageContent = body.slice(markerEnd, nextMarkerStart).trim();
    // Backward-compatibility cleanup: tolerate old section delimiters between messages.
    messageContent = messageContent
      .replace(/^\s*---\s*\n/, "")
      .replace(/\n\s*---\s*$/, "")
      .trim();

    if (!messageContent) {
      continue; // Skip empty messages
    }

    if (role === "system") {
      systemPrompt = messageContent;
      continue;
    }

    // A chat dated by its date: line has made-up times, as a fragment's (HVN-175): turn i is i ms on
    const at = dated ? dated.timestamp + messageIndex : undefined;
    const messageId = `msg_${messageIndex++}`;
    const timestamp = new Date(at ?? Date.now()).toISOString();

    if (role === "user") {
      const userPart: UserPromptPart = {
        part_kind: "user-prompt",
        content: messageContent,
        timestamp,
      };

      const modelRequest: ModelRequest = {
        kind: "request",
        parts: [userPart],
      };

      const chatMessage: ChatMessage = {
        id: messageId,
        parentId: undefined,
        childrenIds: [],
        message: [modelRequest],
        model: header.models[0] || "unknown",
        done: true,
        timestamp: at ?? Date.now(),
        chatId,
      };

      messages[messageId] = chatMessage;
    } else if (role === "assistant") {
      const textPart: TextPart = {
        part_kind: "text",
        content: messageContent,
      };

      const modelResponse: ModelResponse = {
        kind: "response",
        parts: [textPart],
        timestamp,
        model_name: header.models[0] || "unknown",
      };

      const chatMessage: ChatMessage = {
        id: messageId,
        parentId: undefined,
        childrenIds: [],
        message: [modelResponse],
        model: header.models[0] || "unknown",
        done: true,
        timestamp: at ?? Date.now(),
        chatId,
      };

      messages[messageId] = chatMessage;
    } else {
      throw new Error(`Unknown role: ${role}. Expected "user" or "assistant"`);
    }
  }

  if (Object.keys(messages).length === 0) {
    throw new Error("No valid messages found in markdown file");
  }

  // Build message tree (set parent/children relationships)
  const messageIds = Object.keys(messages);
  for (let i = 0; i < messageIds.length; i++) {
    const msgId = messageIds[i];
    const msg = messages[msgId];

    if (i > 0) {
      msg.parentId = messageIds[i - 1];
    }
    if (i < messageIds.length - 1) {
      msg.childrenIds = [messageIds[i + 1]];
    }
  }

  // If system prompt exists and we have messages, add it as SystemPromptPart to first user message
  if (systemPrompt && messageIds.length > 0) {
    const firstUserMsg = messageIds
      .map((id) => messages[id])
      .find((message) => message.message[0]?.kind === "request");

    if (firstUserMsg?.message[0].kind === "request") {
      const request = firstUserMsg.message[0];
      const systemPart: SystemPromptPart = {
        part_kind: "system-prompt",
        content: systemPrompt,
        // A dated chat's times are made up: the prompt is as old as the first turn it sits in
        timestamp: dated ? request.parts[0].timestamp : new Date().toISOString(),
      };
      // Insert system prompt at the beginning
      request.parts.unshift(systemPart);
    }
  }

  const now = Date.now();
  const chat: Chat = {
    id: chatId,
    source: header.source,
    sourceId: chatId,
    title: header.title,
    models: header.models,
    system: systemPrompt,
    params: dated?.roughDate ? { roughDate: dated.roughDate } : {},
    currentId: messageIds[messageIds.length - 1],
    messages,
    tags: [],
    timestamp: header.createdAt ?? dated?.timestamp ?? now,
    lastSyncedTimestamp: header.lastSyncedAt ?? now,
    providerLastModifiedTimestamp: header.modifiedAt,
    checksum: "",
    syncStatus: "new",
    deleted: 0,
  };

  return chat;
}
