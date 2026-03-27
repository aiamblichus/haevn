import {
  type ExportOptions,
  generateExportContent,
  generateExportFilename,
} from "../../formatters";
import { SyncService } from "../../services/syncService";
import { exportChatAsPiSessionJsonl } from "./piSessionExport";

function toBase64Utf8(content: string): string {
  const encoder = new TextEncoder();
  const utf8Bytes = encoder.encode(content);
  let binaryString = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binaryString += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binaryString);
}

async function downloadTextContent(
  content: string,
  filename: string,
  contentType: string,
): Promise<number> {
  const base64Content = toBase64Utf8(content);
  const dataUrl = `data:${contentType};base64,${base64Content}`;

  return await new Promise<number>((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (downloadId === undefined) {
          reject(new Error("Download returned undefined ID"));
          return;
        }
        resolve(downloadId);
      },
    );
  });
}

export async function exportSingleChatFile(
  chatId: string,
  options: ExportOptions,
): Promise<{ filename: string; downloadId: number }> {
  const chat = await SyncService.getChatWithMessages(chatId);
  if (!chat) {
    throw new Error(`Chat not found: ${chatId}`);
  }

  if (options.exporterId === "pi_session_jsonl") {
    const content = exportChatAsPiSessionJsonl(chat, options.messageIds);
    const sessionId = chat.id || chat.sourceId || "session";
    const filename = `pi_session_${sessionId}.jsonl`;
    const downloadId = await downloadTextContent(
      content,
      filename,
      "application/x-ndjson;charset=utf-8",
    );
    return { filename, downloadId };
  }

  const format = options.exporterId === "haevn_markdown" ? "markdown" : "json";
  const filename = generateExportFilename(chat.source, chat.title, format, chat.sourceId);
  const content = await generateExportContent(chat, {
    ...options,
    format,
  });

  const contentType =
    format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8";
  const downloadId = await downloadTextContent(content, filename, contentType);

  return { filename, downloadId };
}
