import * as React from "react";

/**
 * Trigger a file download in the browser using blob URL and anchor click.
 * This works reliably in extension pages (Options, Popup, etc.)
 */
export function downloadFile(
  content: string | Uint8Array,
  filename: string,
  contentType: string,
): void {
  // Create blob from content
  const blob =
    content instanceof Uint8Array
      ? new Blob([content as unknown as BlobPart], { type: contentType })
      : new Blob([content], { type: contentType });

  const blobUrl = URL.createObjectURL(blob);

  // Create anchor and trigger download
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();

  // Clean up
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
  }, 1000);
}

/**
 * Trigger a file download from base64-encoded content.
 */
export function downloadBase64File(
  base64Content: string,
  filename: string,
  contentType: string,
): void {
  const binaryString = atob(base64Content);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  downloadFile(bytes, filename, contentType);
}

export const escapeHtml = (input: string): string =>
  (input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const formatTime = (ts?: number) => {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
};

export const getPlatformIcon = (source: string): React.ReactElement => {
  const s = (source || "").toLowerCase();
  let iconPath: string | null = null;
  if (s.includes("gemini") || s.includes("bard")) iconPath = "icons/gemini.png";
  else if (s.includes("claude")) iconPath = "icons/claude.png";
  else if (s.includes("poe")) iconPath = "icons/poe.png";
  else if (s.includes("chatgpt")) iconPath = "icons/chatgpt.png";
  else if (s.includes("openwebui")) iconPath = "icons/openwebui.png";
  else if (s.includes("qwen")) iconPath = "icons/qwen.png";
  else if (s.includes("aistudio")) iconPath = "icons/aistudio.png";
  else if (s.includes("deepseek")) iconPath = "icons/deepseek.png";
  else if (s.includes("grok")) iconPath = "icons/grok.png";
  else if (s.includes("codex")) iconPath = "icons/codex.png";
  else if (s === "pi" || s.startsWith("pi")) iconPath = "icons/pi.png";

  if (iconPath) {
    return (
      <img
        src={chrome.runtime.getURL(iconPath)}
        alt={source}
        className="w-full h-full object-contain"
      />
    );
  }

  // Fallback emoji for unknown platforms
  return <span className="text-lg">❓</span>;
};

export const buildChatUrl = (source: string, sourceId: string): string | null => {
  if (!source || !sourceId) return null;
  if (source.includes("gemini") || source.includes("bard")) {
    // Strip 'c_' prefix if present (backward compatibility with old data)
    // Real IDs never have the prefix, but old synced chats might
    const cleanId = sourceId.startsWith("c_") ? sourceId.substring(2) : sourceId;
    return `https://gemini.google.com/app/${cleanId}`;
  }
  if (source.includes("claude")) return `https://claude.ai/chat/${sourceId}`;
  if (source.includes("poe")) return `https://poe.com/chat/${sourceId}`;
  if (source.includes("chatgpt")) return `https://chatgpt.com/c/${sourceId}`;
  if (source.includes("qwen")) return `https://chat.qwen.ai/c/${sourceId}`;
  if (source.includes("aistudio")) return `https://aistudio.google.com/prompts/${sourceId}`;
  if (source.includes("deepseek")) return `https://chat.deepseek.com/a/chat/s/${sourceId}`;
  if (source.includes("grok")) return `https://grok.com/c/${sourceId}`;
  // For Open WebUI, host is user-specific; cannot reconstruct absolute URL here
  if (source.includes("openwebui")) return null;
  return null;
};

export const ICONS = {
  sync: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h5M20 20v-5h-5M4 4l16 16"></path>',
  open_provider:
    '<path d="M12.293 2.293a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L14 5.414V11a1 1 0 11-2 0V5.414L9.707 7.707A1 1 0 018.293 6.293l4-4z" /><path d="M3 9a2 2 0 012-2h3a1 1 0 010 2H5v6h6v-3a1 1 0 112 0v3a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />',
  open_viewer:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>',
  export:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>',
  delete:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>',
  sort_asc:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h9m-9 4h13m0-4l-4-4m0 0l-4 4m4-4v12"></path>',
  sort_desc:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9M3 12h9m-9 4h13m0-4l-4 4m0 0l-4-4m4 4V4"></path>',
  logo: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 2L2 7L12 12L22 7L12 2Z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 17L12 22L22 17"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 12L12 17L22 12"></path>',
  spinner:
    '<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>',
  clear:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />',
  chevron_down:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />',
  chevron_up:
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />',
  tag: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3H5a2 2 0 00-2 2v2l9.293 9.293a1 1 0 001.414 0l4-4a1 1 0 000-1.414L8.707 3.707A2 2 0 007 3z" />',
};

export const Icon: React.FC<{
  icon: string;
  svgClass?: string;
}> = ({ icon, svgClass = "w-5 h-5" }: { icon: string; svgClass?: string }) => (
  <svg
    className={svgClass}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    dangerouslySetInnerHTML={{ __html: icon }}
  />
);
