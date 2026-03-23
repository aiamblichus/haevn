import DOMPurify from "dompurify";
import { marked } from "marked";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { log } from "../utils/logger";

// Configure marked for better rendering
marked.setOptions({
  breaks: true, // Convert line breaks to <br>
  gfm: true, // GitHub Flavored Markdown
});

import { type ExportOptions, generateExportContent } from "../formatters";
import type {
  AudioResponsePart,
  AudioUrl,
  Chat,
  ChatMessage,
  DocumentResponsePart,
  DocumentUrl,
  ImageResponsePart,
  ImageUrl,
  UserContent,
  VideoResponsePart,
  VideoUrl,
} from "../model/haevn_model";
import type { BackgroundRequest } from "../types/messaging";

type Params = {
  chatId: string;
  messageId?: string;
  query?: string;
  debug?: boolean;
};

// Concrete attachment type aliases
type UserAttachment = Exclude<UserContent, string>;
type AssistantAttachment =
  | ImageResponsePart
  | VideoResponsePart
  | AudioResponsePart
  | DocumentResponsePart;

// --- Helpers ---
function parseParams(qs: string): Params {
  const u = new URLSearchParams(qs);
  const chatId = u.get("chatId") || "";
  const messageId = u.get("messageId") || undefined;
  const query = u.get("query") || undefined;
  const debugParam = u.get("debug");
  const debug = debugParam === "1" || debugParam === "true";
  return { chatId, messageId, query, debug };
}

function buildChatUrl(source: string, sourceId: string | undefined): string | null {
  if (!source || !sourceId) return null;
  const s = source.toLowerCase();
  if (s.includes("gemini") || s.includes("bard")) {
    // Strip 'c_' prefix if present (backward compatibility with old data)
    // Real IDs never have the prefix, but old synced chats might
    const cleanId = sourceId.startsWith("c_") ? sourceId.substring(2) : sourceId;
    return `https://gemini.google.com/app/${cleanId}`;
  }
  if (s.includes("claude")) return `https://claude.ai/chat/${sourceId}`;
  if (s.includes("poe")) return `https://poe.com/chat/${sourceId}`;
  if (s.includes("chatgpt") || s.includes("openai")) return `https://chatgpt.com/c/${sourceId}`;
  if (s.includes("aistudio")) return `https://aistudio.google.com/prompts/${sourceId}`;
  return null;
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]/g, "\\$&");
}

function highlightTerms(textHtml: string, query: string): string {
  if (!query || !query.trim()) return textHtml;

  const terms: string[] = [];

  // 1. Extract quoted phrases
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null = quoteRegex.exec(query);
  while (match !== null) {
    if (match[1].trim()) {
      terms.push(match[1].trim());
    }
    match = quoteRegex.exec(query);
  }

  // Remove quoted parts to process the rest
  const queryWithoutQuotes = query.replace(quoteRegex, " ");

  // 2. Process remaining terms (standard Lunr-like cleanup)
  // Strip Lunr operators but keep the text
  const cleaned = queryWithoutQuotes.replace(/[+\-~*^:()]/g, " ").trim();

  const singleTerms = cleaned.split(/\s+/).filter(Boolean);
  terms.push(...singleTerms);

  if (terms.length === 0) return textHtml;

  // Sort terms by length (longest first) to ensure longer phrases are matched before shorter sub-terms
  terms.sort((a, b) => b.length - a.length);

  const escapedTerms = terms.map(escapeRegExp);
  const re = new RegExp(`(${escapedTerms.join("|")})`, "gi");

  return textHtml.replace(re, '<span class="highlight">$1</span>');
}

function renderMarkdown(text: string, query?: string): string {
  if (!text) return "";
  let html = marked.parse(text) as string;
  if (query) {
    html = highlightTerms(html, query);
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function renderPlainText(text: string, query?: string): string {
  if (!text) return "";
  let html = escapeHtml(text);
  if (query) {
    html = highlightTerms(html, query);
  }
  return html;
}

function flattenMessage(cm: ChatMessage): {
  system: { text: string };
  user: { text: string; attachments: UserAttachment[] };
  assistant: {
    text: string;
    thinking: string;
    attachments: AssistantAttachment[];
    modelName?: string;
  };
  timestamps: { user?: number; assistant?: number; system?: number };
} {
  const result = {
    system: { text: "" },
    user: { text: "", attachments: [] as UserAttachment[] },
    assistant: {
      text: "",
      thinking: "",
      attachments: [] as AssistantAttachment[],
      modelName: undefined as string | undefined,
    },
    timestamps: {
      user: undefined as number | undefined,
      assistant: undefined as number | undefined,
      system: undefined as number | undefined,
    },
  };

  const arr = cm.message || [];
  for (const mm of arr) {
    if (mm.kind === "request") {
      const req = mm;
      for (const p of req.parts) {
        if (p.part_kind === "user-prompt") {
          const up = p;
          if (!result.timestamps.user) {
            try {
              result.timestamps.user = up.timestamp ? new Date(up.timestamp).getTime() : undefined;
            } catch {
              // Ignore date parsing errors
            }
          }

          if (typeof up.content === "string") {
            result.user.text += (result.user.text ? "\n\n" : "") + up.content;
          } else if (Array.isArray(up.content)) {
            for (const c of up.content) {
              if (typeof c === "string") {
                result.user.text += (result.user.text ? "\n\n" : "") + c;
              } else if (typeof c === "object" && c !== null && "kind" in c) {
                result.user.attachments.push(c as UserAttachment);
              }
            }
          }
        } else if (p.part_kind === "system-prompt") {
          const sp = p;
          if (!result.timestamps.system) {
            try {
              result.timestamps.system = sp.timestamp
                ? new Date(sp.timestamp).getTime()
                : undefined;
            } catch {
              // Ignore date parsing errors
            }
          }
          result.system.text += (result.system.text ? "\n\n" : "") + sp.content;
        }
      }
    } else if (mm.kind === "response") {
      const res = mm;
      if (!result.timestamps.assistant) {
        try {
          result.timestamps.assistant = res.timestamp
            ? new Date(res.timestamp).getTime()
            : undefined;
        } catch {
          // Ignore date parsing errors
        }
      }
      // Extract model name if available
      if (res.model_name && !result.assistant.modelName) {
        result.assistant.modelName = res.model_name;
      }
      for (const p of res.parts) {
        if (p.part_kind === "text") {
          result.assistant.text += (result.assistant.text ? "\n\n" : "") + p.content;
        } else if (p.part_kind === "thinking") {
          result.assistant.thinking += (result.assistant.thinking ? "\n\n" : "") + p.content;
        } else if (p.part_kind.endsWith("-response")) {
          result.assistant.attachments.push(p as AssistantAttachment);
        }
      }
    }
  }
  result.user.text = result.user.text.trim();
  result.assistant.text = result.assistant.text.trim();
  result.assistant.thinking = result.assistant.thinking.trim();

  return result;
}

// --- UI Components ---

const ChevronDown = () => (
  <svg className="w-3 h-3 transition-transform" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
      clipRule="evenodd"
    />
  </svg>
);

const ArrowLeft = () => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
      clipRule="evenodd"
    />
  </svg>
);

const ArrowRight = () => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
      clipRule="evenodd"
    />
  </svg>
);

const DownloadIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
    <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 00-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
    <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
  </svg>
);

const CopyIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
    <path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
    <path d="M13 2a1 1 0 011 1v1h1a1 1 0 011 1v8a1 1 0 01-1 1h-1v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-1H5a1 1 0 01-1-1V6a1 1 0 011-1h1V4a1 1 0 011-1h6z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
      clipRule="evenodd"
    />
  </svg>
);

import { ExportModal } from "../components/ExportModal";

const Header = ({
  chat,
  markdownEnabled,
  onMarkdownToggle,
  onCopy,
  onOpenExport,
}: {
  chat: Chat;
  markdownEnabled: boolean;
  onMarkdownToggle: (enabled: boolean) => void;
  onCopy: () => Promise<void>;
  onOpenExport: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const href = buildChatUrl(chat.source, chat.sourceId);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const getIconPath = (source: string): string | null => {
    const s = (source || "").toLowerCase();
    if (s.includes("gemini") || s.includes("bard")) return "icons/gemini.png";
    if (s.includes("claude")) return "icons/claude.png";
    if (s.includes("poe")) return "icons/poe.png";
    if (s.includes("chatgpt")) return "icons/chatgpt.png";
    if (s.includes("openwebui")) return "icons/openwebui.png";
    if (s.includes("qwen")) return "icons/qwen.png";
    if (s.includes("aistudio")) return "icons/aistudio.png";
    if (s.includes("deepseek")) return "icons/deepseek.png";
    if (s.includes("codex")) return "icons/codex.png";
    if (s === "pi" || s.startsWith("pi")) return "icons/pi.png";
    return null;
  };
  const iconPath = getIconPath(chat.source);

  return (
    <header
      className="p-4 border-b-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] sticky top-0 z-10 backdrop-blur-sm"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4 min-w-0">
          {iconPath ? (
            <div className="w-10 h-10 flex items-center justify-center overflow-hidden border-2 border-[hsl(var(--border))]">
              <img
                src={chrome.runtime.getURL(iconPath)}
                alt={chat.source}
                className="w-full h-full object-contain"
              />
            </div>
          ) : (
            <div className="w-10 h-10 flex items-center justify-center border-2 border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] font-bold text-lg">
              D
            </div>
          )}
          <div className="min-w-0">
            <h1
              id="title"
              className="text-lg font-bold text-[hsl(var(--foreground))] truncate uppercase tracking-wider"
            >
              {chat.title || "(UNTITLED)"}
            </h1>
            <p className="text-xs text-[hsl(var(--muted-foreground))] truncate font-mono">
              {chat.source || ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className={`px-3 py-1.5 border-2 text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${
              copied
                ? "bg-[hsl(var(--secondary))] border-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))] shadow-[0_0_8px_hsl(var(--secondary)/0.5)]"
                : "bg-[hsl(var(--card))] border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:border-[hsl(var(--primary))] hover:shadow-[0_0_8px_hsl(var(--primary)/0.3)]"
            }`}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
            title="Copy chat as Markdown (no metadata)"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span className="hidden sm:inline">{copied ? "COPIED" : "COPY"}</span>
          </button>

          <button
            type="button"
            onClick={onOpenExport}
            className="px-3 py-1.5 border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--secondary))] hover:shadow-[0_0_8px_hsl(var(--secondary)/0.3)] text-xs text-[hsl(var(--foreground))] font-bold uppercase tracking-wider transition-all flex items-center gap-2"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
            title="Export chat with options"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">EXPORT</span>
          </button>

          <button
            type="button"
            onClick={() => onMarkdownToggle(!markdownEnabled)}
            className={`px-3 py-1.5 border-2 text-xs font-bold uppercase tracking-wider transition-all ${
              markdownEnabled
                ? "bg-[hsl(var(--primary))] border-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:shadow-[0_0_8px_hsl(var(--primary)/0.5)]"
                : "bg-[hsl(var(--card))] border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary))]"
            }`}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
            title={markdownEnabled ? "Markdown rendering enabled" : "Plain text rendering"}
          >
            {markdownEnabled ? "MD" : "TXT"}
          </button>
          {href ? (
            <a
              className="px-3 py-1.5 border-2 border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary))] hover:shadow-[0_0_8px_hsl(var(--primary)/0.3)] text-xs text-[hsl(var(--foreground))] font-bold uppercase tracking-wider transition-all"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              OPEN
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
};

const SystemPrompt = ({
  text,
  query,
  markdownEnabled,
}: {
  text: string;
  query?: string;
  markdownEnabled: boolean;
}) => {
  const bodyHtml = useMemo(
    () => (markdownEnabled ? renderMarkdown(text, query) : renderPlainText(text, query)),
    [text, query, markdownEnabled],
  );
  if (!text) return null;
  return (
    <div id="system" className="system-container">
      <div className="system-bubble">
        <div className="system-label">System Prompt</div>
        <div className="system-content" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </div>
    </div>
  );
};

const Thinking = ({ text, query }: { text: string; query?: string }) => {
  const [open, setOpen] = useState(false);
  const bodyHtml = useMemo(() => renderMarkdown(text, query), [text, query]);
  return (
    <div className="thinking-bubble">
      <button
        type="button"
        aria-expanded={open}
        className="thinking-header"
        onClick={() => setOpen((v) => !v)}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <span
          style={{
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            display: "inline-block",
            transition: "transform 0.2s",
          }}
        >
          <ChevronDown />
        </span>
        <span>THINKING</span>
      </button>
      {open && (
        <div
          className="thinking-content"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
    </div>
  );
};

const Attachments = ({
  attachments,
  onImageClick,
}: {
  attachments: (UserAttachment | AssistantAttachment)[];
  onImageClick?: (src: string, filename?: string) => void;
}) => {
  const items = attachments || [];

  // State to track blob URLs for OPFS media
  const [blobUrls, setBlobUrls] = useState<Map<string, string>>(new Map());

  // Helper to detect if content is an OPFS path
  const isOpfsPath = useCallback((content?: string): boolean => {
    return !!content && content.startsWith("media/");
  }, []);

  const getMimeFromUrlPart = useCallback(
    (part: ImageUrl | VideoUrl | AudioUrl | DocumentUrl): string => {
      if (part.kind === "image-url") return "image/jpeg";
      if (part.kind === "video-url") return "video/mp4";
      if (part.kind === "audio-url") return "audio/mpeg";
      if (part.kind === "document-url") return "application/pdf";
      return "application/octet-stream";
    },
    [],
  );

  const getDetails = useCallback(
    (
      att: UserAttachment | AssistantAttachment,
    ): {
      mimeType: string;
      contentUrl?: string;
      content?: string;
      filename?: string;
    } => {
      if ("part_kind" in att) {
        // Assistant attachment (ImageResponsePart, etc.)
        const contentPart = att.content;
        if (typeof contentPart === "object" && contentPart !== null && "kind" in contentPart) {
          const urlPart = contentPart;
          if (urlPart.kind?.endsWith("-url")) {
            const typedUrlPart = urlPart as ImageUrl | VideoUrl | AudioUrl | DocumentUrl;
            return {
              mimeType: getMimeFromUrlPart(typedUrlPart),
              contentUrl: typedUrlPart.url,
              filename: (() => {
                try {
                  return new URL(typedUrlPart.url).pathname.split("/").pop();
                } catch {
                  return undefined;
                }
              })(),
            };
          }
          if (urlPart.kind === "binary") {
            const binaryPart = urlPart;
            return {
              mimeType: binaryPart.media_type,
              content: binaryPart.data,
              filename: binaryPart.identifier,
            };
          }
        }
      } else if (typeof att === "object" && att !== null && "kind" in att) {
        // User attachment (ImageUrl, etc.)
        const urlAtt = att;
        if (urlAtt.kind?.endsWith("-url")) {
          return {
            mimeType: getMimeFromUrlPart(urlAtt as ImageUrl | VideoUrl | AudioUrl | DocumentUrl),
            contentUrl: (urlAtt as ImageUrl | VideoUrl | AudioUrl | DocumentUrl).url,
            filename: (() => {
              try {
                return new URL(
                  (urlAtt as ImageUrl | VideoUrl | AudioUrl | DocumentUrl).url,
                ).pathname
                  .split("/")
                  .pop();
              } catch {
                return undefined;
              }
            })(),
          };
        }
        if (urlAtt.kind === "binary") {
          const b = urlAtt;
          return {
            mimeType: b.media_type,
            content: b.data,
            filename: b.identifier,
          };
        }
      }
      return { mimeType: "application/octet-stream" };
    },
    [getMimeFromUrlPart],
  );

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      for (const url of blobUrls.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [blobUrls]);

  // Load blob URLs for OPFS paths
  useEffect(() => {
    const loadBlobUrls = async () => {
      const newBlobUrls = new Map<string, string>();

      for (let idx = 0; idx < items.length; idx++) {
        const att = items[idx];
        const { content, mimeType } = getDetails(att);

        if (content && isOpfsPath(content)) {
          // Request file data from background (service workers can't create blob URLs)
          try {
            const response = await chrome.runtime.sendMessage({
              action: "getMediaContent",
              storagePath: content,
            });

            if (response?.success && response.content) {
              // Convert base64 to blob and create object URL in the viewer context
              const base64 = response.content;
              const binaryString = atob(base64);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const blob = new Blob([bytes], {
                type: response.mimeType || mimeType,
              });
              const blobUrl = URL.createObjectURL(blob);
              newBlobUrls.set(content, blobUrl);
            }
          } catch (error) {
            log.error(`[Viewer] Failed to load OPFS media: ${content}`, error);
          }
        }
      }

      if (newBlobUrls.size > 0) {
        setBlobUrls(newBlobUrls);
      }
    };

    loadBlobUrls();
  }, [items, getDetails, isOpfsPath]);

  if (items.length === 0) return null;

  return (
    <div className="attachment-grid">
      {items.map((att) => {
        const { mimeType, contentUrl, content, filename } = getDetails(att);
        // Create a unique key from content URL, content hash, or filename
        const key = contentUrl || content || filename || `attachment-${mimeType}`;

        // Determine the source URL
        let src: string;
        if (contentUrl) {
          // HTTP URL
          src = contentUrl;
        } else if (content && isOpfsPath(content)) {
          // OPFS path - use blob URL from state
          src = blobUrls.get(content) || "";
        } else if (content) {
          // Base64 data
          src = `data:${mimeType};base64,${content}`;
        } else {
          src = "";
        }

        if (mimeType.startsWith("image/")) {
          return (
            <div className="attachment-item" key={key}>
              {src ? (
                <img
                  src={src}
                  alt={filename || "Image attachment"}
                  onClick={() => onImageClick?.(src, filename)}
                  style={{ cursor: "pointer" }}
                />
              ) : (
                <div className="attachment-placeholder">Loading...</div>
              )}
            </div>
          );
        } else if (mimeType.startsWith("video/")) {
          return (
            <div className="attachment-item" key={key}>
              {src ? (
                <video src={src} controls />
              ) : (
                <div className="attachment-placeholder">Loading...</div>
              )}
            </div>
          );
        }
        return (
          <div className="attachment-item" key={key}>
            <div className="attachment-placeholder">
              <svg
                className="w-6 h-6 text-slate-500 shrink-0"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M5.5 16.5a1.5 1.5 0 01-1.5-1.5V5A1.5 1.5 0 015.5 3.5h5.914a1.5 1.5 0 011.06.44l3.586 3.586a1.5 1.5 0 01.44 1.06V15a1.5 1.5 0 01-1.5 1.5h-9zM9 12a1 1 0 00-1 1v1.5a.5.5 0 00.5.5h3a.5.5 0 00.5-.5V13a1 1 0 00-1-1H9zM5.5 5a.5.5 0 00-.5.5v10a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V10.5a.5.5 0 00-.5-.5h-3a1.5 1.5 0 01-1.5-1.5V5.5a.5.5 0 00-.5-.5h-4z" />
              </svg>
              <span className="truncate">{escapeHtml(filename || "Attachment")}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Bubble = ({
  label,
  ts,
  text,
  attachments,
  role,
  query,
  thinkingText,
  markdownEnabled,
  modelName,
  onImageClick,
}: {
  label: string;
  ts?: number;
  text: string;
  attachments: (UserAttachment | AssistantAttachment)[];
  role: "user" | "assistant";
  query?: string;
  thinkingText?: string;
  markdownEnabled: boolean;
  modelName?: string;
  onImageClick?: (src: string, filename?: string) => void;
}) => {
  const [copied, setCopied] = useState(false);
  const tsStr = useMemo(() => {
    if (!ts) return "";
    const date = new Date(ts);
    return date.toLocaleString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }, [ts]);

  const bodyHtml = useMemo(
    () => (markdownEnabled ? renderMarkdown(text, query) : renderPlainText(text, query)),
    [text, query, markdownEnabled],
  );

  const contentRef = useRef<HTMLDivElement>(null);

  // Copy message content to clipboard
  const handleCopy = useCallback(async () => {
    try {
      // Build the text content to copy
      let contentToCopy = text;

      // Add thinking text if present (for assistant messages)
      if (role === "assistant" && thinkingText) {
        contentToCopy = `<details>\n<summary>Thinking</summary>\n\n${thinkingText}\n</details>\n\n${text}`;
      }

      // Copy to clipboard
      await navigator.clipboard.writeText(contentToCopy);

      // Show feedback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      log.error("[Viewer] Failed to copy message:", error);
    }
  }, [text, thinkingText, role]);

  // Make images in markdown content clickable
  useEffect(() => {
    if (!contentRef.current || !onImageClick) return;

    const images = contentRef.current.querySelectorAll("img");
    const clickHandlers: Array<(e: MouseEvent) => void> = [];

    images.forEach((img) => {
      img.style.cursor = "pointer";
      const handler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onImageClick(img.src, img.alt || undefined);
      };
      img.addEventListener("click", handler);
      clickHandlers.push(handler);
    });

    return () => {
      images.forEach((img, idx) => {
        img.removeEventListener("click", clickHandlers[idx]);
      });
    };
  }, [onImageClick]);

  // Terminal-style prompt indicator
  const promptSymbol = role === "user" ? ">" : "$";
  const promptColor = role === "user" ? "hsl(var(--prompt-user))" : "hsl(var(--prompt-assistant))";

  return (
    <div className={`message-container ${role}`}>
      <div className={`message-bubble ${role}`}>
        <div className="message-header-wrapper">
          <div
            className="text-xs mb-3 font-bold uppercase tracking-widest flex items-center gap-2"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              color: promptColor,
            }}
          >
            <span className="opacity-70">{promptSymbol}</span>
            <span>{label}</span>
            {modelName && (
              <>
                <span className="opacity-50">•</span>
                <span className="opacity-60 font-normal normal-case tracking-normal">
                  {modelName}
                </span>
              </>
            )}
            {tsStr && (
              <>
                <span className="opacity-50">•</span>
                <span className="opacity-60 font-normal normal-case tracking-normal">{tsStr}</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="message-copy-button"
            title={copied ? "Copied!" : "Copy message"}
            aria-label={copied ? "Copied!" : "Copy message"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        {role === "assistant" && thinkingText ? (
          <Thinking text={thinkingText} query={query} />
        ) : null}
        {text ? (
          <div
            ref={contentRef}
            className={
              markdownEnabled
                ? "break-words leading-relaxed"
                : "whitespace-pre-wrap break-words leading-relaxed"
            }
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : null}
        <Attachments attachments={attachments} onImageClick={onImageClick} />
      </div>
    </div>
  );
};

const MessageView = ({
  msg,
  query,
  markdownEnabled,
  onImageClick,
}: {
  msg: ChatMessage;
  query?: string;
  markdownEnabled: boolean;
  onImageClick?: (src: string, filename?: string) => void;
}) => {
  const data = useMemo(() => flattenMessage(msg), [msg]);
  return (
    <div id={msg.id} className="turn-container">
      {data.system.text && (
        <div className="mb-4">
          <SystemPrompt text={data.system.text} query={query} markdownEnabled={markdownEnabled} />
        </div>
      )}
      {(data.user.text || data.user.attachments.length > 0) && (
        <Bubble
          label="User"
          ts={data.timestamps.user}
          text={data.user.text}
          attachments={data.user.attachments}
          role="user"
          query={query}
          markdownEnabled={markdownEnabled}
          onImageClick={onImageClick}
        />
      )}
      {(data.assistant.text ||
        data.assistant.thinking ||
        data.assistant.attachments.length > 0) && (
        <Bubble
          label="Assistant"
          ts={data.timestamps.assistant}
          text={data.assistant.text}
          attachments={data.assistant.attachments}
          role="assistant"
          query={query}
          thinkingText={data.assistant.thinking}
          markdownEnabled={markdownEnabled}
          modelName={data.assistant.modelName}
          onImageClick={onImageClick}
        />
      )}
    </div>
  );
};

const BranchNav = ({
  index,
  total,
  onChange,
}: {
  index: number;
  total: number;
  onChange: (newIndex: number) => void;
}) => (
  <div className="branch-nav">
    <button
      className="branch-nav-btn"
      disabled={index === 0}
      onClick={() => onChange(Math.max(0, index - 1))}
      aria-label="Previous branch"
    >
      <ArrowLeft />
    </button>
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
      {index + 1} / {total}
    </span>
    <button
      className="branch-nav-btn"
      disabled={index === total - 1}
      onClick={() => onChange(Math.min(total - 1, index + 1))}
      aria-label="Next branch"
    >
      <ArrowRight />
    </button>
  </div>
);

const Thread = ({
  start,
  map,
  query,
  visibleIndex,
  setVisibleIndex,
  markdownEnabled,
  onImageClick,
  showRootNav = false,
  rootIndex = 0,
  totalRoots = 1,
  onRootChange,
}: {
  start: ChatMessage;
  map: { [k: string]: ChatMessage };
  query?: string;
  visibleIndex: Map<string, number>;
  setVisibleIndex: (m: Map<string, number>) => void;
  markdownEnabled: boolean;
  onImageClick?: (src: string, filename?: string) => void;
  showRootNav?: boolean;
  rootIndex?: number;
  totalRoots?: number;
  onRootChange?: (newIndex: number) => void;
}) => {
  // Build a list of nodes to render from root to leaf based on current selections
  const chain = useMemo(() => {
    const nodes: ChatMessage[] = [];
    let current: ChatMessage | undefined = start;
    while (current) {
      nodes.push(current);
      const children: ChatMessage[] = (current.childrenIds
        ?.map((id) => map[id])
        .filter((msg): msg is ChatMessage => msg !== undefined) || []) as ChatMessage[];
      if (children && children.length > 0) {
        const idx: number = visibleIndex.get(current.id) || 0;
        current = children[idx];
      } else {
        current = undefined;
      }
    }
    return nodes;
  }, [start, map, visibleIndex]);

  return (
    <div>
      {chain.map((node, chainIndex) => {
        const children = node.childrenIds?.map((id) => map[id]).filter(Boolean) || [];
        const currentIndex = visibleIndex.get(node.id) || 0;
        return (
          <Fragment key={node.id}>
            {/* Root navigation BEFORE the first message */}
            {chainIndex === 0 && showRootNav && totalRoots > 1 && onRootChange && (
              <BranchNav index={rootIndex} total={totalRoots} onChange={onRootChange} />
            )}
            <MessageView
              msg={node}
              query={query}
              markdownEnabled={markdownEnabled}
              onImageClick={onImageClick}
            />
            {/* Child branch navigation AFTER message */}
            {children.length > 1 && (
              <BranchNav
                index={currentIndex}
                total={children.length}
                onChange={(newIdx: number) => {
                  const copy = new Map(visibleIndex);
                  copy.set(node.id, newIdx);
                  setVisibleIndex(copy);
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
};

const ErrorView = ({ message }: { message: string }) => (
  <main className="max-w-5xl mx-auto p-4">
    <div className="border-2 border-[hsl(var(--destructive))] bg-[hsl(var(--card))] p-4">
      <p
        className="text-sm font-bold uppercase tracking-wider"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          color: "hsl(var(--destructive))",
        }}
      >
        ERROR: {message}
      </p>
    </div>
  </main>
);

const ImageModal = ({
  src,
  filename,
  onClose,
}: {
  src: string;
  filename?: string;
  onClose: () => void;
}) => {
  const handleDownload = async () => {
    try {
      let blob: Blob;
      let downloadFilename = filename || "image";

      if (src.startsWith("data:")) {
        // Handle base64 data URLs
        const response = await fetch(src);
        blob = await response.blob();
        // Extract extension from data URL if available
        const mimeMatch = src.match(/data:([^;]+)/);
        if (mimeMatch) {
          const mimeType = mimeMatch[1];
          const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
          if (!downloadFilename.includes(".")) {
            downloadFilename = `${downloadFilename}.${ext}`;
          }
        }
      } else {
        // Handle URL-based images
        const response = await fetch(src);
        blob = await response.blob();
        // Try to extract filename from URL
        try {
          const url = new URL(src);
          const urlFilename = url.pathname.split("/").pop();
          if (urlFilename?.includes(".")) {
            downloadFilename = urlFilename;
          } else {
            // Extract extension from content type
            const contentType = response.headers.get("content-type");
            if (contentType) {
              const ext = contentType.split("/")[1]?.split("+")[0] || "png";
              downloadFilename = `${downloadFilename}.${ext}`;
            }
          }
        } catch {
          // If URL parsing fails, use default filename
        }
      }

      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      log.error("Failed to download image:", error);
    }
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="image-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="image-modal-content">
        <button className="image-modal-close" onClick={onClose} aria-label="Close image modal">
          <CloseIcon />
        </button>
        <button
          className="image-modal-download"
          onClick={handleDownload}
          aria-label="Download image"
          title="Download image"
        >
          <DownloadIcon />
        </button>
        <img src={src} alt={filename || "Image"} className="image-modal-img" />
      </div>
    </div>
  );
};

/**
 * Finds the path from root to target message and returns branch selections needed.
 * Returns both the branch selections map and the index of the root containing the target.
 */
function findBranchPathToMessage(
  targetMessageId: string,
  messages: { [k: string]: ChatMessage },
  roots: ChatMessage[],
): { branchSelections: Map<string, number>; rootIndex: number } {
  const branchSelections = new Map<string, number>();

  // Helper function to check if a message or any of its descendants contains the target
  const containsTarget = (messageId: string, visited: Set<string>): boolean => {
    if (visited.has(messageId)) return false; // Prevent cycles
    if (messageId === targetMessageId) return true;

    visited.add(messageId);
    const message = messages[messageId];
    if (!message) return false;

    const children = message.childrenIds?.map((id) => messages[id]).filter(Boolean) || [];
    for (const child of children) {
      if (containsTarget(child.id, visited)) return true;
    }

    return false;
  };

  // Find which root contains the target and trace the path
  for (let rootIdx = 0; rootIdx < roots.length; rootIdx++) {
    const root = roots[rootIdx];
    const visited = new Set<string>();
    if (containsTarget(root.id, visited)) {
      // Found the root, now trace the path
      const tracePath = (messageId: string, pathVisited: Set<string>): boolean => {
        if (pathVisited.has(messageId)) return false;
        if (messageId === targetMessageId) return true;

        pathVisited.add(messageId);
        const message = messages[messageId];
        if (!message) return false;

        const children = message.childrenIds?.map((id) => messages[id]).filter(Boolean) || [];
        if (children.length === 0) return false;

        // If this node has multiple children, find which one leads to target
        for (let i = 0; i < children.length; i++) {
          const checkVisited = new Set(pathVisited);
          if (containsTarget(children[i].id, checkVisited)) {
            branchSelections.set(messageId, i);
            return tracePath(children[i].id, pathVisited);
          }
        }

        // Single child path
        if (children.length === 1) {
          return tracePath(children[0].id, pathVisited);
        }

        return false;
      };

      tracePath(root.id, new Set());
      return { branchSelections, rootIndex: rootIdx };
    }
  }

  return { branchSelections: new Map(), rootIndex: 0 };
}

const App = () => {
  const params = useMemo(() => parseParams(location.search), []);
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleIndex, setVisibleIndex] = useState<Map<string, number>>(new Map());
  const [selectedRootIndex, setSelectedRootIndex] = useState<number>(0);
  const [modalImage, setModalImage] = useState<{
    src: string;
    filename?: string;
  } | null>(null);

  const [isExportOpen, setIsExportOpen] = useState(false);
  const exportOptions: ExportOptions = {
    format: "json",
    includeMetadata: true,
    includeTimestamps: true,
  };

  // Load markdown preference from localStorage, default to true
  const [markdownEnabled, setMarkdownEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem("haevn-viewer-markdown-enabled");
    return stored !== null ? stored === "true" : true;
  });

  const scrollTargetRef = useRef<string | undefined>(params.messageId);

  const handleMarkdownToggle = (enabled: boolean) => {
    setMarkdownEnabled(enabled);
    localStorage.setItem("haevn-viewer-markdown-enabled", String(enabled));
  };

  // Compute sorted roots (timestamp ascending for consistent ordering)
  const sortedRoots = useMemo(() => {
    if (!chat) return [];
    const allMsgs = Object.values(chat.messages || {});
    const idSet = new Set(Object.keys(chat.messages || {}));
    const r = allMsgs.filter((n) => !n.parentId || !idSet.has(n.parentId));
    // Sort by timestamp (oldest first)
    return r.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }, [chat]);

  // Compute visible chain from ONLY the selected root
  const visibleChain = useMemo(() => {
    if (!chat || sortedRoots.length === 0) return [];

    // Clamp selectedRootIndex to valid range
    const rootIdx = Math.min(selectedRootIndex, sortedRoots.length - 1);
    const startRoot = sortedRoots[rootIdx];
    if (!startRoot) return [];

    const chain: string[] = [];
    let current: ChatMessage | undefined = startRoot;
    while (current) {
      chain.push(current.id);
      const children = (current.childrenIds?.map((id) => chat.messages[id]).filter(Boolean) ||
        []) as ChatMessage[];
      if (children.length > 0) {
        const idx: number = visibleIndex.get(current.id) || 0;
        current = children[idx];
      } else {
        current = undefined;
      }
    }
    return chain;
  }, [chat, sortedRoots, selectedRootIndex, visibleIndex]);

  const handleCopyMarkdown = async () => {
    if (!chat) return;
    try {
      const content = await generateExportContent(chat, {
        format: "markdown",
        includeMetadata: false,
        includeTimestamps: false,
        messageIds: visibleChain,
      });
      await navigator.clipboard.writeText(content);
    } catch (err) {
      log.error("[Viewer] Failed to copy markdown:", err);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        if (!params.chatId) throw new Error("Missing chatId");

        // Safety: Wait for chrome.runtime if it's missing (can happen on fresh tabs)
        let retries = 0;
        while ((typeof chrome === "undefined" || !chrome.runtime?.sendMessage) && retries < 10) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (retries + 1)));
          retries++;
        }

        if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
          throw new Error("Extension context not available. Please refresh the page.");
        }

        const request: BackgroundRequest = {
          action: "getSyncedChatContent",
          chatId: params.chatId,
        };
        const resp = await chrome.runtime.sendMessage(request);
        if (!resp?.success) {
          throw new Error("error" in resp ? resp.error : "Chat not found");
        }
        if (!("data" in resp) || !resp.data) {
          throw new Error("Chat not found");
        }
        const c = resp.data as Chat;
        setChat(c);

        if (params.debug) {
          // Minimal debug logging of structure
          try {
            const nodes = Object.values(c.messages || {});
            for (const node of nodes) {
              const arr = node.message || [];
              for (const mm of arr) {
                if (mm.kind === "response") {
                  const res = mm;

                  log.info(
                    "[Viewer][Debug]",
                    node.id,
                    "assistant parts:",
                    res.parts.map((p) => p?.part_kind),
                  );
                } else if (mm.kind === "request") {
                  const req = mm;
                  const up = req.parts.find((p) => p.part_kind === "user-prompt");

                  log.info(
                    "[Viewer][Debug]",
                    node.id,
                    "user prompt type:",
                    typeof up?.content,
                    Array.isArray(up?.content) ? "array" : "scalar",
                  );
                }
              }
            }
          } catch {
            // Ignore debug logging errors
          }
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
  }, [params.chatId, params.debug]);

  // Set branch selections to make target message visible
  useEffect(() => {
    if (!chat || !params.messageId) return;

    const { branchSelections, rootIndex } = findBranchPathToMessage(
      params.messageId,
      chat.messages,
      sortedRoots,
    );

    setSelectedRootIndex(rootIndex);
    if (branchSelections.size > 0) {
      setVisibleIndex(branchSelections);
    } else {
      // Even if no branch selections needed, trigger a re-render to ensure scroll effect runs
      // after the branch path computation is complete
      setVisibleIndex(new Map());
    }
  }, [chat, params.messageId, sortedRoots]);

  // Initialize selectedRootIndex from chat.currentId when no messageId param
  useEffect(() => {
    if (!chat || params.messageId || sortedRoots.length <= 1) return;
    if (!chat.currentId) return;

    // Find which root contains currentId
    const containsMessage = (startId: string, targetId: string, visited: Set<string>): boolean => {
      if (visited.has(startId)) return false;
      if (startId === targetId) return true;
      visited.add(startId);
      const msg = chat.messages[startId];
      if (!msg) return false;
      for (const childId of msg.childrenIds || []) {
        if (containsMessage(childId, targetId, visited)) return true;
      }
      return false;
    };

    for (let i = 0; i < sortedRoots.length; i++) {
      if (containsMessage(sortedRoots[i].id, chat.currentId, new Set())) {
        setSelectedRootIndex(i);
        return;
      }
    }
    // Default to last root if not found
    setSelectedRootIndex(sortedRoots.length - 1);
  }, [chat, params.messageId, sortedRoots]);

  // Scroll to specific message if requested
  useEffect(() => {
    if (!chat || !scrollTargetRef.current) return;
    const id = scrollTargetRef.current;

    let timeoutIds: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;

    // Wait for React to render the correct branch, then scroll
    // Use requestAnimationFrame to wait for the next paint cycle, with retries
    const attemptScroll = (retries = 20) => {
      if (cancelled) return;

      requestAnimationFrame(() => {
        if (cancelled) return;

        const el = document.getElementById(id);
        if (el) {
          scrollTargetRef.current = undefined; // Clear ref only after successful find
          // Small delay to ensure element is fully rendered and positioned
          const timeoutId = setTimeout(() => {
            if (cancelled) return;

            // NEW: Try to find the actual highlight inside the container for better precision
            const highlightEl = el.querySelector(".highlight");
            const scrollTarget = highlightEl || el;

            scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });

            // Apply glow effect to the container (or highlight)
            el.style.boxShadow =
              "0 0 0 2px hsl(var(--primary)), 0 0 12px hsl(var(--primary) / 0.6)";

            // If we found a specific highlight, let's also give it a momentary pulse
            if (highlightEl instanceof HTMLElement) {
              highlightEl.style.transition = "transform 0.3s ease";
              highlightEl.style.transform = "scale(1.1)";
              setTimeout(() => {
                if (highlightEl) highlightEl.style.transform = "";
              }, 500);
            }

            setTimeout(() => {
              if (el) el.style.boxShadow = "";
            }, 2500);
          }, 100);
          timeoutIds.push(timeoutId);
        } else if (retries > 0) {
          // Element not found yet, retry after a short delay
          const timeoutId = setTimeout(() => {
            if (!cancelled) attemptScroll(retries - 1);
          }, 150);
          timeoutIds.push(timeoutId);
        } else {
          // Give up after retries exhausted
          scrollTargetRef.current = undefined;
        }
      });
    };

    // Initial delay to allow React to start rendering
    const initialTimeout = setTimeout(() => {
      if (!cancelled) attemptScroll();
    }, 200);
    timeoutIds.push(initialTimeout);

    return () => {
      cancelled = true;
      for (const id of timeoutIds) {
        clearTimeout(id);
      }
      timeoutIds = [];
    };
  }, [chat]);

  if (error) return <ErrorView message={error} />;
  if (!chat)
    return (
      <main className="max-w-5xl mx-auto p-4">
        <div
          className="text-[hsl(var(--muted-foreground))] font-bold uppercase tracking-widest"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          LOADING...
        </div>
      </main>
    );

  return (
    <Fragment>
      <Header
        chat={chat}
        markdownEnabled={markdownEnabled}
        onMarkdownToggle={handleMarkdownToggle}
        onCopy={handleCopyMarkdown}
        onOpenExport={() => setIsExportOpen(true)}
      />
      <main className="max-w-5xl mx-auto p-6">
        {chat.system ? (
          <div className="mb-3">
            <SystemPrompt
              text={chat.system}
              query={params.query}
              markdownEnabled={markdownEnabled}
            />
          </div>
        ) : null}
        <div id="chatContent" className="flex flex-col gap-1">
          {sortedRoots.length > 0 && (
            <Thread
              key={sortedRoots[Math.min(selectedRootIndex, sortedRoots.length - 1)]?.id || "empty"}
              start={sortedRoots[Math.min(selectedRootIndex, sortedRoots.length - 1)]}
              map={chat.messages}
              query={params.query}
              visibleIndex={visibleIndex}
              setVisibleIndex={setVisibleIndex}
              markdownEnabled={markdownEnabled}
              onImageClick={(src, filename) => setModalImage({ src, filename })}
              showRootNav={sortedRoots.length > 1}
              rootIndex={selectedRootIndex}
              totalRoots={sortedRoots.length}
              onRootChange={setSelectedRootIndex}
            />
          )}
        </div>
      </main>
      {modalImage && (
        <ImageModal
          src={modalImage.src}
          filename={modalImage.filename}
          onClose={() => setModalImage(null)}
        />
      )}
      {isExportOpen && (
        <ExportModal
          open={isExportOpen}
          onOpenChange={setIsExportOpen}
          exportModalIds={chat?.id ? [chat.id] : null}
          exportOptions={{
            ...exportOptions,
            messageIds: visibleChain,
          }}
          onClose={() => setIsExportOpen(false)}
        />
      )}
    </Fragment>
  );
};

// --- Mount ---
// --- Mount Application ---
const container = document.getElementById("app");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
