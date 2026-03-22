/**
 * @file TypeScript Data Structures for AI Chat Transcript
 * @description This file defines a detailed set of TypeScript interfaces and types to accurately
 *              describe the structure of an AI chat transcript JSON object.
 *
 *              The data structures are designed with the following principles:
 *              - **Type Safety:** Ensure strict type checking for all fields.
 *              - **Clarity:** Provide descriptive comments for each field and interface.
 *              - **Specificity:** Use union of literal types (e.g., `'human' | 'assistant'`)
 *                                 where the possible values are known and limited.
 *              - **Extensibility:** Use `string` or `unknown[]` for fields where the exact
 *                                  structure or full set of possible values is not exhaustively
 *                                  known from the provided sample, allowing for future expansion.
 *              - **Modularity:** Break down the overall structure into smaller, reusable interfaces.
 *
 *              The top-level interface is `ChatTranscript`, which represents the entire chat session.
 *              It contains metadata about the chat and an array of `ChatMessage` objects.
 *              Each `ChatMessage` can contain various `ChatMessageContentPart` types,
 *              reflecting the multimodal nature of AI conversations (text, internal thoughts, tool usage).
 */

/**
 * Type alias for a universally unique identifier (UUID) string.
 * @example "f75ac9be-f5d9-427e-87c8-6abd82a9ef10"
 */
type UUID = string;

/**
 * Type alias for an ISO 8601 formatted date-time string with timezone offset.
 * @example "2025-08-08T11:11:26.355943+00:00"
 */
type ISODateTime = string;

/**
 * Represents the input provided to an 'artifacts' tool.
 * This structure is specific to artifacts, but `ToolInput` can be extended for other tools.
 */
interface ArtifactsToolInput {
  /** The unique identifier for the artifact. */
  id: string;
  /** The MIME type or a custom type of the artifact, indicating its format. */
  type: "application/vnd.ant.code" | "text/html";
  /** A descriptive title for the artifact. */
  title: string;
  /** The command associated with the artifact, typically indicating its purpose. */
  command: "create";
  /** The actual content of the artifact, usually a string representing code, HTML, or plain text. */
  content: string;
  /** The programming language of the `content`, if applicable. */
  language: "json" | "typescript" | "javascript" | "css" | "html";
  /** A UUID representing the specific version of the artifact. */
  version_uuid: UUID;
}

/**
 * A union type representing any possible structured input for a tool.
 * As new tools are encountered, their specific input interfaces should be added to this union.
 * @example `ArtifactsToolInput | SomeOtherToolInput`
 */
type ToolInput = ArtifactsToolInput; // Currently, only 'artifacts' tool input is detailed in the sample.

/**
 * Base interface for all types of content parts within a `ChatMessage`.
 * All content parts share these timestamp properties.
 */
interface BaseContentPart {
  /** The ISO 8601 timestamp when this content part began being generated or was first received. */
  start_timestamp: ISODateTime;
  /** The ISO 8601 timestamp when this content part finished being generated or was fully received. */
  stop_timestamp: ISODateTime;
}

/**
 * Represents a standard text block within a chat message.
 */
export interface TextContentPart extends BaseContentPart {
  /** Indicates that this content part is plain text. */
  type: "text";
  /** The actual textual content of this part. */
  text: string;
  /** An array of citations relevant to the text. In the provided sample, this is always empty,
   *  but it's typed as `unknown[]` to allow for potential future structured citation data. */
  citations: unknown[];
}

/**
 * Represents the AI's internal thought process or reasoning steps.
 * This content type provides insight into how the AI arrived at its response.
 */
export interface ThinkingContentPart extends BaseContentPart {
  /** Indicates that this content part describes the AI's thinking process. */
  type: "thinking";
  /** The detailed description of the AI's internal thought process. */
  thinking: string;
  /** A list of concise summaries derived from the `thinking` process, often used for UI display. */
  summaries: Array<{
    /** A short summary of a specific point in the AI's thought process. */
    summary: string;
  }>;
  /** A boolean indicating if the AI's thinking process was interrupted or incomplete. */
  cut_off: boolean;
}

/**
 * Represents the AI making a call to an external tool or function.
 */
export interface ToolUseContentPart extends BaseContentPart {
  /** Indicates that this content part represents the AI invoking a tool. */
  type: "tool_use";
  /** The programmatic name or identifier of the tool being invoked (e.g., 'artifacts'). */
  name: string;
  /** The structured input parameters provided to the tool. The exact shape depends on the `name` of the tool. */
  input: ToolInput;
  /** A short, descriptive message associated with the tool usage, often mirroring the tool's name. */
  message: string;
}

/**
 * Represents the result or output obtained from an external tool that the AI invoked.
 */
export interface ToolResultContentPart extends BaseContentPart {
  /** Indicates that this content part contains the result from a tool. */
  type: "tool_result";
  /** The programmatic name of the tool that produced this result (e.g., 'artifacts'). */
  name: string;
  /** An array containing the detailed output content from the tool. */
  content: Array<{
    /** The type of the content within this specific tool result block (e.g., 'text'). */
    type: "text";
    /** The textual representation of the tool's output. */
    text: string;
    /** A unique identifier for this particular content block within the tool result. */
    uuid: UUID;
  }>;
  /** A boolean indicating whether the tool execution resulted in an error. */
  is_error: boolean;
}

/**
 * A union type representing any possible type of content part within a `ChatMessage`.
 * This allows for flexible message structures, combining plain text, internal thoughts,
 * tool invocations, and tool results within a single message.
 */
export type ChatMessageContentPart =
  | TextContentPart
  | ThinkingContentPart
  | ToolUseContentPart
  | ToolResultContentPart;

/**
 * Represents a file attachment associated with a chat message.
 */
export interface ChatAttachment {
  /** The unique identifier for this specific attachment. */
  id: UUID;
  /** The original name of the attached file. */
  file_name: string;
  /** The size of the file in bytes. */
  file_size: number;
  /** The file type or extension (e.g., 'txt'). Can be extended with more specific literals if known. */
  file_type: string;
  /** The extracted textual content from the file, if it was a text-based file. */
  extracted_content: string;
  /** The ISO 8601 timestamp when the attachment was created. */
  created_at: ISODateTime;
}

/**
 * Represents an asset (thumbnail or preview) for a file attachment.
 */
export interface ChatFileAsset {
  /** The URL path to access this asset variant. */
  url: string;
  /** The variant type: 'thumbnail' or 'preview'. */
  file_variant: "thumbnail" | "preview";
  /** Primary color extracted from the image (hex without #). */
  primary_color?: string;
  /** Image width in pixels. */
  image_width?: number;
  /** Image height in pixels. */
  image_height?: number;
}

/**
 * Represents a file attachment in Claude's files array.
 * These are typically images with URL references rather than inline content.
 */
export interface ChatFile {
  /** The kind of file (e.g., 'image'). */
  file_kind: "image" | "document" | string;
  /** The unique identifier for this file. */
  file_uuid: UUID;
  /** The original name of the file. */
  file_name: string;
  /** The ISO 8601 timestamp when the file was uploaded. */
  created_at: ISODateTime;
  /** URL path to the thumbnail. */
  thumbnail_url?: string;
  /** URL path to the preview. */
  preview_url?: string;
  /** Thumbnail asset metadata. */
  thumbnail_asset?: ChatFileAsset;
  /** Preview asset metadata. */
  preview_asset?: ChatFileAsset;
}

/**
 * Represents a file attachment in Claude's files_v2 array.
 * Similar to ChatFile but includes a success indicator.
 */
export interface ChatFileV2 extends ChatFile {
  /** Whether the file was successfully processed. */
  success: boolean;
}

/**
 * Represents a single message within the chat transcript, sent by either a human or the AI assistant.
 */
interface ChatMessage {
  /** The unique identifier for this individual chat message. */
  uuid: UUID;
  /** The primary textual content of the message. This can be empty if the rich `content` array holds the actual text,
   *  especially for messages with complex parts like tool use or thinking. */
  text: string;
  /** An array of rich content parts that compose the message. A single message can consist of multiple distinct parts
   *  (e.g., a text response followed by the AI's internal thinking process). */
  content: ChatMessageContentPart[];
  /** The sender of the message. */
  sender: "human" | "assistant";
  /** The sequential, zero-based index of the message within the entire chat transcript. */
  index: number;
  /** The ISO 8601 timestamp when the message was initially created. */
  created_at: ISODateTime;
  /** The ISO 8601 timestamp when the message was last updated or edited. */
  updated_at: ISODateTime;
  /** A boolean indicating if the message content was truncated (e.g., due to length limits). */
  truncated: boolean;
  /** The reason the AI stopped generating the message. This field is typically present only for assistant messages.
   *  It can be a known literal value like 'stop_sequence' or 'user_canceled', or other string values. */
  stop_reason?: "stop_sequence" | "user_canceled" | string;
  /** An array of legacy file attachments associated with the message. Often empty, `files_v2` is typically preferred. */
  attachments: ChatAttachment[];
  /** An array of file attachments containing URL references to images/documents hosted on Claude. */
  files: ChatFile[];
  /** A newer array for file attachments with success indicator. */
  files_v2: ChatFileV2[];
  /** An array of synchronization sources. Its purpose is unclear from the sample and it is empty. */
  sync_sources: unknown[];
  /** The UUID of the message that this message is a direct reply to, forming a conversation thread.
   *  A value of "00000000-0000-4000-8000-000000000000" often indicates a root message or no direct parent. */
  parent_message_uuid: UUID;
}

/**
 * Represents the configuration settings for a specific chat session.
 */
interface ChatSettings {
  /** A boolean indicating if web search functionality was enabled for this chat. */
  enabled_web_search: boolean;
  /** An object mapping specific tool identifiers (strings) to a boolean indicating
   *  whether that tool was enabled for use in this chat. */
  enabled_mcp_tools: Record<string, boolean>;
  /** The operating mode of the 'paprika' feature. From the sample, 'extended' is a known value,
   *  but it's typed as `string` to allow for other potential modes. */
  paprika_mode: "extended" | string;
  /** A boolean indicating if preview features that utilize artifacts were enabled. */
  preview_feature_uses_artifacts: boolean;
  /** A boolean indicating if the attachment of artifacts was enabled for this chat. */
  enabled_artifacts_attachments: boolean;
}

/**
 * The top-level interface representing the entire AI chat transcript.
 * This encapsulates all metadata and the complete sequence of messages.
 * This is returned by `https://claude.ai/chat/<chatId>`
 */
export interface ChatTranscript {
  /** The unique identifier for this entire chat session. */
  uuid: UUID;
  /** The user-assigned name or title of the chat conversation. */
  name: string;
  /** A summary description of the chat's content. Can be an empty string if no summary is available. */
  summary: string;
  /** The ISO 8601 timestamp when the chat session was initially created. */
  created_at: ISODateTime;
  /** The ISO 8601 timestamp when the chat session was last updated (e.g., a new message was added). */
  updated_at: ISODateTime;
  /** An object containing various settings applied to this chat session. */
  settings: ChatSettings;
  /** A boolean indicating if the chat has been marked as starred or a favorite by the user. */
  is_starred: boolean;
  /** A boolean indicating if the chat session is temporary and may not be persistently stored. */
  is_temporary: boolean;
  /** The UUID of the latest message in the main conversation thread. This indicates the "leaf" of the chat tree. */
  current_leaf_message_uuid: UUID;
  /** An ordered array of all messages within this chat transcript, representing the conversation flow. */
  chat_messages: ChatMessage[];
}

/**
 * Interfaces for describing AI chat data structures.
 */

/**
 * Interface representing a single project.
 * This structure is used when a project is associated with a chat.
 */
export interface Project {
  /**
   * A unique identifier for the project.
   */
  uuid: UUID;
  /**
   * The name of the project.
   */
  name: string;
}

/**
 * Interface representing a single AI chat conversation.
 * This describes the structure of an individual chat object in the list.
 */
export interface Chat {
  /**
   * A unique identifier for the chat.
   */
  uuid: UUID;
  /**
   * The user-defined name of the chat. It can be an empty string if not named.
   */
  name: string;
  /**
   * A brief summary or description of the chat's content.
   */
  summary: string;
  /**
   * The AI model used for the chat. It can be null if not specified.
   */
  model: string | null;
  /**
   * The timestamp when the chat was first created.
   */
  created_at: string;
  /**
   * The timestamp of the last update to the chat.
   */
  updated_at: string;
  /**
   * A boolean indicating if the chat has been starred by the user.
   */
  is_starred: boolean;
  /**
   * A boolean indicating if the chat is a temporary conversation.
   */
  is_temporary: boolean;
  /**
   * The unique identifier of the associated project. Can be null.
   */
  project_uuid: UUID | null;
  /**
   * The unique identifier of the latest message in the conversation. Can be null.
   */
  current_leaf_message_uuid: UUID | null;
  /**
   * The project object associated with the chat. Can be null.
   */
  project: Project | null;
}

/**
 * A type alias for a list of chats.
 * This describes the top-level data structure, which is an array of Chat objects.
 * This is returned by `https://claude.ai/api/organizations/<org-id>/chat_conversations`
 */
export type ChatList = Chat[];
