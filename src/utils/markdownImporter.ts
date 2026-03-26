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

interface ParsedHeader {
  title: string;
  source: string;
  conversationId?: string;
  system?: string;
  models: string[];
  createdAt?: number;
  modifiedAt?: number;
  lastSyncedAt?: number;
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
    typeof sourceValue === "string" && sourceValue.trim() ? sourceValue.trim() : "unknown";

  const conversationValue =
    record.conversation_id ?? record.conversationId ?? record["conversation-id"];
  const conversationId =
    typeof conversationValue === "string" && conversationValue.trim()
      ? conversationValue.trim()
      : undefined;

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
      modifiedAt,
      lastSyncedAt,
    },
    body: normalized.slice(frontmatterMatch[0].length),
  };
}

export async function parseMarkdownContent(content: string): Promise<Chat> {
  const { header, body } = parseYamlFrontmatter(content);

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

    const messageId = `msg_${messageIndex++}`;
    const timestamp = new Date().toISOString();

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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: new Date().toISOString(),
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
    params: {},
    currentId: messageIds[messageIds.length - 1],
    messages,
    tags: [],
    timestamp: header.createdAt ?? now,
    lastSyncedTimestamp: header.lastSyncedAt ?? now,
    providerLastModifiedTimestamp: header.modifiedAt,
    checksum: "",
    syncStatus: "new",
    deleted: 0,
  };

  return chat;
}
