/**
 * CLI-specific types for the HAEVN CLI tool.
 * Types shared with the extension are defined in ./chat.ts.
 */

// Re-export canonical types from local copy (mirrored from the extension)
export type {
  Chat,
  ChatMessage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  SearchResult,
} from "./types/chat";

/**
 * Distributed Omit – correctly strips a key from every member of a union type.
 * TypeScript's built-in `Omit<A | B, K>` collapses to a single object type;
 * this helper preserves the discriminated union structure.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** CliRequest without the `id` field – used as the parameter type for daemonRequest(). */
export type CliRequestBody = DistributiveOmit<CliRequest, "id">;

/**
 * Options for formatting output
 */
export type OutputFormat = "text" | "json";

/**
 * Request sent from a CLI command to the daemon over the Unix socket.
 * Every request carries a unique `id` so the daemon can correlate responses
 * when multiple CLI clients are connected simultaneously.
 */
export type CliRequest =
  | { id: string; action: "search"; query: string; options?: SearchOptions }
  | { id: string; action: "get"; chatId: string; options?: GetOptions }
  | { id: string; action: "list"; options?: ListOptions }
  | { id: string; action: "branches"; chatId: string }
  | { id: string; action: "export"; chatId: string; options?: ExportOptions }
  | {
      id: string;
      action: "import";
      format: ImportFormat;
      files: ImportFilePayload[];
      options?: ImportOptions;
    }
  | { id: string; action: "getMetadata"; chatId: string }
  | { id: string; action: "setMetadata"; chatId: string; metadata: MetadataUpdate }
  | { id: string; action: "generateMetadata"; chatId: string }
  | { id: string; action: "health"; options?: HealthOptions };

/**
 * The pipe: how bulk bytes cross the daemon (HVN-133). A frame is still one JSON message; the
 * bytes of a file or a chat record go by HTTP, through the daemon, between the CLI's open
 * request and the extension's `fetch`.
 *
 *   POST /pipe/out            the CLI asks, a byte stream comes back (extension → CLI)
 *   POST /pipe/in             the CLI sends a byte stream (CLI → extension), a frame comes back
 *   POST|GET /pipe/<pipeId>   the extension's side of the same request
 *
 * Every call carries `Authorization: Bearer <apiKey>`.
 */

/** 128 random bits as 32 hex digits. Valid for one request of the extension's, then gone. */
export type PipeId = string;

/**
 * What the CLI sends to open a pipe: any action, with its own fields. On `/pipe/in` the action
 * travels in a header, which is latin-1: escape every non-ASCII character as `\uXXXX`.
 */
export interface PipeActionBody {
  action: string;
  [field: string]: unknown;
}

/** The frame the daemon forwards to the extension for a pipe action: the CLI's body, an `id` and a `pipeId`. */
export type PipeForwardedRequest = PipeActionBody & { id: string; pipeId: PipeId };

/** What the daemon itself says when it fails a pipe request (no extension, a bad body, a timeout, a cut stream). */
export interface DaemonErrorBody {
  ok: false;
  error: string;
}

/** `GET /health`, no key needed. `pipe` is the pipe protocol the daemon speaks; absent on an older daemon. */
export interface HealthResponse {
  ok: true;
  extensionConnected: boolean;
  pipe?: number;
}

/** What `haevn health` asks the extension for. */
export interface HealthOptions {
  /** Provider names; omitted means every web provider. */
  providers?: string[];
  /** Chats to fetch from the head of each list (1 to 5, default 2). */
  chats?: number;
  /** The limit for one provider, in ms. */
  timeoutMs?: number;
  /** The limit for the whole run, in ms. */
  totalMs?: number;
}

export type HealthStatus =
  | "ok"
  | "warn"
  | "fail"
  | "not-signed-in"
  | "unreachable"
  | "timeout"
  | "skipped";

export interface HealthFinding {
  code: string;
  level: "fail" | "warn";
  message: string;
  count: number;
  chats: number;
}

export interface HealthRow {
  provider: string;
  signedIn: boolean | null;
  listed: number | null;
  checked: number;
  status: HealthStatus;
  findings: HealthFinding[];
  shapes: {
    messages: number;
    userTurns: number;
    modelTurns: number;
    parts: Record<string, number>;
  }[];
  note?: string;
  ms: number;
}

/** The reply to `health`: counts, kinds and rule names; never chat text, a title or an id. */
export interface HealthReport {
  extensionVersion: string;
  startedAt: string;
  ms: number;
  rows: HealthRow[];
}

export interface SearchOptions {
  platform?: string;
  category?: string;
  after?: string; // ISO date
  before?: string; // ISO date
  limit?: number;
  contextChars?: number;
  includeMetadata?: boolean;
}

export interface GetOptions {
  messageId?: string;
  includeMetadata?: boolean;
  includeMedia?: boolean;
}

export interface ListOptions {
  platform?: string;
  limit?: number;
  /** Chats to skip before the page; the response's hasMore says whether chats follow it. */
  offset?: number;
  after?: string;
  sortBy?: "lastSynced" | "title" | "messageCount";
  /**
   * Metadata keys to include for each chat. CLI-friendly aliases:
   *   - "description"  → metadata.description
   *   - "synopsis"     → metadata.synopsis
   *   - "categories"     → metadata.categories
   *   - "keywords"     → metadata.keywords
   * The CLI expands "all" to the four concrete keys before sending.
   */
  includeMetadata?: ListMetadataKey[];
}

export type ListMetadataKey = "description" | "synopsis" | "categories" | "keywords";

export interface ExportOptions {
  includeMedia?: boolean;
  /** Markdown only: write every branch, not only the current one. */
  allBranches?: boolean;
  exporterId?: "haevn_json" | "haevn_markdown" | "pi_session_jsonl";
  format?: "json" | "markdown" | "md" | "pi" | "jsonl" | "haevn_json" | "haevn_markdown";
}

export type ImportFormat =
  | "claude_code"
  | "codex"
  | "pi"
  | "openrouter"
  | "haevn_json"
  | "markdown"
  | "image"
  | "video";

export interface ImportFilePayload {
  name: string;
  content: string;
}

export interface ImportOptions {
  overwrite?: boolean;
  skipIndex?: boolean;
}

export interface MetadataUpdate {
  title?: string;
  description?: string;
  synopsis?: string;
  categories?: string[];
  keywords?: string[];
}

export interface ChatMetadataRecord {
  chatId: string;
  title: string;
  description: string;
  synopsis: string;
  categories: string[];
  keywords: string[];
  source: "manual" | "ai" | "unset";
  generatedAt?: number;
  updatedAt: number;
}

export interface ImportResult {
  format: ImportFormat;
  /** The number of chats the files held, which `processed` counts up to (not the number of files). */
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
  /** Set when the chats were saved but the search index could not be brought up to date. */
  indexError?: string;
}

/**
 * Response from the daemon (originally from the extension) back to the CLI command.
 * The `id` matches the originating request so the daemon can route to the right caller.
 */
export type CliResponse<T = unknown> =
  | {
      id: string;
      success: true;
      data: T;
      /** A search only: more chats matched than the limit let through. */
      hasMore?: boolean;
    }
  | { id: string; success: false; error: string; code?: string };

/**
 * Branch info for the branches command
 */
export interface BranchInfo {
  /** Message ID at the end of this branch */
  leafMessageId: string;
  /** Path from root to leaf (message IDs) */
  path: string[];
  /** Number of messages in this branch */
  messageCount: number;
  /** First user prompt in this branch */
  firstPrompt?: string;
  /** Whether this is the primary (default) branch */
  isPrimary: boolean;
}

/**
 * Tree visualization node
 */
export interface TreeNode {
  messageId: string;
  role: "system" | "user" | "assistant";
  preview: string;
  isLeaf: boolean;
  isOnPrimaryPath: boolean;
  children: TreeNode[];
}
