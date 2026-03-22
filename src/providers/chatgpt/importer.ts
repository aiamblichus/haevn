import type { Entry } from "@zip.js/zip.js";
import { arrayBufferToBase64 } from "../../utils/binary_utils";
import { log } from "../../utils/logger";
import { createZipReader, readEntryArrayBuffer, readEntryText } from "../../utils/zipReader";
import type { ChatGPTAssetsMap, OpenAIConversation, OpenAIConversationNode } from "./model";

function guessMimeFromFilename(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  if (n.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

function guessMimeFromBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "application/octet-stream";
}

interface AssetIndex {
  // Top-level assets like file-<id>-*.ext
  topLevelByPrefix: Map<string, Entry[]>; // key: file-<id>
  // Assets from dalle-generations/ directory
  dalleGenerationsByPrefix: Map<string, Entry[]>; // key: file-<id>
  // Assets from user-*/ subdirectories (sediment:// files)
  userSubdirEntries: Entry[];
}

async function buildAssetIndex(entries: Entry[]): Promise<AssetIndex> {
  const topLevelByPrefix = new Map<string, Entry[]>();
  const dalleGenerationsByPrefix = new Map<string, Entry[]>();
  const userSubdirEntries: Entry[] = [];

  for (const entry of entries) {
    if (entry.directory) continue;
    const path = entry.filename;
    const parts = path.split("/");
    const isTopLevel = parts.length === 1;
    const name = parts[parts.length - 1];

    if (isTopLevel && name.startsWith("file-")) {
      // Top-level files: file-<id>-*.ext (may lack extension in newer exports)
      const idx = name.indexOf("-");
      const idx2 = name.indexOf("-", idx + 1);
      const idPrefix = idx2 > 0 ? name.substring(0, idx2) : name.replace(/\.[^.]+$/, "");
      const arr = topLevelByPrefix.get(idPrefix) || [];
      arr.push(entry);
      topLevelByPrefix.set(idPrefix, arr);
    } else if (parts[0] === "dalle-generations" && name.startsWith("file-")) {
      // dalle-generations files: file-<id>-*.webp
      const idx = name.indexOf("-");
      const idx2 = name.indexOf("-", idx + 1);
      const idPrefix = idx2 > 0 ? name.substring(0, idx2) : name.replace(/\.[^.]+$/, "");
      const arr = dalleGenerationsByPrefix.get(idPrefix) || [];
      arr.push(entry);
      dalleGenerationsByPrefix.set(idPrefix, arr);
    } else if (name.startsWith("file_")) {
      // sediment:// files: either in user-*/ subdirectories or at top-level in newer exports
      userSubdirEntries.push(entry);
    }
  }

  return { topLevelByPrefix, dalleGenerationsByPrefix, userSubdirEntries };
}

function collectAssetPointers(conv: OpenAIConversation): string[] {
  const pointers = new Set<string>();
  Object.values(conv.mapping || {}).forEach((node: OpenAIConversationNode) => {
    const msg = node.message;
    if (!msg?.content) return;
    const content = msg.content as { parts?: unknown[] } | undefined;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const p of parts) {
      if (
        p &&
        typeof p === "object" &&
        p.content_type === "image_asset_pointer" &&
        typeof p.asset_pointer === "string"
      ) {
        pointers.add(p.asset_pointer);
      }
    }
  });
  return Array.from(pointers);
}

async function resolveAssetFromZip(
  pointer: string,
  index: AssetIndex,
): Promise<{ entry: Entry | null; filename?: string }> {
  try {
    if (pointer.startsWith("file-service://")) {
      const id = pointer.replace("file-service://", "").trim(); // e.g., file-1b1VY1i... or file-ABC123
      const prefix = id; // entries indexed by prefix file-<id>

      // First try top-level files (user-uploaded images)
      let arr = index.topLevelByPrefix.get(prefix);
      if (arr && arr.length > 0) {
        const chosen = arr[0];
        const filename = chosen.filename.split("/").pop();
        log.info(`[Importer][ChatGPT] Resolved ${pointer} -> ${chosen.filename} (top-level)`);
        return { entry: chosen, filename };
      }

      // Then try dalle-generations (DALL-E images can use file-service:// too)
      arr = index.dalleGenerationsByPrefix.get(prefix);
      if (arr && arr.length > 0) {
        const chosen = arr[0];
        const filename = chosen.filename.split("/").pop();
        log.info(
          `[Importer][ChatGPT] Resolved ${pointer} -> ${chosen.filename} (dalle-generations)`,
        );
        return { entry: chosen, filename };
      }

      log.warn(`[Importer][ChatGPT] Asset not found for pointer: ${pointer}`);
    } else if (pointer.startsWith("sediment://")) {
      const id = pointer.replace("sediment://", "").trim(); // often like file_<hex>
      // Search in user-*/ subdirectories (where sediment:// files are typically stored)
      let chosen: Entry | null = null;
      for (const e of index.userSubdirEntries) {
        const base = e.filename.split("/").pop() || e.filename;
        if (base.includes(id) || e.filename.includes(id)) {
          chosen = e;
          break;
        }
      }
      if (chosen) {
        const filename = chosen.filename.split("/").pop();
        log.info(`[Importer][ChatGPT] Resolved ${pointer} -> ${chosen.filename} (user subdir)`);
        return { entry: chosen, filename };
      }

      log.warn(`[Importer][ChatGPT] Asset not found for sediment pointer: ${pointer}`);
    }
  } catch (e) {
    log.warn("[Importer][ChatGPT] Asset resolve failed for", pointer, e);
  }
  return { entry: null };
}

export interface ParsedOpenAIItem {
  conversation: OpenAIConversation;
  assets: ChatGPTAssetsMap;
}

/**
 * Load all conversations from the ZIP, supporting both the legacy single-file format
 * (conversations.json) and the new sharded format (conversations-000.json, conversations-001.json, …).
 */
async function loadConversationsFromEntries(entries: Entry[]): Promise<OpenAIConversation[]> {
  // Try legacy single-file first
  const single = entries.find(
    (e) => !e.directory && e.filename.toLowerCase() === "conversations.json",
  );
  if (single) {
    const text = await readEntryText(single);
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as OpenAIConversation[];
    if (Array.isArray(parsed?.conversations)) return parsed.conversations as OpenAIConversation[];
    throw new Error("Invalid conversations.json");
  }

  // New sharded format: conversations-000.json, conversations-001.json, …
  const shards = entries
    .filter((e) => !e.directory && /^conversations-\d+\.json$/i.test(e.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  if (shards.length === 0) throw new Error("No conversations found in backup");

  const all: OpenAIConversation[] = [];
  for (const shard of shards) {
    const text = await readEntryText(shard);
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) all.push(...(parsed as OpenAIConversation[]));
  }
  return all;
}

/**
 * Parse a ChatGPT backup ZIP and lazily provide conversation + assets for import.
 * Supports both legacy single-file (conversations.json) and new sharded format
 * (conversations-NNN.json). Assets referenced via `file-service://` are at the root
 * as `file-<id>-*.(png|jpg|…)` (with or without extension). Assets referenced via
 * `sediment://` live under user-* subdirectories or at the root (new format).
 */
export async function* parseChatGPTBackupZip(
  fileOrBuffer: File | ArrayBuffer,
): AsyncGenerator<ParsedOpenAIItem> {
  const reader = createZipReader(fileOrBuffer);
  let entries: Entry[] = [];
  try {
    entries = await reader.getEntries();
    let conversations: OpenAIConversation[] = [];
    try {
      conversations = await loadConversationsFromEntries(entries);
    } catch (_e) {
      throw new Error("conversations.json not found in backup");
    }

    const index = await buildAssetIndex(entries);

    for (const conv of conversations) {
      const pointers = collectAssetPointers(conv);
      const assets: ChatGPTAssetsMap = {};
      for (const ptr of pointers) {
        const { entry, filename } = await resolveAssetFromZip(ptr, index);
        if (!entry) continue;
        try {
          const buf = await readEntryArrayBuffer(entry);
          const base64 = arrayBufferToBase64(buf);
          const name = filename || entry.filename.split("/").pop() || "asset";
          const mimeFromName = guessMimeFromFilename(name);
          assets[ptr] = {
            dataBase64: base64,
            contentType:
              mimeFromName === "application/octet-stream" ? guessMimeFromBytes(buf) : mimeFromName,
            filename: name,
          };
        } catch (e) {
          log.warn("[Importer][ChatGPT] Failed to read asset", entry.filename, e);
        }
      }
      yield { conversation: conv, assets };
    }
  } finally {
    await reader.close();
  }
}

export async function countConversationsInZip(fileOrBuffer: File | ArrayBuffer): Promise<number> {
  const reader = createZipReader(fileOrBuffer);
  try {
    const entries = await reader.getEntries();
    try {
      const conversations = await loadConversationsFromEntries(entries);
      return conversations.length;
    } catch {
      return 0;
    }
  } finally {
    await reader.close();
  }
}
