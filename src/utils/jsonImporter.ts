// Generic JSON importer for HAEVN Chat format

import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../model/haevn_model";

/**
 * Validates that a JSON object matches the HAEVN Chat structure
 */
export function validateAndNormalizeChat(json: unknown): Chat {
  if (!json || typeof json !== "object") {
    throw new Error("Chat must be an object");
  }

  const chatJson = json as Record<string, unknown>;

  // Required fields
  if (!chatJson.source || typeof chatJson.source !== "string") {
    throw new Error("Missing or invalid required field: source");
  }
  if (!chatJson.sourceId || typeof chatJson.sourceId !== "string") {
    throw new Error("Missing or invalid required field: sourceId");
  }
  if (!chatJson.title || typeof chatJson.title !== "string") {
    throw new Error("Missing or invalid required field: title");
  }
  if (!Array.isArray(chatJson.models)) {
    throw new Error("Missing or invalid required field: models (must be array)");
  }
  if (!chatJson.messages || typeof chatJson.messages !== "object") {
    throw new Error("Missing or invalid required field: messages (must be object)");
  }
  if (!chatJson.currentId || typeof chatJson.currentId !== "string") {
    throw new Error("Missing or invalid required field: currentId");
  }
  if (typeof chatJson.timestamp !== "number") {
    throw new Error("Missing or invalid required field: timestamp (must be number)");
  }

  // Validate messages structure
  const messages: { [key: string]: ChatMessage } = {};
  for (const [msgId, msg] of Object.entries(chatJson.messages)) {
    if (!msg || typeof msg !== "object") {
      throw new Error(`Invalid message at key ${msgId}: must be an object`);
    }
    const chatMsg = msg as Record<string, unknown>;

    if (!chatMsg.id || typeof chatMsg.id !== "string") {
      throw new Error(`Message ${msgId}: missing or invalid id`);
    }
    if (!Array.isArray(chatMsg.message)) {
      throw new Error(`Message ${msgId}: missing or invalid message array`);
    }
    if (chatMsg.message.length === 0) {
      throw new Error(`Message ${msgId}: message array cannot be empty`);
    }
    if (!chatMsg.model || typeof chatMsg.model !== "string") {
      throw new Error(`Message ${msgId}: missing or invalid model`);
    }
    if (typeof chatMsg.done !== "boolean") {
      throw new Error(`Message ${msgId}: missing or invalid done flag`);
    }
    if (!Array.isArray(chatMsg.childrenIds)) {
      throw new Error(`Message ${msgId}: missing or invalid childrenIds (must be array)`);
    }
    // Validate parentId if present (it's optional)
    if (
      chatMsg.parentId !== undefined &&
      chatMsg.parentId !== null &&
      typeof chatMsg.parentId !== "string"
    ) {
      throw new Error(`Message ${msgId}: invalid parentId (must be string, undefined, or null)`);
    }

    // Validate message parts
    const modelMsg = chatMsg.message[0];
    if (modelMsg.kind === "request") {
      const req = modelMsg as ModelRequest;
      if (!Array.isArray(req.parts)) {
        throw new Error(`Message ${msgId}: request parts must be an array`);
      }
      // Validate system prompt parts if present
      for (const part of req.parts) {
        if (part.part_kind === "system-prompt") {
          if (typeof part.content !== "string") {
            throw new Error(`Message ${msgId}: system-prompt content must be a string`);
          }
          if (!part.timestamp || typeof part.timestamp !== "string") {
            throw new Error(`Message ${msgId}: system-prompt must have timestamp`);
          }
        }
      }
    } else if (modelMsg.kind === "response") {
      const resp = modelMsg as ModelResponse;
      if (!Array.isArray(resp.parts)) {
        throw new Error(`Message ${msgId}: response parts must be an array`);
      }
      if (!resp.timestamp || typeof resp.timestamp !== "string") {
        throw new Error(`Message ${msgId}: response must have timestamp`);
      }
    } else {
      throw new Error(`Message ${msgId}: invalid message kind: ${modelMsg.kind}`);
    }

    messages[msgId] = chatMsg as unknown as ChatMessage;
  }

  // Rebuild parent-child relationships to ensure consistency
  // This is critical for maintaining message tree structure, especially for branched conversations
  Object.values(messages).forEach((msg) => {
    // Clear existing childrenIds - we'll rebuild them from parentId relationships
    msg.childrenIds = [];
  });

  // Build childrenIds arrays from parentId relationships
  Object.values(messages).forEach((msg) => {
    if (msg.parentId && messages[msg.parentId]) {
      // Only add to parent's childrenIds if not already present
      if (!messages[msg.parentId].childrenIds.includes(msg.id)) {
        messages[msg.parentId].childrenIds.push(msg.id);
      }
    }
  });

  // Build normalized chat object
  const chat: Chat = {
    source: chatJson.source as string,
    sourceId: chatJson.sourceId as string,
    title: chatJson.title as string,
    models: chatJson.models as string[],
    system: chatJson.system as string | undefined, // Optional system prompt (string)
    params: (chatJson.params as Record<string, unknown>) || {},
    currentId: chatJson.currentId as string,
    messages,
    tags: Array.isArray(chatJson.tags) ? (chatJson.tags as string[]) : [],
    timestamp: chatJson.timestamp as number,
    files: chatJson.files as Record<string, unknown>[] | undefined,
    lastSyncedTimestamp: (chatJson.lastSyncedTimestamp as number) || Date.now(),
    providerLastModifiedTimestamp: chatJson.providerLastModifiedTimestamp as number | undefined,
    checksum: (chatJson.checksum as string) || "",
    syncStatus: (chatJson.syncStatus as Chat["syncStatus"]) || "new",
    lastSyncAttemptMessage: chatJson.lastSyncAttemptMessage as string | undefined,
  };

  // Generate ID if missing
  if (!chat.id) {
    // Use sourceId as fallback, or generate from timestamp
    chat.id = chat.sourceId || `imported_${chat.timestamp}`;
  }

  return chat;
}
