/**
 * TypeScript interfaces for representing exported OpenAI conversation data.
 * These types are meticulously defined to mirror the structure of the
 * Pydantic models, including nested objects and optional fields.
 */

// A helper type for literal strings, mimicking Python's `Literal`.
type Literal<T extends readonly string[]> = T[number];

/**
 * Defines the roles an author can have in a conversation.
 */
type AuthorRole = Literal<["system", "assistant", "user", "tool"]>;

/**
 * Author information for OpenAI messages.
 */
export interface OpenAIAuthor {
  /** The role of the author (e.g., 'system', 'assistant', 'user', 'tool'). */
  role: AuthorRole;
  /** An optional name for the author. */
  name: string | null;
  /** A dictionary for additional metadata. */
  metadata: Record<string, unknown>;
}

/**
 * Details about how a message generation finished.
 */
export interface OpenAIFinishDetails {
  /** The type of finish detail. */
  type: string;
  /** Optional list of stop tokens that ended the generation. */
  stop_tokens: number[] | null;
}

/**
 * Represents a citation within a message.
 */
export interface OpenAICitation {
  /** The starting index of the cited text in the message content. */
  start_ix: number;
  /** The ending index of the cited text in the message content. */
  end_ix: number;
  /** The format type of the citation. */
  citation_format_type: string;
  /** Optional metadata for the citation. */
  metadata: Record<string, unknown> | null;
}

/**
 * Metadata structure for citations.
 */
export interface OpenAICiteMetadata {
  /** A dictionary defining the citation format. */
  citation_format: Record<string, string>;
  /** A list of metadata for each citation. */
  metadata_list: Record<string, unknown>[];
}

/**
 * Represents the result of a code execution.
 */
export interface OpenAIAggregateResult {
  /** The executed code snippet. */
  code: string;
  /** Optional final output of the expression. */
  final_expression_output: string | null;
  /** The end timestamp of the execution. Can be a number (float) or string. */
  end_time: number | string | null;
  /** A list of messages from the Jupyter kernel. */
  jupyter_messages: unknown[];
  /** A list of messages related to the execution. */
  messages: Record<string, unknown>[];
  /** The ID of the execution run. */
  run_id: string;
  /** The start timestamp of the execution. Can be a number (float) or string. */
  start_time: number | string | null;
  /** The status of the execution (e.g., 'success', 'failure'). */
  status: string;
  /** The update timestamp of the execution. Can be a number (float) or string. */
  update_time: number | string | null;
}

/**
 * Metadata associated with a message.
 */
export interface OpenAIMessageMetadata {
  /** Optional details about the message's finishing state. */
  finish_details: OpenAIFinishDetails | null;
  /** Whether the message is considered a complete thought or turn. */
  is_complete: boolean | null;
  /** The slug of the model that generated the message. */
  model_slug: string | null;
  /** The slug of the default model for the conversation. */
  default_model_slug: string | null;
  /** The ID of the parent message. */
  parent_id: string | null;
  /** An ID for the request. */
  request_id: string | null;
  /** The timestamp of the message metadata. */
  timestamp_: string | null;
  /** A list of citations within the message. */
  citations: OpenAICitation[];
  /** Optional citation metadata. */
  _cite_metadata: OpenAICiteMetadata | null;
  /** Optional results of code execution. */
  aggregate_result: OpenAIAggregateResult | null;
  /** Optional arguments for a tool call. */
  args: unknown | null;
  /** The command that was executed. */
  command: string | null;
  /** The type of the message. */
  message_type: string | null;
}

/**
 * Metadata for a DALL-E image generation.
 */
export interface OpenAIDalleMetadata {
  /** The unique ID for the generation. */
  gen_id: string;
  /** The prompt used to generate the image. */
  prompt: string;
  /** The seed used for the generation. */
  seed: number | null;
  /** The ID of the parent generation, if this is an edit. */
  parent_gen_id: string | null;
  /** The type of edit operation. */
  edit_op: string | null;
  /** The title for serialization. */
  serialization_title: string;
}

/**
 * General metadata for an image generation.
 */
export interface OpenAIGenerationMetadata {
  /** The unique ID for the generation. */
  gen_id: string;
  /** The size of the generated image (e.g., '1024x1024'). */
  gen_size: string | null;
  /** The seed used for the generation. */
  seed: number | null;
  /** The ID of the parent generation. */
  parent_gen_id: string | null;
  /** The height of the image in pixels. */
  height: number;
  /** The width of the image in pixels. */
  width: number;
  /** Whether the image has a transparent background. */
  transparent_background: boolean | null;
  /** The title for serialization. */
  serialization_title: string;
}

/**
 * An asset pointer for an image, including its metadata.
 */
export interface OpenAIImageAssetPointer {
  /** The content type, always 'image_asset_pointer'. */
  content_type: "image_asset_pointer";
  /** A pointer to the image asset. */
  asset_pointer: string;
  /** The size of the image in bytes. */
  size_bytes: number;
  /** The width of the image. */
  width: number;
  /** The height of the image. */
  height: number;
  /** Foveated rendering detail level. */
  fovea: number | null;
  /** Additional metadata for the image. */
  metadata: Record<string, unknown>;
  /**
   * Helper method to extract DALL-E specific metadata if available.
   * Note: TypeScript interfaces do not have methods, so this is a comment.
   * To implement this, you would create a function that takes this object as an argument.
   * `dalle_metadata?: OpenAIDalleMetadata | null;`
   */
  // get dalle_metadata(): OpenAIDalleMetadata | null;
  /**
   * Helper method to extract general generation metadata.
   * Note: TypeScript interfaces do not have methods, so this is a comment.
   * To implement this, you would create a function that takes this object as an argument.
   * `generation_metadata?: OpenAIGenerationMetadata | null;`
   */
  // get generation_metadata(): OpenAIGenerationMetadata | null;
}

/**
 * Text content of a message.
 */
export interface OpenAITextContent {
  /** The content type, always 'text'. */
  content_type: "text";
  /** A list of text parts. */
  parts: string[];
}

/**
 * Multimodal content with text and image pointers.
 */
export interface OpenAIMultimodalContent {
  /** The content type, always 'multimodal_text'. */
  content_type: "multimodal_text";
  /** A list of parts which can be text or image asset pointers. */
  parts: (string | OpenAIImageAssetPointer)[];
}

/**
 * Code content for tool calls.
 */
export interface OpenAICodeContent {
  /** The content type, always 'code'. */
  content_type: "code";
  /** The programming language of the code. */
  language: string | null;
  /** The actual code as a string. */
  text: string;
}

/**
 * Output from a code execution.
 */
export interface OpenAIExecutionOutputContent {
  /** The content type, always 'execution_output'. */
  content_type: "execution_output";
  /** The text output of the execution. */
  text: string;
}

/**
 * Web Browse quote content.
 */
export interface OpenAITetherQuoteContent {
  /** The content type, always 'tether_quote'. */
  content_type: "tether_quote";
  /** The domain of the cited source. */
  domain: string | null;
  /** The text of the quote. */
  text: string;
  /** The title of the source page. */
  title: string;
  /** The URL of the source. */
  url: string | null;
}

/**
 * Web Browse display content.
 */
export interface OpenAITetherBrowseDisplayContent {
  /** The content type, always 'tether_Browse_display'. */
  content_type: "tether_Browse_display";
  /** The result of the Browse action. */
  result: string;
  /** A summary of the Browse action. */
  summary: string | null;
}

/**
 * Web Browse code content.
 */
export interface OpenAITetherBrowseCodeContent {
  /** The content type, always 'tether_Browse_code'. */
  content_type: "tether_Browse_code";
}

/**
 * User-editable context, typically for system prompts.
 */
export interface OpenAIUserEditableContextContent {
  /** The content type, always 'user_editable_context'. */
  content_type: "user_editable_context";
  /** The user's profile information. */
  user_profile: string | null;
  /** Specific instructions from the user. */
  user_instructions: string | null;
}

/**
 * Model-editable context.
 */
export interface OpenAIModelEditableContextContent {
  /** The content type, always 'model_editable_context'. */
  content_type: "model_editable_context";
  /** The context set by the model. */
  model_set_context: string;
}

/**
 * Content representing the AI's internal reasoning or "thoughts".
 */
export interface OpenAIThoughtsContent {
  /** The content type, always 'thoughts'. */
  content_type: "thoughts";
  /** The text of the thoughts. */
  text: string | null;
}

/**
 * A recap of the AI's reasoning.
 */
export interface OpenAIReasoningRecapContent {
  /** The content type, always 'reasoning_recap'. */
  content_type: "reasoning_recap";
  /** The text of the reasoning recap. */
  text: string | null;
}

/**
 * Content representing a system error.
 */
export interface OpenAISystemErrorContent {
  /** The content type, always 'system_error'. */
  content_type: "system_error";
  /** The text of the error message. */
  text: string | null;
}

/**
 * A union type representing all possible content types for a message.
 */
export type OpenAIMessageContent =
  | OpenAITextContent
  | OpenAIMultimodalContent
  | OpenAICodeContent
  | OpenAIExecutionOutputContent
  | OpenAITetherQuoteContent
  | OpenAITetherBrowseDisplayContent
  | OpenAITetherBrowseCodeContent
  | OpenAIUserEditableContextContent
  | OpenAIModelEditableContextContent
  | OpenAIThoughtsContent
  | OpenAIReasoningRecapContent
  | OpenAISystemErrorContent;

/**
 * The structure of a single OpenAI message.
 */
export interface OpenAIMessage {
  /** A unique ID for the message. */
  id: string;
  /** The author of the message. */
  author: OpenAIAuthor;
  /** The timestamp when the message was created. */
  create_time: number | null;
  /** The timestamp when the message was last updated. */
  update_time: number | null;
  /** The content of the message, which can be one of several types. */
  content: OpenAIMessageContent;
  /** The status of the message. */
  status: string;
  /** Whether this message marks the end of a turn. */
  end_turn: boolean | null;
  /** A weighting value for the message, defaulting to 1.0. */
  weight: number;
  /** Optional metadata for the message. */
  metadata: OpenAIMessageMetadata | null;
  /** The recipient of the message, defaulting to 'all'. */
  recipient: string;
  /** An optional channel identifier. */
  channel: string | null;
}

/**
 * A single node in the conversation's tree-like structure.
 */
export interface OpenAIConversationNode {
  /** The ID of the node. */
  id: string;
  /** The message associated with this node. */
  message: OpenAIMessage | null;
  /** The ID of the parent node. */
  parent: string | null;
  /** A list of child node IDs. */
  children: string[];
}

/**
 * The top-level structure of an exported OpenAI conversation.
 * Returned by `https://chatgpt.com/backend-api/conversation/<chatId>`
 */
export interface OpenAIConversation {
  /** The unique ID of the conversation. */
  id: string;
  /** A secondary conversation ID, often the same as `id`. */
  conversation_id: string | null;
  /** The title of the conversation. */
  title: string;
  /** The creation timestamp in float format. */
  create_time: number;
  /** The last update timestamp in float format. */
  update_time: number;
  /** The ID of the current node in the conversation tree. */
  current_node: string;
  /** A mapping of node IDs to their corresponding `OpenAIConversationNode` objects. */
  mapping: Record<string, OpenAIConversationNode>;
  /** A list of moderation results. */
  moderation_results: unknown[];
  /** Whether the conversation is archived. */
  is_archived: boolean;
  /** Whether the conversation is starred. */
  is_starred: boolean | null;
  /** Whether the conversation should not be remembered by the model. */
  is_do_not_remember: boolean | null;
  /** A list of safe URLs. */
  safe_urls: string[];
  /** A list of blocked URLs. */
  blocked_urls: string[];
  /** A list of plugin IDs used in the conversation. */
  plugin_ids: string[] | null;
  /** The ID of a specific 'gizmo' (custom AI model). */
  gizmo_id: string | null;
  /** The type of the gizmo. */
  gizmo_type: string | null;
  /** An ID for the conversation template used. */
  conversation_template_id: string | null;
  /** The slug of the default model for this conversation. */
  default_model_slug: string | null;
  /** The status of any asynchronous operations. */
  async_status: string | null;
  /** The origin of the conversation. */
  conversation_origin: string | null;
  /** The voice used for the conversation. */
  voice: string | null;
  /** A list of disabled tool IDs. */
  disabled_tool_ids: string[] | null;
  /** The memory scope of the conversation. */
  memory_scope: string | null;
  /** An ID for a 'sugar item', a placeholder for a feature. */
  sugar_item_id: string | null;
}

/**
 * A mapping of model slugs to human-readable names.
 */
export const MODEL_MAPPING: Record<string, string> = {
  "text-davinci-002-render-sha": "GPT-3.5",
  "text-davinci-002-render-paid": "GPT-3.5",
  "text-davinci-002-browse": "GPT-3.5",
  "text-davinci-002": "GPT-3.5",
  "gpt-4": "GPT-4",
  "gpt-4-Browse": "GPT-4 (Browser)",
  "gpt-4-gizmo": "GPT-4 (Custom)",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
};

/**
 * Retrieves a human-readable model name from a model slug.
 * @param modelSlug The slug of the model.
 * @returns The readable model name, or the slug if not found.
 */
export function getModelName(modelSlug: string | null): string {
  if (!modelSlug) {
    return "unknown";
  }
  return MODEL_MAPPING[modelSlug] || modelSlug;
}

/**
 * Interfaces for representing a list of AI chats.
 * The data structures describe the shape of the JSON response
 * for a collection of user-AI conversations.
 */

/**
 * Represents a single AI chat conversation.
 */
export interface ChatItem {
  /**
   * A unique identifier for the conversation, typically a UUID.
   */
  id: string;
  /**
   * The user-given or generated title of the chat.
   */
  title: string;
  /**
   * The timestamp when the conversation was first created, in ISO 8601 format.
   */
  create_time: string;
  /**
   * The timestamp when the conversation was last updated, in ISO 8601 format.
   */
  update_time: string;
  /**
   * A mapping of nodes in the conversation. This field is consistently null in the provided data.
   */
  mapping: null;
  /**
   * The current node or position within the conversation. Consistently null in the provided data.
   */
  current_node: null;
  /**
   * An identifier for a conversation template, if applicable. Consistently null in the provided data.
   */
  conversation_template_id: null;
  /**
   * The ID of a specific AI model or "gizmo" used for the chat. Consistently null in the provided data.
   */
  gizmo_id: null;
  /**
   * A boolean indicating if the chat has been archived.
   */
  is_archived: boolean;
  /**
   * A boolean indicating if the chat has been starred or marked as a favorite. This field is null in the provided data.
   */
  is_starred: null;
  /**
   * A boolean indicating whether the AI should not remember the contents of the conversation.
   */
  is_do_not_remember: boolean | null;
  /**
   * The memory setting for the chat, e.g., 'global_enabled'.
   */
  memory_scope: string;
  /**
   * The ID of the workspace the chat belongs to. Consistently null in the provided data.
   */
  workspace_id: null;
  /**
   * The status of any asynchronous operations related to the chat. Consistently null in the provided data.
   */
  async_status: null;
  /**
   * An array of URLs considered "safe" for the chat's context. Consistently an empty array.
   */
  safe_urls: string[];
  /**
   * An array of URLs that are blocked in the chat's context. Consistently an empty array.
   */
  blocked_urls: string[];
  /**
   * Information about the origin of the conversation. Consistently null in the provided data.
   */
  conversation_origin: null;
  /**
   * A brief snippet or summary of the conversation. Consistently null in the provided data.
   */
  snippet: null;
  /**
   * An ID for a sugar item, which seems to be a placeholder for a feature. Consistently null in the provided data.
   */
  sugar_item_id: null;
  /**
   * A boolean indicating the visibility of the sugar item.
   */
  sugar_item_visible: boolean;
}

/**
 * The root interface for the JSON response, containing a list of chat items.
 * Returned by `https://chatgpt.com/backend-api/conversations?offset=<offset>&limit=<limit>&order=updated&is_archived=false`
 */
export interface ChatList {
  /**
   * An array of ChatItem objects.
   */
  items: ChatItem[];
}

/**
 * Raw extraction types for ChatGPT data.
 * These represent the untransformed data structure returned by the extractor.
 */

/**
 * Entry in the assets map for downloaded ChatGPT assets (images, etc.)
 */
export interface ChatGPTAssetsMapEntry {
  dataBase64: string;
  contentType: string;
  filename?: string;
}

/**
 * Map of asset pointers to their downloaded binary data.
 */
export type ChatGPTAssetsMap = Record<string, ChatGPTAssetsMapEntry>;

/**
 * Raw extraction result from ChatGPT extractor.
 * Contains the conversation data and any downloaded assets.
 */
export interface ChatGPTRawExtraction {
  conversation: OpenAIConversation;
  assets: ChatGPTAssetsMap;
}
