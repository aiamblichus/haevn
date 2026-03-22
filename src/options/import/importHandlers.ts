import type { Chat, HAEVN } from "../../model/haevn_model";
import { countConversationsInZip, parseChatGPTBackupZip } from "../../providers/chatgpt/importer";
import { transformOpenAIToHaevn } from "../../providers/chatgpt/transformer";
import {
  countClaudeConversationsInZip,
  parseClaudeBackupZip,
} from "../../providers/claude/importer";
import type { ChatTranscript, Project } from "../../providers/claude/model";
import { convertClaudeTranscriptToHaevn, hasTextContent } from "../../providers/claude/transformer";
import {
  countOpenWebUIConversationsInFile,
  countOpenWebUIConversationsInZip,
  parseOpenWebUIBackupFile,
  parseOpenWebUIBackupZip,
} from "../../providers/openwebui/importer";
import type { OpenWebUIChatResponse } from "../../providers/openwebui/model";
import { transformOpenWebUIToHaevn } from "../../providers/openwebui/transformer";
import { parseMarkdownFile } from "../../utils/markdownImporter";
import type { StatusKind } from "../types";

interface ImportProgress {
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
}

interface ImportCallbacks {
  setStatus: (text: string, kind?: StatusKind) => void;
  setImportProgress: (progress: ImportProgress) => void;
  loadChats: () => void;
}

import type { ParsedOpenAIItem } from "../../providers/chatgpt/importer";

export const doOpenAIImport = async (
  total: number,
  gen: AsyncGenerator<ParsedOpenAIItem>,
  importOverwrite: boolean,
  callbacks: ImportCallbacks,
) => {
  const { setStatus, setImportProgress, loadChats } = callbacks;
  setImportProgress({
    total,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
  });

  // Enable bulk indexing mode for efficient import
  await chrome.runtime.sendMessage({ action: "startBulkIndexing" });

  let processed = 0,
    saved = 0,
    skipped = 0,
    errors = 0;
  for await (const item of gen) {
    processed++;
    try {
      const chat = transformOpenAIToHaevn({
        conversation: item.conversation,
        assets: item.assets,
      });
      if (!importOverwrite) {
        try {
          const existsResp = await chrome.runtime.sendMessage({
            action: "existsChat",
            chatId: chat.id,
          });
          if (existsResp?.success && existsResp.exists) {
            skipped++;
            setImportProgress({
              total,
              processed,
              saved,
              skipped,
              errors,
            });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      const resp = await chrome.runtime.sendMessage({
        action: "saveImportedChat",
        chat,
        raw: item.conversation,
        skipIndexing: true,
      });
      if (!resp?.success) throw new Error(resp?.error || "Save failed");
      saved++;
    } catch (_e) {
      errors++;
    }
    setImportProgress({
      total,
      processed,
      saved,
      skipped,
      errors,
    });
  }

  // Finish bulk indexing - rebuild index once with all imported chats
  await chrome.runtime.sendMessage({ action: "finishBulkIndexing" });

  setStatus(
    `Import complete. Saved ${saved}, skipped ${skipped}, errors ${errors}.`,
    errors ? "warn" : "ok",
  );
  loadChats();
};

export const doOpenWebUIImport = async (
  total: number,
  gen: AsyncGenerator<{ conversation: OpenWebUIChatResponse }>,
  importOverwrite: boolean,
  callbacks: ImportCallbacks,
) => {
  const { setStatus, setImportProgress, loadChats } = callbacks;
  setImportProgress({
    total,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
  });

  // Enable bulk indexing mode for efficient import
  await chrome.runtime.sendMessage({ action: "startBulkIndexing" });

  let processed = 0,
    saved = 0,
    skipped = 0,
    errors = 0;
  for await (const item of gen) {
    processed++;
    try {
      const chat = transformOpenWebUIToHaevn({
        chat: item.conversation,
      }) as Chat;
      if (!importOverwrite) {
        try {
          const existsResp = await chrome.runtime.sendMessage({
            action: "existsChat",
            chatId: chat.id || chat.sourceId,
          });
          if (existsResp?.success && existsResp.exists) {
            skipped++;
            setImportProgress({
              total,
              processed,
              saved,
              skipped,
              errors,
            });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      const resp = await chrome.runtime.sendMessage({
        action: "saveImportedChat",
        chat,
        raw: item.conversation,
        skipIndexing: true,
      });
      if (!resp?.success) throw new Error(resp?.error || "Save failed");
      saved++;
    } catch (_e) {
      errors++;
    }
    setImportProgress({
      total,
      processed,
      saved,
      skipped,
      errors,
    });
  }

  // Finish bulk indexing - rebuild index once with all imported chats
  await chrome.runtime.sendMessage({ action: "finishBulkIndexing" });

  setStatus(
    `Import complete. Saved ${saved}, skipped ${skipped}, errors ${errors}.`,
    errors ? "warn" : "ok",
  );
  loadChats();
};

export const doClaudeImport = async (
  total: number,
  gen: AsyncGenerator<{ conversation: ChatTranscript; projects: Project[] }>,
  importOverwrite: boolean,
  callbacks: ImportCallbacks,
) => {
  const { setStatus, setImportProgress, loadChats } = callbacks;
  setImportProgress({
    total,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
  });

  // Enable bulk indexing mode for efficient import
  await chrome.runtime.sendMessage({ action: "startBulkIndexing" });

  let processed = 0,
    saved = 0,
    skipped = 0,
    errors = 0;
  for await (const item of gen) {
    processed++;
    try {
      const chat = (await convertClaudeTranscriptToHaevn(item.conversation, {
        projects: item.projects,
      })) as Chat;

      // Skip chats without any text content
      if (!hasTextContent(chat as HAEVN.Chat)) {
        skipped++;
        setImportProgress({
          total,
          processed,
          saved,
          skipped,
          errors,
        });
        continue;
      }

      if (!importOverwrite) {
        try {
          const existsResp = await chrome.runtime.sendMessage({
            action: "existsChat",
            chatId: chat.id || chat.sourceId,
          });
          if (existsResp?.success && existsResp.exists) {
            skipped++;
            setImportProgress({
              total,
              processed,
              saved,
              skipped,
              errors,
            });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      const resp = await chrome.runtime.sendMessage({
        action: "saveImportedChat",
        chat,
        raw: item.conversation,
        skipIndexing: true,
      });
      if (!resp?.success) throw new Error(resp?.error || "Save failed");
      saved++;
    } catch (_e) {
      errors++;
    }
    setImportProgress({
      total,
      processed,
      saved,
      skipped,
      errors,
    });
  }

  // Finish bulk indexing - rebuild index once with all imported chats
  await chrome.runtime.sendMessage({ action: "finishBulkIndexing" });

  setStatus(
    `Import complete. Saved ${saved}, skipped ${skipped}, errors ${errors}.`,
    errors ? "warn" : "ok",
  );
  loadChats();
};

export const doMarkdownImport = async (
  file: File,
  importOverwrite: boolean,
  callbacks: ImportCallbacks,
) => {
  const { setStatus, setImportProgress, loadChats } = callbacks;
  setImportProgress({
    total: 1,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
  });
  try {
    const chat = await parseMarkdownFile(file);
    if (!importOverwrite) {
      try {
        const existsResp = await chrome.runtime.sendMessage({
          action: "existsChat",
          chatId: chat.id,
        });
        if (existsResp?.success && existsResp.exists) {
          setImportProgress({
            total: 1,
            processed: 1,
            saved: 0,
            skipped: 1,
            errors: 0,
          });
          setStatus("Import complete. Chat already exists, skipped.", "warn");
          loadChats();
          return;
        }
      } catch {
        /* ignore */
      }
    }
    const resp = await chrome.runtime.sendMessage({
      action: "saveImportedChat",
      chat,
      raw: chat,
    });
    if (!resp?.success) throw new Error(resp?.error || "Save failed");
    setImportProgress({
      total: 1,
      processed: 1,
      saved: 1,
      skipped: 0,
      errors: 0,
    });
    setStatus("Import complete. Saved 1 chat.", "ok");
    loadChats();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Import failed: ${msg}`, "error");
    setImportProgress({
      total: 1,
      processed: 1,
      saved: 0,
      skipped: 0,
      errors: 1,
    });
  }
};

// Main import handler orchestrator
export const handleImport = async (
  importProvider: string,
  importFile: File | null,
  importOverwrite: boolean,
  callbacks: ImportCallbacks,
) => {
  const { setStatus } = callbacks;
  setStatus("Importing archive...", "work");
  try {
    if (importProvider === "chatgpt_zip" && importFile) {
      const total = await countConversationsInZip(importFile);
      await doOpenAIImport(total, parseChatGPTBackupZip(importFile), importOverwrite, callbacks);
    } else if (importProvider === "claude_zip" && importFile) {
      const total = await countClaudeConversationsInZip(importFile);
      await doClaudeImport(total, parseClaudeBackupZip(importFile), importOverwrite, callbacks);
    } else if (importProvider === "openwebui_json" && importFile) {
      const total = await countOpenWebUIConversationsInFile(importFile);
      await doOpenWebUIImport(
        total,
        parseOpenWebUIBackupFile(importFile),
        importOverwrite,
        callbacks,
      );
    } else if (importProvider === "openwebui_zip" && importFile) {
      const total = await countOpenWebUIConversationsInZip(importFile);
      await doOpenWebUIImport(
        total,
        parseOpenWebUIBackupZip(importFile),
        importOverwrite,
        callbacks,
      );
    } else if (importProvider === "haevn_markdown" && importFile) {
      await doMarkdownImport(importFile, importOverwrite, callbacks);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Import failed: ${msg}`, "error");
  }
};
