import React, { useEffect, useRef, useState } from "react";
import type { GalleryMediaItem } from "../../../types/workerMessages";
import { log } from "../../../utils/logger";

const CONTROLS_TIMEOUT = 3000; // 3 seconds

interface MediaModalProps {
  item: GalleryMediaItem;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
  loading?: boolean;
}

export const MediaModal = ({
  item,
  onClose,
  onNavigate,
  hasPrev,
  hasNext,
  loading,
}: MediaModalProps) => {
  const isVideo = item.mediaType.startsWith("video/");
  const [showControls, setShowControls] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle mouse movement to show/hide controls
  useEffect(() => {
    const handleMouseMove = () => {
      setShowControls(true);

      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Set new timeout to hide controls
      timeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, CONTROLS_TIMEOUT);
    };

    // Show controls initially
    handleMouseMove();

    document.addEventListener("mousemove", handleMouseMove);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrev && !loading) {
        onNavigate("prev");
      } else if (e.key === "ArrowRight" && hasNext && !loading) {
        onNavigate("next");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Prevent body scroll
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose, onNavigate, hasPrev, hasNext, loading]);

  // Handle download
  const handleDownload = async () => {
    try {
      // Determine file extension from media type
      const ext = item.mediaType.split("/")[1] || "jpg";
      const filename = `${item.source}_${item.chatId.slice(
        0,
        8,
      )}_${item.messageId.slice(0, 8)}.${ext}`;

      // If it's a data URL, download directly
      if (item.content.startsWith("data:")) {
        const link = document.createElement("a");
        link.href = item.content;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        // For external URLs, fetch and download
        const response = await fetch(item.content);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      log.error("[MediaModal] Error downloading file:", error);
    }
  };

  // Handle jump to chat
  const handleJumpToChat = () => {
    const url = chrome.runtime.getURL(
      `viewer.html?chatId=${item.chatId}&messageId=${item.messageId}`,
    );
    chrome.tabs.create({ url, active: true });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={(e) => {
        // Close on overlay click
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Media Content Container */}
      <div className="relative w-full h-full flex items-center justify-center max-w-[95vw] max-h-[95vh]">
        {/* Media Content */}
        {loading ? (
          <div className="text-white text-lg">Loading...</div>
        ) : isVideo ? (
          <video
            src={item.content}
            controls
            className="max-w-full max-h-full w-auto h-auto border-2 border-white object-contain bg-black"
            style={{
              boxShadow: "4px 4px 0 0 rgba(255,255,255,0.2)",
            }}
          />
        ) : (
          <img
            src={item.content}
            alt={item.chatTitle}
            className="max-w-full max-h-full w-auto h-auto border-2 border-white object-contain bg-black"
            style={{
              boxShadow: "4px 4px 0 0 rgba(255,255,255,0.2)",
            }}
          />
        )}

        {/* Top Right Buttons - Close, Download, Open */}
        <div
          className={`absolute top-4 right-4 flex gap-2 z-50 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          {/* Open in Viewer Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleJumpToChat();
            }}
            className="w-12 h-12 flex items-center justify-center bg-black/80 border-2 border-white hover:bg-white hover:text-black transition-colors"
            title="Open in Viewer"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </button>

          {/* Download Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
            className="w-12 h-12 flex items-center justify-center bg-black/80 border-2 border-white hover:bg-white hover:text-black transition-colors"
            title="Download"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </button>

          {/* Close Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="w-12 h-12 flex items-center justify-center bg-black/80 border-2 border-white hover:bg-white hover:text-black transition-colors"
            title="Close (ESC)"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Previous Button - Left side, vertically centered */}
        {hasPrev && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNavigate("prev");
            }}
            disabled={loading}
            className={`absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center bg-black/80 border-2 border-white hover:bg-white hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed z-40 ${
              showControls ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
            title="Previous (←)"
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        )}

        {/* Next Button - Right side, vertically centered (offset to avoid top buttons) */}
        {hasNext && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNavigate("next");
            }}
            disabled={loading}
            className={`absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center bg-black/80 border-2 border-white hover:bg-white hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed z-40 ${
              showControls ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
            title="Next (→)"
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* Footer Info - Overlay at bottom, only visible when controls are shown */}
        <div
          className={`absolute bottom-4 left-4 right-4 z-50 transition-opacity duration-300 ${
            showControls ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-black/80 border-2 border-white p-4 text-white max-w-md">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-bold uppercase tracking-wider text-white/80">
                {item.source}
              </p>
              <p className="text-sm font-medium">{item.chatTitle}</p>
              <div className="flex items-center gap-3 text-xs text-white/70">
                <span className="capitalize">{item.role}</span>
                {item.timestamp && (
                  <>
                    <span>•</span>
                    <span>{new Date(item.timestamp).toLocaleString()}</span>
                  </>
                )}
                <span>•</span>
                <span>{item.mediaType}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
