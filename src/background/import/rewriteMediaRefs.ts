import type { Chat } from "../../model/haevn_model";

/**
 * Rewrites media references in a chat object to point to local OPFS paths.
 * Used when importing HAEVN exports to ensure images/files are linked to
 * the restored media in OPFS instead of original external URLs.
 */
export function rewriteChatMediaRefs(
  chat: Chat,
  mediaMap: Map<string, Map<string, Map<number, string>>>,
) {
  // Skip if no media for this chat
  if (!chat.id || !mediaMap.has(chat.id)) return;

  const chatMedia = mediaMap.get(chat.id);
  if (!chatMedia) return;

  for (const [msgId, chatMsg] of Object.entries(chat.messages)) {
    const msgMedia = chatMedia.get(msgId);
    if (!msgMedia) continue;

    for (const modelMsg of chatMsg.message) {
      let attachmentCounter = 0;
      if (modelMsg.kind === "request") {
        for (const part of modelMsg.parts) {
          if (part.part_kind === "user-prompt" && Array.isArray(part.content)) {
            for (let i = 0; i < part.content.length; i++) {
              const c = part.content[i];
              if (typeof c !== "string" && c !== null) {
                const currentIndex = attachmentCounter++;
                const localPath = msgMedia.get(currentIndex);
                if (localPath) {
                  // Rewrite UserContent to BinaryContent
                  const mediaType =
                    (c.kind === "binary" && c.media_type) ||
                    (c.kind?.startsWith("image") ? "image/jpeg" : "application/octet-stream");
                  part.content[i] = {
                    kind: "binary",
                    data: localPath,
                    media_type: mediaType,
                    identifier: localPath,
                  };
                }
              }
            }
          }
        }
      } else {
        for (const part of modelMsg.parts) {
          if (
            part.part_kind === "image-response" ||
            part.part_kind === "video-response" ||
            part.part_kind === "audio-response" ||
            part.part_kind === "document-response"
          ) {
            const currentIndex = attachmentCounter++;
            const localPath = msgMedia.get(currentIndex);
            if (localPath) {
              // Rewrite to binary part
              const mediaType =
                (part.content?.kind === "binary" && part.content.media_type) ||
                (part.part_kind === "image-response" ? "image/jpeg" : "application/octet-stream");
              part.content = {
                kind: "binary",
                data: localPath,
                media_type: mediaType,
                identifier: localPath,
              };
            }
          }
        }
      }
    }
  }
}
