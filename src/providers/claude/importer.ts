import type { Entry } from "@zip.js/zip.js";
import { createZipReader, readEntryText } from "../../utils/zipReader";
import type { ChatTranscript, Project } from "./model";

function parseConversations(text: string): ChatTranscript[] {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.conversations)) return parsed.conversations;
    return [];
  } catch {
    return [];
  }
}

function parseProjects(text: string): Project[] {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as Project[];
    if (Array.isArray(parsed?.projects)) return parsed.projects as Project[];
    return [];
  } catch {
    return [];
  }
}

// ----- ZIP based importer -----

export async function countClaudeConversationsInZip(
  fileOrBuffer: File | ArrayBuffer,
): Promise<number> {
  const reader = createZipReader(fileOrBuffer);
  try {
    const entries = await reader.getEntries();
    const entry = entries.find(
      (item) => !item.directory && item.filename.toLowerCase() === "conversations.json",
    );
    if (!entry) return 0;
    try {
      const text = await readEntryText(entry);
      return parseConversations(text).length;
    } catch {
      return 0;
    }
  } finally {
    await reader.close();
  }
}

export async function* parseClaudeBackupZip(
  fileOrBuffer: File | ArrayBuffer,
): AsyncGenerator<{ conversation: ChatTranscript; projects: Project[] }> {
  const reader = createZipReader(fileOrBuffer);
  try {
    const entries: Entry[] = await reader.getEntries();
    const convEntry = entries.find(
      (entry) => !entry.directory && entry.filename.toLowerCase() === "conversations.json",
    );
    if (!convEntry) throw new Error("conversations.json not found in ZIP");
    const convText = await readEntryText(convEntry);
    const conversations = parseConversations(convText) as ChatTranscript[];

    let projects: Project[] = [];
    const projEntry = entries.find(
      (entry) => !entry.directory && entry.filename.toLowerCase() === "projects.json",
    );
    if (projEntry) {
      try {
        projects = parseProjects(await readEntryText(projEntry));
      } catch {
        projects = [];
      }
    }

    for (const conversation of conversations) {
      yield { conversation, projects };
    }
  } finally {
    await reader.close();
  }
}
