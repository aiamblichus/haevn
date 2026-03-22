import { memo, useCallback } from "react";
import type { GalleryMediaItem } from "../../../types/workerMessages";

interface MediaCardProps {
  item: GalleryMediaItem;
  index: number;
  onMediaClick: (item: GalleryMediaItem, index: number) => void;
}

export const MediaCard = memo(
  ({ item, index, onMediaClick }: MediaCardProps) => {
    // Create a stable handler for this specific instance
    const handleClick = useCallback(() => {
      onMediaClick(item, index);
    }, [item, index, onMediaClick]);

    const isVideo = item.mediaType.startsWith("video/");

    return (
      <button
        onClick={handleClick}
        className="group relative aspect-square overflow-hidden border-2 border-[hsl(var(--border))] hover:border-[hsl(var(--primary))] transition-all duration-200 bg-[hsl(var(--card))]"
        style={{
          boxShadow: "2px 2px 0 0 rgba(0,0,0,0.2)",
        }}
      >
        {/* Thumbnail */}
        <div
          className="w-full h-full bg-cover bg-center"
          style={{
            backgroundImage: `url(${item.thumbnail})`,
            // Performance: Tell browser not to smooth-scale small thumbnails excessively
            imageRendering: "auto",
          }}
        />

        {/* Video Indicator */}
        {isVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 flex items-center justify-center bg-black/50 border-2 border-white rounded-full">
              <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
              </svg>
            </div>
          </div>
        )}

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-start justify-end p-3 text-left">
          <p className="text-[10px] font-bold text-white uppercase tracking-wider mb-1">
            {item.source}
          </p>
          <p className="text-xs text-white font-medium line-clamp-2 mb-1 break-words w-full">
            {item.chatTitle}
          </p>
          <div className="flex items-center gap-2 text-[10px] text-white/80">
            <span className="capitalize">{item.role}</span>
          </div>
        </div>
      </button>
    );
  },
  (prevProps, nextProps) => {
    return prevProps.item.id === nextProps.item.id;
  },
);

MediaCard.displayName = "MediaCard";
