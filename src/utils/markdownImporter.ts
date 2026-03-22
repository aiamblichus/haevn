// Generic Markdown importer for HAEVN Chat format

import type {
  Chat,
  ChatMessage,
  ModelRequest,
  ModelResponse,
  SystemPromptPart,
  TextPart,
  UserPromptPart,
} from "../model/haevn_model";

/**
 * Parses a Markdown file containing a HAEVN chat export
 * Format:
 * # Title
 * **Source:** provider-name
 * **Conversation ID:** chat-id (optional)
 * **System:** system message (optional)
 * **Models Used:** model1, model2
 * ---
 * <!-- HAEVN: role="user" -->
 * User message content
 *
 * <!-- HAEVN: role="assistant" -->
 * Assistant response
 * ---
 */
export async function parseMarkdownFile(file: File): Promise<Chat> {
  const text = await file.text();
  return parseMarkdownContent(text);
}

export function parseMarkdownContent(content: string): Chat {
  const lines = content.split("\n");

  // Extract metadata from header
  const metadata: { [key: string]: string } = {};
  let title = "";
  let systemPrompt: string | undefined;
  let inHeader = true;

  // Parse header (until first --- separator)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === "---") {
      inHeader = false;
      break;
    }

    if (inHeader) {
      // Title (first # heading)
      if (line.startsWith("# ") && !title) {
        title = line.substring(2).trim();
        continue;
      }

      // Metadata fields (**Key:** value)
      const metadataMatch = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
      if (metadataMatch) {
        const key = metadataMatch[1].trim().toLowerCase();
        const value = metadataMatch[2].trim();

        if (key === "system") {
          systemPrompt = value;
        } else {
          metadata[key] = value;
        }
      }
    }
  }

  if (!title) {
    throw new Error("Missing title in markdown header (expected # Title)");
  }

  if (!metadata.source) {
    throw new Error("Missing required metadata: **Source:** provider-name");
  }

  // Parse messages from content after header
  const messageSections = content
    .substring(content.indexOf("---", content.indexOf("---") + 1) + 3)
    .split(/^---$/gm);

  const messages: { [key: string]: ChatMessage } = {};
  let messageIndex = 0;
  const models = metadata["models used"]
    ? metadata["models used"].split(",").map((m) => m.trim())
    : ["unknown"];

  for (const section of messageSections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract role from HTML comment
    const roleMatch = trimmed.match(/<!--\s*HAEVN:\s*role=["'](\w+)["']\s*-->/i);
    if (!roleMatch) {
      throw new Error(
        `Missing role separator in message section. Expected: <!-- HAEVN: role="user" --> or <!-- HAEVN: role="assistant" -->\n` +
          `Section content: ${trimmed.substring(0, 100)}...`,
      );
    }

    const role = roleMatch[1].toLowerCase();
    const messageContent = trimmed.substring(roleMatch[0].length).trim();

    if (!messageContent) {
      continue; // Skip empty messages
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
        parentId: messageIndex > 1 ? `msg_${messageIndex - 2}` : undefined,
        childrenIds: [],
        message: [modelRequest],
        model: models[0] || "unknown",
        done: true,
        timestamp: Date.now(),
        chatId: metadata["conversation id"] || `imported_${Date.now()}`,
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
        model_name: models[0] || "unknown",
      };

      const chatMessage: ChatMessage = {
        id: messageId,
        parentId: messageIndex > 1 ? `msg_${messageIndex - 2}` : undefined,
        childrenIds: [],
        message: [modelResponse],
        model: models[0] || "unknown",
        done: true,
        timestamp: Date.now(),
        chatId: metadata["conversation id"] || `imported_${Date.now()}`,
      };

      messages[messageId] = chatMessage;
    } else if (role === "system") {
      // System message - add as SystemPromptPart to first user message or create special handling
      // For now, we'll store it in Chat.system and also add as a SystemPromptPart to the first message
      systemPrompt = messageContent;
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

  // Create chat ID if not provided
  const chatId = metadata["conversation id"] || `imported_${Date.now()}`;

  // If system prompt exists and we have messages, add it as SystemPromptPart to first user message
  if (systemPrompt && messageIds.length > 0) {
    const firstMsg = messages[messageIds[0]];
    if (firstMsg.message[0].kind === "request") {
      const request = firstMsg.message[0];
      const systemPart: SystemPromptPart = {
        part_kind: "system-prompt",
        content: systemPrompt,
        timestamp: new Date().toISOString(),
      };
      // Insert system prompt at the beginning
      request.parts.unshift(systemPart);
    }
  }

  const chat: Chat = {
    id: chatId,
    source: metadata.source,
    sourceId: chatId,
    title,
    models,
    system: systemPrompt,
    params: {},
    currentId: messageIds[messageIds.length - 1],
    messages,
    tags: [],
    timestamp: Date.now(),
    lastSyncedTimestamp: Date.now(),
    checksum: "",
    syncStatus: "new",
  };

  return chat;
}
