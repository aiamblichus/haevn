/**
 * Export command – export a full chat tree in HAEVN JSON format.
 */

import * as fs from "node:fs";
import { defineCommand } from "citty";
import { toJsonString } from "../formatters/json";
import { daemonRequest } from "../daemon/client.js";
import type { Chat } from "../types/chat";
import { consola, pc } from "../utils/output";

export default defineCommand({
  meta: {
    name: "export",
    description: "Export a full chat tree in HAEVN JSON format",
  },
  args: {
    chatId: {
      type: "positional",
      description: "Chat ID to export",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path (required)",
      required: true,
    },
    "include-media": {
      type: "boolean",
      description: "Embed base64 media in export (default: false, media referenced by OPFS ID)",
      default: false,
    },
  },
  async run({ args }) {
    const { chatId, output, "include-media": includeMedia } = args;

    let chat: Chat;
    try {
      chat = await daemonRequest<Chat>({
        action: "export",
        chatId,
        options: { includeMedia },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const content = toJsonString(chat);
    fs.writeFileSync(output, content, "utf8");
    consola.log(formatExportSummary(chat, output));
  },
});

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatExportSummary(chat: Chat, outputPath: string): string {
  const messageCount = Object.keys(chat.messages).length;
  const branchCount = Object.values(chat.messages).filter((m) => m.childrenIds.length === 0).length;
  const mediaCount = countMedia(chat);

  const lines = [
    `${pc.green("✓")} Exported ${pc.bold(chat.id)}`,
    `  ${branchCount} branch${branchCount === 1 ? "" : "es"}  ·  ${messageCount} messages${mediaCount ? `  ·  ${mediaCount} media` : ""}`,
    `  ${pc.dim("→")} ${outputPath}`,
  ];

  return lines.join("\n");
}

function countMedia(chat: Chat): number {
  let count = 0;
  for (const msg of Object.values(chat.messages)) {
    for (const part of msg.message) {
      if (part.kind === "response") {
        for (const p of part.parts) {
          if (
            p.part_kind === "image-response" ||
            p.part_kind === "video-response" ||
            p.part_kind === "audio-response"
          ) {
            count++;
          }
        }
      }
    }
  }
  return count;
}
