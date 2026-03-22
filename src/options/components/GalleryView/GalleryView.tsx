import { useCallback, useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import type { GalleryMediaItem } from "../../../types/workerMessages";
import { log } from "../../../utils/logger";
import { ICONS, Icon } from "../../utils";
import { Pagination } from "../ArchiveView/Pagination";
import { MediaCard } from "./MediaCard";
import { MediaModal } from "./MediaModal";

export const GalleryView = () => {
  // State
  const [items, setItems] = useState<GalleryMediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filterProvider, setFilterProvider] = useState("all");
  const [filterRole, setFilterRole] = useState<"all" | "user" | "assistant">("assistant");
  const [filterMediaType, setFilterMediaType] = useState<"all" | "image" | "video">("all");
  const [sortBy, _setSortBy] = useState("generatedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<GalleryMediaItem | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // NEW state for lazy loading full-resolution content
  const [fullResContent, setFullResContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Load gallery media
  const loadGalleryMedia = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const response = await chrome.runtime.sendMessage({
        action: "getGalleryMedia",
        offset,
        limit: pageSize,
        filterProvider: filterProvider !== "all" ? filterProvider : undefined,
        filterRole,
        filterMediaType,
        sortBy,
        sortDirection,
      });

      if (response.success) {
        setItems(response.items || []);
        setTotal(response.total || 0);
      } else {
        log.error("[GalleryView] Failed to load media:", response.error);
        setItems([]);
        setTotal(0);
      }
    } catch (error) {
      log.error("[GalleryView] Error loading gallery media:", error);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filterProvider, filterRole, filterMediaType, sortBy, sortDirection]);

  const filterKey = `${filterProvider}|${filterRole}|${filterMediaType}|${sortBy}|${sortDirection}|${pageSize}`;
  const prevFilterKeyRef = useRef(filterKey);

  // Load media on mount and when filters/pagination change
  useEffect(() => {
    const prevFilterKey = prevFilterKeyRef.current;
    if (filterKey !== prevFilterKey) {
      prevFilterKeyRef.current = filterKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    loadGalleryMedia();
  }, [filterKey, page, loadGalleryMedia]);

  // Handle card click with lazy loading - wrapped in useCallback for stable reference
  const handleCardClick = useCallback(async (item: GalleryMediaItem, index: number) => {
    setSelectedItem(item);
    setSelectedIndex(index);
    setFullResContent(null); // Reset

    // Lazy load full content
    setLoadingContent(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "getGalleryContent",
        chatId: item.chatId,
        messageId: item.messageId,
      });
      if (resp.success) {
        setFullResContent(resp.data);
      }
    } catch (e) {
      log.error("Failed to load high-res content", e);
    } finally {
      setLoadingContent(false);
    }
  }, []);

  // Handle modal close
  const handleModalClose = () => {
    setSelectedItem(null);
    setSelectedIndex(-1);
  };

  // Handle navigation in modal with lazy loading
  const handleNavigate = async (direction: "prev" | "next") => {
    const newIndex = direction === "prev" ? selectedIndex - 1 : selectedIndex + 1;
    const globalIndex = (page - 1) * pageSize + newIndex;

    // Check if we need to load a different page
    const newPage = Math.floor(globalIndex / pageSize) + 1;

    if (newPage !== page) {
      // Load new page
      setLoading(true);
      try {
        const offset = (newPage - 1) * pageSize;
        const response = await chrome.runtime.sendMessage({
          action: "getGalleryMedia",
          offset,
          limit: pageSize,
          filterProvider: filterProvider !== "all" ? filterProvider : undefined,
          filterRole,
          filterMediaType,
          sortBy,
          sortDirection,
        });

        if (response.success) {
          const newItems = response.items || [];
          setItems(newItems);
          setPage(newPage);

          // Calculate local index in new page
          const localIndex = globalIndex % pageSize;
          const nextItem = newItems[localIndex];
          setSelectedItem(nextItem);
          setSelectedIndex(localIndex);

          // Lazy load content for new item
          setFullResContent(null);
          setLoadingContent(true);
          try {
            const resp = await chrome.runtime.sendMessage({
              action: "getGalleryContent",
              chatId: nextItem.chatId,
              messageId: nextItem.messageId,
            });
            if (resp.success) setFullResContent(resp.data);
          } finally {
            setLoadingContent(false);
          }
        }
      } catch (error) {
        log.error("[GalleryView] Error navigating:", error);
      } finally {
        setLoading(false);
      }
    } else {
      // Same page, just update selection
      const nextItem = items[newIndex];
      setSelectedItem(nextItem);
      setSelectedIndex(newIndex);

      // Lazy load content for new item
      setFullResContent(null);
      setLoadingContent(true);
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "getGalleryContent",
          chatId: nextItem.chatId,
          messageId: nextItem.messageId,
        });
        if (resp.success) setFullResContent(resp.data);
      } catch (error) {
        log.error("[GalleryView] Error loading content during navigation:", error);
      } finally {
        setLoadingContent(false);
      }
    }
  };

  // Check if navigation is possible
  const canNavigatePrev = () => {
    const globalIndex = (page - 1) * pageSize + selectedIndex;
    return globalIndex > 0;
  };

  const canNavigateNext = () => {
    const globalIndex = (page - 1) * pageSize + selectedIndex;
    return globalIndex < total - 1;
  };

  return (
    <div className="flex-1 p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-[hsl(var(--foreground))] uppercase tracking-wider">
            Gallery
          </h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{total} media items</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Provider Filter */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="filterProvider"
            className="text-xs font-bold text-[hsl(var(--muted-foreground))] uppercase"
          >
            Provider:
          </label>
          <Select value={filterProvider} onValueChange={setFilterProvider}>
            <SelectTrigger id="filterProvider" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="poe">Poe</SelectItem>
              <SelectItem value="chatgpt">ChatGPT</SelectItem>
              <SelectItem value="openwebui">Open WebUI</SelectItem>
              <SelectItem value="qwen">Qwen</SelectItem>
              <SelectItem value="deepseek">DeepSeek</SelectItem>
              <SelectItem value="aistudio">AI Studio</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Role Filter */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="filterRole"
            className="text-xs font-bold text-[hsl(var(--muted-foreground))] uppercase"
          >
            Content:
          </label>
          <Select
            value={filterRole}
            onValueChange={(v) => {
              if (v === "all" || v === "user" || v === "assistant") {
                setFilterRole(v);
              }
            }}
          >
            <SelectTrigger id="filterRole" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="user">User Uploads</SelectItem>
              <SelectItem value="assistant">AI Generated</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Media Type Filter */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="filterMediaType"
            className="text-xs font-bold text-[hsl(var(--muted-foreground))] uppercase"
          >
            Type:
          </label>
          <Select
            value={filterMediaType}
            onValueChange={(v) => {
              if (
                v === "all" ||
                v === "image" ||
                v === "video" ||
                v === "audio" ||
                v === "document"
              ) {
                setFilterMediaType(v);
              }
            }}
          >
            <SelectTrigger id="filterMediaType" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Media</SelectItem>
              <SelectItem value="image">Images Only</SelectItem>
              <SelectItem value="video">Videos Only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sort Direction */}
        <button
          onClick={() => setSortDirection(sortDirection === "asc" ? "desc" : "asc")}
          className="px-3 py-2 border-2 border-[hsl(var(--border))] hover:border-[hsl(var(--primary))] transition-colors"
          title={sortDirection === "asc" ? "Oldest first" : "Newest first"}
        >
          <Icon icon={sortDirection === "asc" ? ICONS.sort_asc : ICONS.sort_desc} />
        </button>
      </div>

      {/* Grid */}
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading gallery...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center space-y-2">
            <p className="text-lg font-bold text-[hsl(var(--muted-foreground))]">No media found</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Try adjusting your filters or sync some chats with images/videos
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {items.map((item, index) => (
              <MediaCard key={item.id} item={item} index={index} onMediaClick={handleCardClick} />
            ))}
          </div>

          {/* Pagination */}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}

      {/* Modal */}
      {selectedItem && (
        <MediaModal
          item={{
            ...selectedItem,
            content: fullResContent || selectedItem.thumbnail, // Show thumbnail while loading full res
          }}
          onClose={handleModalClose}
          onNavigate={handleNavigate}
          hasPrev={canNavigatePrev()}
          hasNext={canNavigateNext()}
          loading={loadingContent} // Show loading state while fetching full content
        />
      )}
    </div>
  );
};
