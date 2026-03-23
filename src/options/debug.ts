/**
 * @file Debug utility for HAEVN extension
 * @description Exposes a global haevnDebug object for easier interaction from the browser console/subagent
 */

import { HaevnDatabase } from "../services/db";
import type {
  BackgroundRequest,
  BackgroundResponse,
  LogFilter,
  LogLevel,
} from "../types/messaging";

// Expose database instance for debugging
const db = new HaevnDatabase();

import * as opfsUtils from "../utils/opfs";

export const haevnDebug = {
  /**
   * Generic message sender to background handlers.
   * Usage: haevnDebug.send("resumeBulkSync", { provider: "claude" })
   */
  async send(action: string, payload: Record<string, unknown> = {}) {
    return chrome.runtime.sendMessage({ action, ...payload } as unknown as BackgroundRequest);
  },

  /**
   * Direct database access for debugging
   * Usage: haevnDebug.db.chats.get(chatId)
   */
  db,
  /**
   * Fetch the last n logs with optional filtering
   */
  async getLogs(n = 50, filter: LogFilter & { match?: string } = {}) {
    try {
      const { match, ...baseFilter } = filter;
      const response = (await chrome.runtime.sendMessage({
        action: "getLogs",
        filter: baseFilter,
      } as BackgroundRequest)) as BackgroundResponse;

      if (response.success && "logs" in response) {
        let logs = response.logs;

        if (match) {
          const regex = new RegExp(match, "i");
          logs = logs.filter(
            (l) => regex.test(l.message) || (l.data && regex.test(JSON.stringify(l.data))),
          );
        }

        logs = logs.slice(-n);

        console.table(
          logs.map((l) => ({
            time: new Date(l.timestamp).toLocaleTimeString(),
            level: l.level,
            context: l.context,
            message: l.message,
            data: l.data ? JSON.stringify(l.data) : "",
          })),
        );
        return logs;
      }
      return response;
    } catch (err) {
      console.error("Debug: getLogs failed", err);
      return { success: false, error: String(err) };
    }
  },

  /**
   * Clear all logs
   */
  async clearLogs() {
    console.log("Debug: Clearing logs...");
    return chrome.runtime.sendMessage({ action: "clearLogs" } as BackgroundRequest);
  },

  /**
   * Set minimum log level (0=DEBUG, 1=INFO, 2=WARN, 3=ERROR)
   */
  async setLogLevel(level: LogLevel) {
    console.log(`Debug: Setting log level to ${level}`);
    return chrome.runtime.sendMessage({
      action: "setLoggerConfig",
      config: { minLevel: level },
    } as BackgroundRequest);
  },

  /**
   * Get provider statistics
   */
  async getStats() {
    return chrome.runtime.sendMessage({ action: "getMediaStats" } as BackgroundRequest);
  },

  /**
   * Get a chat by ID
   */
  async getChat(chatId: string) {
    console.log(`Debug: Fetching chat ${chatId}...`);
    const chat = await db.chats.get(chatId);
    if (chat) {
      const storedRows = await db.chatMessages.where("chatId").equals(chatId).toArray();
      const messages =
        storedRows.length > 0 ? storedRows : Object.values(chat.messages || {});
      console.log("Chat found:", chat);
      console.log(`  Title: ${chat.title}`);
      console.log(`  Source: ${chat.source}`);
      console.log(`  Messages: ${messages.length}`);
      const roots = messages.filter((m) => m.parentId === null).length;
      console.log(`  Root messages: ${roots}`);
      const totalParts = messages.reduce((sum, m) => {
        const messageParts =
          m.message?.reduce((acc, msg) => acc + (msg.parts?.length ?? 0), 0) ?? 0;
        return sum + messageParts;
      }, 0);
      console.log(`  Total parts: ${totalParts}`);
    } else {
      console.log("Chat not found");
    }
    return chat;
  },

  /**
   * One-off migration: move inline chat.messages into chatMessages table.
   * Safe to run multiple times.
   */
  async migrateMessagesToTable(batchSize = 20) {
    const total = await db.chats.count();
    let offset = 0;
    let migratedChats = 0;
    let migratedMessages = 0;

    console.log(`[MessagesMigration] Starting one-off migration over ${total} chats...`);

    while (offset < total) {
      const chats = await db.chats.offset(offset).limit(batchSize).toArray();
      if (chats.length === 0) break;

      for (const chat of chats) {
        if (!chat.id) continue;
        const inlineMessages = Object.values(chat.messages || {}).map((message) => ({
          ...message,
          chatId: chat.id as string,
        }));
        if (inlineMessages.length === 0) continue;

        await db.transaction("rw", db.chats, db.chatMessages, async () => {
          await db.chatMessages.where("chatId").equals(chat.id as string).delete();
          await db.chatMessages.bulkPut(inlineMessages);
          await db.chats.update(chat.id as string, { messages: {} });
        });

        migratedChats += 1;
        migratedMessages += inlineMessages.length;
      }

      offset += chats.length;
      console.log(`[MessagesMigration] Progress: ${Math.min(offset, total)}/${total} chats scanned`);
    }

    console.log(
      `[MessagesMigration] Done. Migrated ${migratedChats} chats and ${migratedMessages} messages.`,
    );
    return { scanned: total, migratedChats, migratedMessages };
  },

  /**
   * Search across all chats
   */
  async search(query: string) {
    console.log(`Debug: Searching for "${query}"...`);
    const response = (await chrome.runtime.sendMessage({
      action: "searchChats",
      query,
    } as BackgroundRequest)) as BackgroundResponse;

    if (response.success && "results" in response) {
      console.table(response.results);
    }
    return response;
  },

  /**
   * Dump local storage
   */
  async getStorage() {
    const data = await chrome.storage.local.get();
    console.log("Storage Dump:", data);
    return data;
  },

  /**
   * Rebuild the entire search index from the database
   */
  async rebuildIndex() {
    console.log("Debug: Rebuilding search index...");
    return chrome.runtime.sendMessage({ action: "rebuildIndex" } as BackgroundRequest);
  },

  /**
   * Clear all thumbnails and regenerate them from scratch.
   * Useful for testing new thumbnail generation logic (like video support).
   */
  async regenerateThumbnails() {
    console.log("Debug: Clearing existing thumbnails and regenerating...");
    try {
      // 1. Clear tables
      await db.transaction("rw", [db.thumbnails, db.mediaContent], async () => {
        await db.thumbnails.clear();
        await db.mediaContent.clear();
      });
      console.log("✅ Thumbnails and mediaContent tables cleared.");

      // 2. Trigger check for missing thumbnails (which will now be all of them)
      const response = (await chrome.runtime.sendMessage({
        action: "checkMissingThumbnails",
      } as BackgroundRequest)) as BackgroundResponse;

      if (response.success && "count" in response) {
        console.log(`🚀 Thumbnail regeneration started for ${response.count} chats.`);
        console.log("Check background logs for progress.");
      } else if (response.success) {
        console.log("🚀 Thumbnail regeneration started.");
        console.log("Check background logs for progress.");
      } else {
        console.error("❌ Failed to trigger thumbnail regeneration:", response.error);
      }
      return response;
    } catch (err) {
      console.error("Debug: regenerateThumbnails failed", err);
      return { success: false, error: String(err) };
    }
  },

  /**
   * OPFS Management and Inspection
   */
  opfs: {
    /** List entries in a directory */
    async ls(path = "") {
      try {
        const files = await opfsUtils.listFiles(path);
        const dirs = await opfsUtils.listDirectories(path);
        const results = [];

        for (const d of dirs) {
          results.push({ name: `${d}/`, type: "directory", size: "-" });
        }

        for (const f of files) {
          const fullPath = path ? `${path}/${f}` : f;
          const meta = await opfsUtils.getFileMetadata(fullPath);
          results.push({
            name: f,
            type: "file",
            size: meta ? `${(meta.size / 1024).toFixed(2)} KB` : "?",
            lastModified: meta ? new Date(meta.lastModified).toLocaleString() : "?",
          });
        }

        console.table(results);
        return results;
      } catch (err) {
        console.error("Debug: opfs.ls failed", err);
      }
    },

    /** Recursive tree view of OPFS */
    async tree(path = "", maxDepth = 5) {
      try {
        const root = await opfsUtils.getOPFSRoot();
        const segments = path ? path.split("/").filter(Boolean) : [];
        let current: FileSystemDirectoryHandle = root;

        for (const seg of segments) {
          current = await current.getDirectoryHandle(seg);
        }

        async function walk(
          handle: FileSystemDirectoryHandle | FileSystemFileHandle,
          depth: number,
        ): Promise<{
          name: string;
          type: string;
          size?: number;
          status?: string;
          children?: unknown[];
        }> {
          if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            return { name: handle.name, type: "file", size: file.size };
          }

          if (depth >= maxDepth) {
            return { name: handle.name, type: "directory", status: "truncated" };
          }

          const children = [];
          // @ts-expect-error - entries() is in standard FileSystemDirectoryHandle
          for await (const [_name, subHandle] of (handle as FileSystemDirectoryHandle).entries()) {
            children.push(await walk(subHandle, depth + 1));
          }
          return { name: handle.name || "/", type: "directory", children };
        }

        const result = await walk(current, 0);
        console.log(JSON.stringify(result, null, 2));
        return result;
      } catch (err) {
        console.error("Debug: opfs.tree failed", err);
      }
    },

    /** Read file content as text (with truncation) */
    async cat(path: string, length = 5000) {
      try {
        const buffer = await opfsUtils.readFile(path);
        const dec = new TextDecoder();
        const text = dec.decode(buffer.slice(0, length));
        console.log(`--- Content of ${path} (${buffer.byteLength} bytes) ---`);
        console.log(text);
        if (buffer.byteLength > length) {
          console.log(`... [truncated, ${buffer.byteLength - length} more bytes]`);
        }
        return text;
      } catch (err) {
        console.error("Debug: opfs.cat failed", err);
      }
    },

    /** Delete a file */
    async rm(path: string) {
      const success = await opfsUtils.deleteFile(path);
      console.log(success ? `✅ Deleted file: ${path}` : `❌ Failed to delete file: ${path}`);
      return success;
    },

    /** Delete a directory recursively */
    async rmdir(path: string) {
      const success = await opfsUtils.deleteDirectory(path);
      console.log(
        success ? `✅ Deleted directory: ${path}` : `❌ Failed to delete directory: ${path}`,
      );
      return success;
    },

    /** Show OPFS storage usage and quota */
    async usage() {
      if (!navigator.storage || !navigator.storage.estimate) {
        console.error("Storage estimation API not available");
        return;
      }
      const estimate = await navigator.storage.estimate();
      const usageMB = (estimate.usage || 0) / (1024 * 1024);
      const quotaMB = (estimate.quota || 0) / (1024 * 1024);
      const percent = ((usageMB / (quotaMB || 1)) * 100).toFixed(2);

      console.log(
        "%c OPFS Storage Estimate ",
        "background: #1e3a8a; color: #white; font-weight: bold;",
      );
      console.log(`  Usage: ${usageMB.toFixed(2)} MB`);
      console.log(`  Quota: ${quotaMB.toFixed(2)} MB`);
      console.log(`  Used:  ${percent}%`);
      return estimate;
    },

    /** Download a file from OPFS to local disk */
    async download(path: string) {
      try {
        const file = await opfsUtils.getFile(path);
        if (!file) {
          console.error(`File not found: ${path}`);
          return;
        }
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = path.split("/").pop() || "download";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`✅ Download initiated for: ${path}`);
      } catch (err) {
        console.error("Debug: opfs.download failed", err);
      }
    },
  },

  /**
   * Show help
   */
  help() {
    console.log("HAEVN Debug Portal Commands:");
    console.log("  haevnDebug.send(action, payload) - Generic background action sender");
    console.log("  haevnDebug.db                - Direct Dexie database access");
    console.log("                                 e.g. haevnDebug.db.chats.get(id)");
    console.log(
      "  haevnDebug.getLogs(n, filter) - n: number of logs, filter: { level, context, match }",
    );
    console.log("  haevnDebug.clearLogs()       - Clears entries in background");
    console.log("  haevnDebug.setLogLevel(l)    - 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR");
    console.log("  haevnDebug.getStats()        - Shows media/database stats");
    console.log("  haevnDebug.getChat(id)       - Get a chat by ID with summary");
    console.log("  haevnDebug.migrateMessagesToTable(batchSize?) - One-off DB v17 migration");
    console.log("  haevnDebug.search(q)         - Performs a detailed search");
    console.log("  haevnDebug.rebuildIndex()    - Rebuilds search index from scratch");
    console.log("  haevnDebug.regenerateThumbnails() - Clears and regenerates all thumbnails");
    console.log("  haevnDebug.getStorage()      - Dumps chrome.storage.local");
    console.log("  haevnDebug.opfs.ls(path)     - List OPFS directory");
    console.log("  haevnDebug.opfs.tree(path)   - Recursive tree view");
    console.log("  haevnDebug.opfs.cat(path)    - Read file content");
    console.log("  haevnDebug.opfs.usage()      - Show storage stats");
    console.log("  haevnDebug.opfs.download(p)  - Download file from OPFS");
    console.log("  haevnDebug.opfs.rm(p)        - Delete file");
    console.log("  haevnDebug.opfs.rmdir(p)     - Delete directory recursively");
    console.log("  haevnDebug.reload()          - Reloads the entire extension");
    console.log("  haevnDebug.help()            - Show this help");
  },

  /**
   * Reload the entire extension
   */
  reload() {
    console.log("Debug: Reloading extension...");
    chrome.runtime.reload();
  },
};

declare global {
  interface Window {
    haevnDebug: typeof haevnDebug;
  }
}

// Expose to window
if (typeof window !== "undefined") {
  window.haevnDebug = haevnDebug;
  console.log(
    "%c HAEVN Debug Portal Loaded ",
    "background: #134e4a; color: #5eead4; font-weight: bold;",
  );
  console.log(
    "Use %chaevnDebug%c to access debugging tools.",
    "color: #5eead4; font-weight: bold;",
    "",
  );
}
