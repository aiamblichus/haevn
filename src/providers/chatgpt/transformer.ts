import { v4 as uuidv4 } from "uuid";
import type {
  BinaryContent,
  Chat,
  CodeExecutionPart,
  DocumentResponsePart,
  DocumentUrl,
  ImageResponsePart,
  ModelRequest,
  ModelResponse,
  ModelResponsePart,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolReturnPart,
  UserContent,
  UserPromptPart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type {
  ChatGPTAssetsMap,
  ChatGPTRawExtraction,
  OpenAIConversationNode,
  OpenAIMessage,
  OpenAIMessageContent,
  OpenAIModelEditableContextContent,
  OpenAIUserEditableContextContent,
} from "./model";
import { getModelName } from "./model";

function toIso(ts: number | null): string {
  if (!ts) return new Date().toISOString();
  // API returns float seconds; convert to ms
  return new Date(ts * 1000).toISOString();
}

function toMs(ts: number | null): number | undefined {
  if (!ts) return undefined;
  return Math.floor(ts * 1000);
}

function cryptoRandomId(): string {
  try {
    // Browser-safe random UUID
    return uuidv4();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

function _stringifyContentAsText(msg: OpenAIMessage): string {
  const c = msg.content;
  if (!c) return "";

  const contentType = "content_type" in c ? c.content_type : "";

  if (contentType === "user_editable_context") {
    const context = c as OpenAIUserEditableContextContent;
    const parts: string[] = [];
    if (context.user_profile) {
      parts.push(`**User Profile:**\n${context.user_profile}`);
    }
    if (context.user_instructions) {
      parts.push(`**User Instructions:**\n${context.user_instructions}`);
    }
    return parts.join("\n\n");
  }

  if (contentType === "model_editable_context") {
    const context = c as OpenAIModelEditableContextContent;
    return context.model_set_context || "";
  }

  // Check if content has text property (OpenAICodeContent, OpenAIExecutionOutputContent, etc.)
  if ("text" in c && typeof c.text === "string") {
    return c.text;
  }
  // Check if content has parts array (OpenAIMultimodalContent, OpenAITextContent)
  if ("parts" in c && Array.isArray(c.parts)) {
    const strings = c.parts.filter((p): p is string => typeof p === "string");
    if (strings.length) return strings.join("\n");
  }
  try {
    return JSON.stringify(c);
  } catch {
    return "";
  }
}

function messagePartsFromContent(
  content: OpenAIMessageContent,
  assets: ChatGPTAssetsMap,
): {
  userParts?: UserContent | UserContent[];
  responseParts?: ModelResponsePart[];
} {
  // We handle the most common shapes: text and multimodal_text (with image_asset_pointer)
  const parts = "parts" in content && Array.isArray(content.parts) ? content.parts : [];
  const contentType =
    "content_type" in content && typeof content.content_type === "string"
      ? content.content_type
      : "";

  if (contentType === "text") {
    const text = (parts || []).join("\n");
    return {
      userParts: text,
      responseParts: [{ part_kind: "text", content: text } as TextPart],
    };
  }

  if (contentType === "multimodal_text") {
    const userContent: UserContent[] = [];
    const responseParts: ModelResponsePart[] = [];
    const strings: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        strings.push(p);
      } else if (p?.content_type === "image_asset_pointer" && typeof p.asset_pointer === "string") {
        const asset = assets[p.asset_pointer];
        if (asset) {
          const bin: BinaryContent = {
            kind: "binary",
            data: asset.dataBase64,
            media_type: asset.contentType,
            identifier: asset.filename,
          };
          // For user/assistant symmetry, prepare both representations
          userContent.push(bin);
          responseParts.push({
            part_kind: "image-response",
            content: bin,
          } as ImageResponsePart);
        } else {
          // Asset not found - log warning and add a text placeholder
          log.warn(`[Transformer][ChatGPT] Missing asset for pointer: ${p.asset_pointer}`);
          const placeholderText = `[Image not found: ${p.asset_pointer}]`;
          strings.push(placeholderText);
          // Don't add broken image references to userContent/responseParts
        }
      }
    }
    const textJoined = strings.join("\n").trim();
    if (textJoined) {
      responseParts.unshift({
        part_kind: "text",
        content: textJoined,
      } as TextPart);
      if (userContent.length === 0) return { userParts: textJoined, responseParts };
      userContent.unshift(textJoined);
    }
    return {
      userParts:
        userContent.length === 1 && typeof userContent[0] === "string"
          ? userContent[0]
          : userContent,
      responseParts,
    };
  }

  if (contentType === "thoughts") {
    const thoughtsContent = content as { text?: string | null };
    const text = thoughtsContent.text || "";
    return {
      responseParts: [{ part_kind: "thinking", content: text } as ThinkingPart],
    };
  }

  if (contentType === "reasoning_recap") {
    const recapContent = content as { text?: string | null };
    const text = recapContent.text || "";
    return {
      responseParts: [{ part_kind: "thinking", content: text } as ThinkingPart],
    };
  }

  if (contentType === "code") {
    const codeContent = content as { text?: string; language?: string | null };
    const code = codeContent.text || "";
    const language = codeContent.language || undefined;
    const codePart: CodeExecutionPart = {
      part_kind: "code-execution",
      uuid: cryptoRandomId(),
      name: "code",
      code,
      language,
    };
    return { responseParts: [codePart] };
  }

  if (contentType === "execution_output") {
    const execContent = content as { text?: string };
    const output = execContent.text || "";
    const codePart: CodeExecutionPart = {
      part_kind: "code-execution",
      uuid: cryptoRandomId(),
      name: "execution",
      code: "",
      result: { output },
    };
    return { responseParts: [codePart] };
  }

  if (contentType === "tether_quote") {
    const quote = content as {
      url?: string | null;
      title?: string;
      text?: string;
      domain?: string | null;
    };
    const url = quote.url || "";
    const title = quote.title || "";
    const text = quote.text || "";
    const doc: DocumentUrl = {
      kind: "document-url",
      url,
      vendor_metadata: { title, text, domain: quote.domain || undefined },
    };
    const parts: ModelResponsePart[] = [];
    if (text) parts.push({ part_kind: "text", content: `Quote: ${text}` } as TextPart);
    parts.push({
      part_kind: "document-response",
      content: doc,
    } as DocumentResponsePart);
    return { responseParts: parts };
  }

  if (contentType === "tether_Browse_display") {
    const disp = content as { summary?: string | null; result?: string };
    const summary = disp.summary || "";
    const result = disp.result || "";
    const parts: ModelResponsePart[] = [];
    if (summary)
      parts.push({
        part_kind: "text",
        content: `Browse summary: ${summary}`,
      } as TextPart);
    if (result)
      parts.push({
        part_kind: "text",
        content: `Browse result: ${result}`,
      } as TextPart);
    return { responseParts: parts };
  }

  if (contentType === "tether_Browse_code") {
    // Represent as a hint that browse tool was invoked
    return {
      responseParts: [{ part_kind: "text", content: "[Browse tool invoked]" } as TextPart],
    };
  }

  if (contentType === "system_error") {
    const errorContent = content as { text?: string };
    const text = errorContent.text || "";
    return {
      responseParts: [{ part_kind: "text", content: `System error: ${text}` } as TextPart],
    };
  }

  if (contentType === "user_editable_context") {
    const context = content as { user_profile?: string | null; user_instructions?: string | null };
    const parts: string[] = [];
    if (context.user_profile) {
      parts.push(`**User Profile:**\n${context.user_profile}`);
    }
    if (context.user_instructions) {
      parts.push(`**User Instructions:**\n${context.user_instructions}`);
    }
    const text = parts.join("\n\n");
    return {
      userParts: text,
      responseParts: [{ part_kind: "text", content: text } as TextPart],
    };
  }

  if (contentType === "model_editable_context") {
    const context = content as { model_set_context?: string };
    const text = context.model_set_context || "";
    return {
      userParts: text,
      responseParts: [{ part_kind: "text", content: text } as TextPart],
    };
  }

  // Other content types (execution_output, code, tether, etc.) can be represented as text fallbacks
  try {
    const asText = JSON.stringify(content);
    return {
      userParts: asText,
      responseParts: [{ part_kind: "text", content: asText } as TextPart],
    };
  } catch {
    return { userParts: "", responseParts: [] };
  }
}

// Use ChatGPTRawExtraction from model.ts instead of local interface

export function transformOpenAIToHaevn(raw: ChatGPTRawExtraction): Chat {
  const { conversation, assets } = raw;
  const nodes: Record<string, OpenAIConversationNode> = conversation.mapping || {};

  // Convert nodes to TreeNode format, filtering out structural nodes
  const treeNodes: TreeNode<{
    node: OpenAIConversationNode;
    msg: OpenAIMessage;
    conversationId: string;
  }>[] = [];

  for (const node of Object.values(nodes)) {
    const msg = node.message as OpenAIMessage | null;
    if (!msg) continue; // Skip structural nodes

    treeNodes.push({
      id: node.id,
      parentId: node.parent || undefined,
      data: {
        node,
        msg,
        conversationId:
          ("conversation_id" in conversation && typeof conversation.conversation_id === "string"
            ? conversation.conversation_id
            : null) ||
          ("id" in conversation && typeof conversation.id === "string" ? conversation.id : null) ||
          node.id,
      },
    });
  }

  // Use shared tree builder utility
  const { messages, rootIds } = buildMessageTree(treeNodes, (treeNode) => {
    const { msg, conversationId } = treeNode.data;

    const role = msg.author?.role || "assistant";
    const timestampIso = toIso(msg.create_time);
    const timestampMs = toMs(msg.create_time) || Date.now();

    let modelEntry: ModelRequest | ModelResponse;

    const isSystemContext =
      role === "system" ||
      (msg.content &&
        "content_type" in msg.content &&
        (msg.content.content_type === "user_editable_context" ||
          msg.content.content_type === "model_editable_context"));

    if (isSystemContext) {
      const sys: SystemPromptPart = {
        part_kind: "system-prompt",
        content: _stringifyContentAsText(msg),
        timestamp: timestampIso,
      };
      modelEntry = { kind: "request", parts: [sys] } as ModelRequest;
    } else if (role === "tool") {
      const toolName = msg.author?.name || msg.metadata?.command || "tool";

      // OLD format Deep Research: api_tool / api_tool.call_tool are internal plumbing messages
      if (toolName === "api_tool" || toolName === "api_tool.call_tool") {
        const contentText = _stringifyContentAsText(msg);
        if (
          contentText.includes("embedded UI") &&
          contentText.toLowerCase().includes("deep research")
        ) {
          // The report was rendered as a sandboxed widget — not stored in the offline export
          modelEntry = {
            kind: "response",
            parts: [
              {
                part_kind: "text",
                content:
                  "_[Deep Research report: the full report was rendered as an interactive widget and is not stored in the offline export.]_",
              } as TextPart,
            ],
            timestamp: timestampIso,
            model_name: "Deep Research",
            vendor_id: msg.id,
          } as ModelResponse;
        } else {
          // Internal session setup (session_id, connector_settings, etc.) — skip
          const ret: ToolReturnPart = {
            part_kind: "tool-return",
            tool_name: toolName,
            content: "",
            tool_call_id: msg.metadata?.request_id || msg.id,
            timestamp: timestampIso,
          };
          modelEntry = { kind: "request", parts: [ret] } as ModelRequest;
        }
      } else {
        // Check if this tool message contains images (e.g. DALL-E generation)
        const { responseParts } = msg.content
          ? messagePartsFromContent(msg.content, assets)
          : { responseParts: [] };

        const hasImages = responseParts?.some((p) => p.part_kind === "image-response");

        if (hasImages && responseParts && responseParts.length > 0) {
          // If the tool returned images, treat it as a response (like an assistant showing an image)
          modelEntry = {
            kind: "response",
            parts: responseParts,
            timestamp: timestampIso,
            model_name: "DALL-E", // Explicitly mark as DALL-E for better UI indication
            vendor_id: msg.id,
          } as ModelResponse;
        } else {
          // Standard tool return (text/execution result)
          const contentText = _stringifyContentAsText(msg);
          const toolCallId = msg.metadata?.request_id || msg.id;
          const ret: ToolReturnPart = {
            part_kind: "tool-return",
            tool_name: toolName,
            content: contentText,
            tool_call_id: toolCallId,
            timestamp: timestampIso,
          };
          modelEntry = { kind: "request", parts: [ret] } as ModelRequest;
        }
      }
    } else if (role === "user") {
      const { userParts } = msg.content
        ? messagePartsFromContent(msg.content, assets)
        : { userParts: "" };

      let finalUserContent: string | UserContent[] = "";
      if (Array.isArray(userParts)) {
        finalUserContent = userParts;
      } else if (typeof userParts === "string") {
        finalUserContent = userParts;
      } else if (userParts) {
        // Single object (UserContent), wrap in array
        finalUserContent = [userParts];
      }

      const up: UserPromptPart = {
        part_kind: "user-prompt",
        content: finalUserContent,
        timestamp: timestampIso,
      };
      modelEntry = { kind: "request", parts: [up] } as ModelRequest;
    } else {
      // assistant

      // OLD format Deep Research trigger: assistant text is a JSON action string
      // e.g. {"path": "/Deep Research App/implicit_link::connector_openai_deep_research/start", "args": {...}}
      const firstPart =
        msg.content &&
        "parts" in msg.content &&
        Array.isArray(msg.content.parts) &&
        msg.content.parts[0];
      if (
        msg.content?.content_type === "text" &&
        typeof firstPart === "string" &&
        firstPart.trimStart().startsWith('{"path": "/Deep Research App/')
      ) {
        modelEntry = {
          kind: "response",
          parts: [
            { part_kind: "text", content: "_[Deep Research request submitted]_" } as TextPart,
          ],
          timestamp: timestampIso,
          model_name: "Deep Research",
          vendor_id: msg.id,
        } as ModelResponse;
      } else if (
        // NEW format Deep Research: internal task settings JSON block (not shown to user)
        // e.g. {"task_violates_safety_guidelines": false, "user_def_doesnt_want_research": false, ...}
        msg.content?.content_type === "code" &&
        typeof (msg.content as { text?: string }).text === "string" &&
        (msg.content as { text: string }).text.includes("task_violates_safety_guidelines")
      ) {
        // Skip — this is an internal task dispatch payload, not user-facing content
        modelEntry = {
          kind: "response",
          parts: [],
          timestamp: timestampIso,
          model_name: "",
          vendor_id: msg.id,
        } as ModelResponse;
      } else {
        const { responseParts } = msg.content
          ? messagePartsFromContent(msg.content, assets)
          : { responseParts: [] };
        const parts = responseParts || [];
        // If metadata shows a tool invocation, prepend a tool-call part
        if (msg.metadata?.command) {
          // Convert args to the correct type (string | Record<string, unknown> | undefined)
          let args: string | Record<string, unknown> | undefined;
          if (msg.metadata.args !== null && msg.metadata.args !== undefined) {
            if (typeof msg.metadata.args === "string") {
              args = msg.metadata.args;
            } else if (
              typeof msg.metadata.args === "object" &&
              Object.keys(msg.metadata.args).length > 0
            ) {
              args = msg.metadata.args as Record<string, unknown>;
            }
            // If it's an empty object, args remains undefined
          }

          const tc: ToolCallPart = {
            part_kind: "tool-call",
            tool_name: msg.metadata.command,
            args,
            tool_call_id: msg.metadata.request_id || msg.id,
          };
          parts.unshift(tc);
        }
        modelEntry = {
          kind: "response",
          parts,
          timestamp: timestampIso,
          model_name: getModelName(
            msg.metadata?.model_slug ||
              msg.metadata?.default_model_slug ||
              conversation.default_model_slug ||
              "",
          ),
          vendor_id: msg.id,
        } as ModelResponse;
      } // end normal assistant handling
    }

    return {
      id: treeNode.id,
      parentId: treeNode.parentId,
      childrenIds: [],
      message: [modelEntry],
      model: "ChatGPT",
      done: true,
      timestamp: timestampMs,
      chatId: conversationId,
    };
  });

  const convId =
    ("conversation_id" in conversation && typeof conversation.conversation_id === "string"
      ? conversation.conversation_id
      : null) ||
    ("id" in conversation && typeof conversation.id === "string" ? conversation.id : null) ||
    "";
  const chat: Chat = {
    id: convId,
    source: "chatgpt",
    sourceId: convId,
    title: conversation.title || "ChatGPT Conversation",
    models: ["ChatGPT"],
    system: "",
    params: {},
    currentId: conversation.current_node || rootIds[rootIds.length - 1] || "",
    messages,
    tags: ["chatgpt"],
    timestamp: toMs(conversation.create_time) || Date.now(),
    providerLastModifiedTimestamp: toMs(conversation.update_time) || undefined,
    // Sync metadata fields - will be set by SyncService.saveChat()
    lastSyncedTimestamp: Date.now(),
    checksum: "",
    syncStatus: "new",
    deleted: 0,
  };

  return chat;
}
