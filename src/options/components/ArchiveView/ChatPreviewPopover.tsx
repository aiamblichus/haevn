import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatMeta } from "../../types";
import { ChatPreviewCard, type PreviewData } from "../shared/ChatPreviewCard";

interface CacheEntry {
  data: PreviewData;
  /** The metaTitle at the time of caching — used to detect staleness. */
  metaTitle: string | undefined;
}

// Module-level cache — persists across renders, cleared on page reload
const previewCache = new Map<string, CacheEntry>();

const HOVER_DELAY_MS = 650;
const LEAVE_DELAY_MS = 120;
const CARD_WIDTH = 400;
const CARD_OFFSET_Y = 6;

interface ChatPreviewPopoverProps {
  chat: ChatMeta;
  children: React.ReactNode;
}

export function ChatPreviewPopover({ chat, children }: ChatPreviewPopoverProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    showTimerRef.current = null;
    hideTimerRef.current = null;
  }, []);

  const scheduleShow = useCallback(
    (mouseX: number, mouseY: number) => {
      clearTimers();
      showTimerRef.current = setTimeout(async () => {
        // Smart vertical positioning: show below cursor by default, above if not enough room
        const cardEstHeight = 320;
        const spaceBelow = window.innerHeight - mouseY;
        const y =
          spaceBelow >= cardEstHeight + CARD_OFFSET_Y
            ? mouseY + CARD_OFFSET_Y * 3
            : mouseY - cardEstHeight - CARD_OFFSET_Y;

        // Smart horizontal positioning: clamp to viewport
        const x = Math.min(mouseX, window.innerWidth - CARD_WIDTH - 8);

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
    },
    [chat.id, chat.metaTitle, clearTimers],
  );

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
        onMouseEnter={(e) => scheduleShow(e.clientX, e.clientY)}
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
            <ChatPreviewCard chat={chat} data={previewData} isLoading={isLoading} />
          </div>,
          document.body,
        )}
    </>
  );
}
