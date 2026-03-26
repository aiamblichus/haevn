import { parseEntities } from "parse-entities";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatMetadataRecord } from "../../../services/db";
import type { ChatMeta } from "../../types";
import { formatTime, getPlatformIcon } from "../../utils";

interface PreviewData {
  metadata: ChatMetadataRecord | null;
  messageCount: number;
  createdAt: number;
  models: string[];
}

interface CacheEntry {
  data: PreviewData;
  /** The metaTitle at the time of caching — used to detect staleness. */
  metaTitle: string | undefined;
}

// Module-level cache — persists across renders, cleared on page reload
const previewCache = new Map<string, CacheEntry>();

const HOVER_DELAY_MS = 420;
const LEAVE_DELAY_MS = 120;
const CARD_WIDTH = 400;
const CARD_OFFSET_Y = 6;

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "muted";
}) {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  const cls =
    variant === "muted"
      ? `${base} bg-muted text-muted-foreground`
      : `${base} bg-primary/10 text-primary`;
  return <span className={cls}>{children}</span>;
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </span>
      <span className="text-xs text-foreground">{value}</span>
    </div>
  );
}

interface PopoverCardProps {
  chat: ChatMeta;
  data: PreviewData | null;
  isLoading: boolean;
}

function PopoverCard({ chat, data, isLoading }: PopoverCardProps) {
  const displayTitle = parseEntities(
    data?.metadata?.title || chat.metaTitle || chat.title || "(Untitled)",
  );
  const description = data?.metadata?.description;
  const synopsis = data?.metadata?.synopsis;
  const categories = data?.metadata?.categories ?? [];
  const keywords = data?.metadata?.keywords ?? [];
  const models = data?.models ?? [];
  const metaSource = data?.metadata?.source;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Header: icon + title + source */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-muted overflow-hidden">
          {getPlatformIcon(chat.source)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-snug line-clamp-2">{displayTitle}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge variant="muted">{chat.source}</Badge>
            {models.length > 0 && <Badge variant="muted">{models[0]}</Badge>}
            {metaSource === "ai" && <Badge variant="default">AI indexed</Badge>}
            {metaSource === "manual" && <Badge variant="muted">Manual</Badge>}
          </div>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-2">
          <div className="h-3 bg-muted rounded animate-pulse w-3/4" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/2" />
        </div>
      )}

      {/* Description */}
      {!isLoading && description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{description}</p>
      )}

      {/* Synopsis */}
      {!isLoading && synopsis && !description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{synopsis}</p>
      )}

      {/* Categories */}
      {!isLoading && categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {categories.map((cat) => (
            <Badge key={cat} variant="default">
              {cat}
            </Badge>
          ))}
        </div>
      )}

      {/* Keywords */}
      {!isLoading && keywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {keywords.slice(0, 8).map((kw) => (
            <Badge key={kw} variant="muted">
              {kw}
            </Badge>
          ))}
          {keywords.length > 8 && <Badge variant="muted">+{keywords.length - 8} more</Badge>}
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {data !== null && <StatItem label="Messages" value={String(data.messageCount)} />}
        {data?.createdAt ? <StatItem label="Created" value={formatTime(data.createdAt)} /> : null}
        {chat.providerLastModifiedTimestamp ? (
          <StatItem label="Updated" value={formatTime(chat.providerLastModifiedTimestamp)} />
        ) : null}
        {chat.lastSyncedTimestamp ? (
          <StatItem label="Synced" value={formatTime(chat.lastSyncedTimestamp)} />
        ) : null}
      </div>

      {/* No metadata hint */}
      {!isLoading && data?.metadata === null && (
        <p className="text-[10px] text-muted-foreground italic">
          No AI metadata yet — generate it from the metadata editor.
        </p>
      )}
    </div>
  );
}

interface ChatPreviewPopoverProps {
  chat: ChatMeta;
  children: React.ReactNode;
}

export function ChatPreviewPopover({ chat, children }: ChatPreviewPopoverProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    showTimerRef.current = null;
    hideTimerRef.current = null;
  }, []);

  const scheduleShow = useCallback(() => {
    clearTimers();
    showTimerRef.current = setTimeout(async () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Smart vertical positioning: show below by default, above if not enough room
      const spaceBelow = window.innerHeight - rect.bottom;
      const cardEstHeight = 320;
      const y =
        spaceBelow >= cardEstHeight + CARD_OFFSET_Y
          ? rect.bottom + CARD_OFFSET_Y
          : rect.top - cardEstHeight - CARD_OFFSET_Y;

      // Smart horizontal positioning: clamp to viewport
      const x = Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8);

      setPosition({ x, y });
      setIsVisible(true);

      // Use cache if available and not stale (metaTitle unchanged)
      const cached = previewCache.get(chat.id);
      if (cached && cached.metaTitle === chat.metaTitle) {
        setPreviewData(cached.data);
        return;
      }

      setIsLoading(true);
      setPreviewData(null);
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "getChatPreview",
          chatId: chat.id,
        });
        if (resp?.success && resp.data) {
          const data = resp.data as PreviewData;
          previewCache.set(chat.id, { data, metaTitle: chat.metaTitle });
          setPreviewData(data);
        }
      } catch {
        // Silently fail — card still shows with available ChatMeta data
      } finally {
        setIsLoading(false);
      }
    }, HOVER_DELAY_MS);
  }, [chat.id, chat.metaTitle, clearTimers]);

  const scheduleHide = useCallback(() => {
    clearTimers();
    hideTimerRef.current = setTimeout(() => {
      setIsVisible(false);
    }, LEAVE_DELAY_MS);
  }, [clearTimers]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  // Clear timers on unmount to prevent state updates after unmount
  useEffect(() => () => clearTimers(), [clearTimers]);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={scheduleShow}
        onMouseLeave={scheduleHide}
        className="contents"
      >
        {children}
      </div>

      {isVisible &&
        position &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: position.x,
              top: position.y,
              width: CARD_WIDTH,
              zIndex: 9999,
            }}
            className="rounded-xl border border-border bg-card text-card-foreground shadow-xl"
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          >
            <PopoverCard chat={chat} data={previewData} isLoading={isLoading} />
          </div>,
          document.body,
        )}
    </>
  );
}
