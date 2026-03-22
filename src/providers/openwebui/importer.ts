import type { Entry } from "@zip.js/zip.js";
import { createZipReader, readEntryText } from "../../utils/zipReader";
import type { OpenWebUIChatResponse } from "./model";

function parseConversationsText(text: string): OpenWebUIChatResponse[] {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as OpenWebUIChatResponse[];
    if (Array.isArray(parsed?.conversations))
      return parsed.conversations as OpenWebUIChatResponse[];
    // Some exports might wrap under `data`
    if (Array.isArray(parsed?.data)) return parsed.data as OpenWebUIChatResponse[];
    return [];
  } catch {
    return [];
  }
}

export async function countOpenWebUIConversationsInFile(
  fileOrBuffer: File | ArrayBuffer | string,
): Promise<number> {
  let text = "";
  if (fileOrBuffer instanceof File) text = await fileOrBuffer.text();
  else if (typeof fileOrBuffer === "string") text = fileOrBuffer;
  else text = new TextDecoder().decode(fileOrBuffer as ArrayBuffer);
  return parseConversationsText(text).length;
}

export async function* parseOpenWebUIBackupFile(
  fileOrBuffer: File | ArrayBuffer | string,
): AsyncGenerator<{ conversation: OpenWebUIChatResponse }> {
  let text = "";
  if (fileOrBuffer instanceof File) text = await fileOrBuffer.text();
  else if (typeof fileOrBuffer === "string") text = fileOrBuffer;
  else text = new TextDecoder().decode(fileOrBuffer as ArrayBuffer);
  const arr = parseConversationsText(text);
  for (const conv of arr) yield { conversation: conv };
}

// ZIP-based importer (mirrors ChatGPT flow): expects conversations.json at root of the zip
export async function countOpenWebUIConversationsInZip(
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
      return parseConversationsText(text).length;
    } catch {
      return 0;
    }
  } finally {
    await reader.close();
  }
}

export async function* parseOpenWebUIBackupZip(
  fileOrBuffer: File | ArrayBuffer,
): AsyncGenerator<{ conversation: OpenWebUIChatResponse }> {
  const reader = createZipReader(fileOrBuffer);
  try {
    const entries: Entry[] = await reader.getEntries();
    const entry = entries.find(
      (item) => !item.directory && item.filename.toLowerCase() === "conversations.json",
    );
    if (!entry) throw new Error("conversations.json not found in ZIP");
    const text = await readEntryText(entry);
    const items = parseConversationsText(text);
    for (const conv of items) yield { conversation: conv };
  } finally {
    await reader.close();
  }
}
