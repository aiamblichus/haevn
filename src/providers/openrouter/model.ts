/**
 * Type definitions for the OpenRouter chatroom export (`version: "orpg.3.0"`).
 *
 * An export is `{ version, rooms }`. A room holds its messages and its items (the text and
 * reasoning blocks a message is made of) in maps keyed by id. Every field is optional here: the
 * file is read as written by a web app we do not control, so the transformer checks what it uses.
 */

export interface OpenRouterCharacter {
  id?: string;
  /** The model slug, e.g. "vendor/model". */
  model?: string;
  name?: string | null;
  description?: string;
  samplingParameters?: Record<string, unknown>;
  reasoning?: Record<string, unknown> | null;
  isDisabled?: boolean;
  isRemoved?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A reference from a message to one of the room's items. */
export interface OpenRouterItemRef {
  id: string;
  type?: "message" | "reasoning" | string;
}

export interface OpenRouterCitation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    content?: string;
    start_index?: number;
    end_index?: number;
  };
  [key: string]: unknown;
}

export interface OpenRouterMessageMetadata {
  requestedModel?: string;
  variantSlug?: string;
  provider?: string;
  generationId?: string;
  /** Dollars, as a decimal string. */
  cost?: string;
  tokensCount?: number;
  tokensPerSecond?: number;
  /** Milliseconds. */
  duration?: number;
  generateDuration?: number;
  latencyDuration?: number;
  routerMetadata?: {
    region?: string;
    is_byok?: boolean;
    endpoints?: {
      available?: Array<{ model?: string; provider?: string; selected?: boolean }>;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenRouterMessage {
  id: string;
  /** Absent on a user message; an assistant message points at the user message it answers. */
  parentMessageId?: string;
  type: "user" | "assistant" | string;
  characterId?: string;
  /** The thread the message belongs to ("main-chat" in every export seen so far). */
  context?: string;
  contentType?: string;
  createdAt?: string;
  updatedAt?: string;
  isGenerating?: boolean;
  items?: OpenRouterItemRef[];
  metadata?: OpenRouterMessageMetadata;
  citations?: OpenRouterCitation[];
  attachments?: unknown[];
  files?: unknown[];
  images?: unknown[];
  [key: string]: unknown;
}

export interface OpenRouterContentBlock {
  /** input_text (user), output_text (assistant) or reasoning_text (reasoning). */
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  }>;
  [key: string]: unknown;
}

export interface OpenRouterItemData {
  type?: "message" | "reasoning" | string;
  id?: string;
  role?: string;
  status?: string;
  content?: OpenRouterContentBlock[];
  /** A reasoning item may hold only this: opaque, not readable. */
  encrypted_content?: string;
  summary?: Array<{ text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface OpenRouterItem {
  id: string;
  messageId?: string;
  data?: OpenRouterItemData;
}

export interface OpenRouterRoom {
  title?: string;
  characters?: Record<string, OpenRouterCharacter>;
  messages?: Record<string, OpenRouterMessage>;
  items?: Record<string, OpenRouterItem>;
  artifacts?: Record<string, unknown>;
  artifactFiles?: Record<string, unknown>;
  artifactVersions?: Record<string, unknown>;
  artifactFileContents?: Record<string, unknown>;
}

/** The parsed export file. One extraction holds every room (chat) of the file. */
export interface OpenRouterRawExtraction {
  version: string;
  rooms: OpenRouterRoom[];
}
