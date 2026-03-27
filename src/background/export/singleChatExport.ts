import type { ExportOptions } from "../../formatters";
import { SyncService } from "../../services/syncService";
import { buildTextExportArtifact } from "./textExportArtifact";

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

  const artifact = await buildTextExportArtifact(chat, options);
  const downloadId = await downloadTextContent(
    artifact.content,
    artifact.filename,
    artifact.contentType,
  );

  return { filename: artifact.filename, downloadId };
}
