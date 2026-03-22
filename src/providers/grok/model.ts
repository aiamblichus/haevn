/**
 * TypeScript interfaces for Grok's raw API responses
 */

/**
 * Conversation metadata
 */
export interface GrokConversation {
  conversationId: string;
  title: string;
  starred: boolean;
  createTime: string; // ISO 8601
  modifyTime: string; // ISO 8601
  systemPromptName: string;
  temporary: boolean;
  mediaTypes: string[];
  workspaces: unknown[];
  taskResult: Record<string, unknown>;
}

/**
 * List of conversations response
 */
export interface GrokConversationsResponse {
  conversations: GrokConversation[];
  textSearchMatches: unknown[];
}

/**
 * DAG node representing a message in the conversation tree
 */
export interface GrokResponseNode {
  responseId: string;
  sender: "human" | "assistant";
  parentResponseId?: string;
}

/**
 * Response nodes (DAG structure) response
 */
export interface GrokResponseNodesResponse {
  responseNodes: GrokResponseNode[];
  inflightResponses: unknown[];
}

/**
 * Single conversation metadata response
 */
export interface GrokConversationResponse {
  conversation: GrokConversation;
}

/**
 * File attachment metadata
 */
export interface GrokFileAttachment {
  fileMetadataId: string;
  fileMimeType: string;
  fileName: string;
  fileUri: string; // Format: users/{userId}/{fileId}/content
  parsedFileUri: string;
  createTime: string;
  fileSource: string;
}

/**
 * Model metadata
 */
export interface GrokModelMetadata {
  modelConfigOverride?: {
    modelMap: Record<string, unknown>;
  };
  requestModelDetails?: {
    modelId: string;
  };
  usedCustomInstructions?: boolean;
  deepsearchPreset?: string;
  llm_info?: {
    modelHash: string;
  };
  request_metadata?: {
    effort?: string;
    mode?: string;
    model?: string;
  };
  request_trace_id?: string;
  ui_layout?: {
    effort?: string;
    reasoningUiLayout?: string;
    willThinkLong?: boolean;
  };
}

/**
 * UI layout information
 */
export interface GrokUILayout {
  reasoningUiLayout?: string;
  willThinkLong?: boolean;
  effort?: string;
}

/**
 * Request metadata
 */
export interface GrokRequestMetadata {
  model?: string;
  mode?: string;
  effort?: string;
}

/**
 * Full message content
 */
export interface GrokResponse {
  responseId: string;
  message: string;
  sender: "human" | "assistant";
  createTime: string; // ISO 8601
  parentResponseId?: string;
  manual: boolean;
  partial: boolean;
  shared: boolean;
  query: string;
  queryType: string;
  webSearchResults: unknown[];
  xpostIds: string[];
  xposts: unknown[];
  generatedImageUrls: string[];
  imageAttachments: unknown[];
  fileAttachments: string[];
  cardAttachmentsJson: unknown[];
  fileUris: string[];
  fileAttachmentsMetadata: GrokFileAttachment[];
  isControl: boolean;
  steps: unknown[];
  imageEditUris: string[];
  mediaTypes: string[];
  webpageUrls: string[];
  metadata: GrokModelMetadata;
  uiLayout?: GrokUILayout;
  thinkingStartTime?: string; // ISO 8601
  thinkingEndTime?: string; // ISO 8601
  citedWebSearchResults: unknown[];
  toolResponses: unknown[];
  model: string;
  requestMetadata?: GrokRequestMetadata;
  ragResults: unknown[];
  citedRagResults: unknown[];
  searchProductResults: unknown[];
  connectorSearchResults: unknown[];
  collectionSearchResults: unknown[];
}

/**
 * Load responses response
 */
export interface GrokLoadResponsesResponse {
  responses: GrokResponse[];
}

/**
 * Combined extraction result
 */
export interface GrokRawExtraction {
  conversation: GrokConversation;
  responseNodes: GrokResponseNode[];
  responses: GrokResponse[];
}
