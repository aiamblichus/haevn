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
 * CLI configuration stored in ~/.haevn/config.json
 */
export interface CliConfig {
  /** Path to exported HAEVN data file (for file-based mode) */
  dataFile?: string;
  /** Extension ID for native messaging */
  extensionId?: string;
  /** Native host name (must match manifest) */
  nativeHostName?: string;
}

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
    };

export interface SearchOptions {
  platform?: string;
  after?: string; // ISO date
  before?: string; // ISO date
  limit?: number;
  contextChars?: number;
}

export interface GetOptions {
  messageId?: string;
  includeMetadata?: boolean;
  includeMedia?: boolean;
}

export interface ListOptions {
  platform?: string;
  limit?: number;
  after?: string;
  sortBy?: "lastSynced" | "title" | "messageCount";
}

export interface ExportOptions {
  includeMedia?: boolean;
}

export type ImportFormat = "claude_code" | "codex" | "pi";

export interface ImportFilePayload {
  name: string;
  content: string;
}

export interface ImportOptions {
  overwrite?: boolean;
  skipIndex?: boolean;
}

export interface ImportResult {
  format: ImportFormat;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
}

/**
 * Response from the daemon (originally from the extension) back to the CLI command.
 * The `id` matches the originating request so the daemon can route to the right caller.
 */
export type CliResponse<T = unknown> =
  | { id: string; success: true; data: T }
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
