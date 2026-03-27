import {
  type ExportOptions,
  generateExportContent,
  generateExportFilename,
} from "../../formatters";
import type { Chat } from "../../model/haevn_model";
import { exportChatAsPiSessionJsonl } from "./piSessionExport";

export interface TextExportArtifact {
  exporterId: NonNullable<ExportOptions["exporterId"]>;
  filename: string;
  contentType: string;
  content: string;
  warnings?: string[];
}

export async function buildTextExportArtifact(
  chat: Chat,
  options: ExportOptions,
): Promise<TextExportArtifact> {
  const exporterId = options.exporterId || "haevn_zip";

  if (exporterId === "pi_session_jsonl") {
    const sessionId = chat.id || chat.sourceId || "session";
    return {
      exporterId,
      filename: `pi_session_${sessionId}.jsonl`,
      contentType: "application/x-ndjson;charset=utf-8",
      content: exportChatAsPiSessionJsonl(chat, options.messageIds),
      warnings: [
        "Pi session export omits embedded binary payloads and keeps textual placeholders.",
      ],
    };
  }

  const format = exporterId === "haevn_markdown" ? "markdown" : "json";
  return {
    exporterId,
    filename: generateExportFilename(chat.source, chat.title, format, chat.sourceId),
    contentType:
      format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
    content: await generateExportContent(chat, {
      ...options,
      format,
    }),
  };
}
