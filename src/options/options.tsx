import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { aistudioProvider } from "../providers/aistudio/provider";
import { chatgptProvider } from "../providers/chatgpt/provider";
import { claudeProvider } from "../providers/claude/provider";
import { deepseekProvider } from "../providers/deepseek/provider";
import { geminiProvider } from "../providers/gemini/provider";
import { openwebuiProvider } from "../providers/openwebui/provider";
import { poeProvider } from "../providers/poe/provider";
import { registerProvider } from "../providers/provider";
import { qwenProvider } from "../providers/qwen/provider";
import type { BackgroundEvent, BackgroundRequest, BackgroundResponse } from "../types/messaging";
import { log } from "../utils/logger";
import "./debug";
import { ExportModal } from "../components/ExportModal";
import { ArchiveView } from "./components/ArchiveView/ArchiveView";
import { GalleryView } from "./components/GalleryView/GalleryView";
import { Header } from "./components/Layout/Header";
import { Sidebar } from "./components/Layout/Sidebar";
import { ManifestoView } from "./components/ManifestoView/ManifestoView";
import { ImportModal } from "./components/Modals/ImportModal";
import { ProvidersView } from "./components/ProvidersView/ProvidersView";
import { StatusContext } from "./context/StatusContext";
import { useApi } from "./hooks/useApi";
import { SettingsView } from "./settings";
import type {
  ChatMeta,
  ExportOptions,
  SearchResult,
  SortDirection,
  SortKey,
  StatusKind,
} from "./types";

// Register providers for use in Options page
registerProvider(geminiProvider);
registerProvider(claudeProvider);
registerProvider(poeProvider);
registerProvider(chatgptProvider);
registerProvider(openwebuiProvider);
registerProvider(qwenProvider);
registerProvider(aistudioProvider);
registerProvider(deepseekProvider);

const App = () => {
  const [activeView, setActiveView] = useState("archive");
  const [displayedChats, setDisplayedChats] = useState<ChatMeta[]>([]);
  const [totalChats, setTotalChats] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [searchQuery, setSearchQuery] = useState("");
  const [filterProvider, setFilterProvider] = useState("all");
  const [sortBy, setSortBy] = useState<SortKey>("lastSyncedTimestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const exportOptions: ExportOptions = {
    format: "json",
    includeMetadata: true,
    includeTimestamps: true,
  };
  const [isExportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalIds, setExportModalIds] = useState<string[] | null>(null);
  const [isImportModalOpen, setImportModalOpen] = useState(false);
  const [importProviderFilter, setImportProviderFilter] = useState<string | null>(null);
  const [openableById, setOpenableById] = useState<Record<string, boolean>>({});
  const [chatPage, setChatPage] = useState(1);
  const [chatPageSize, setChatPageSize] = useState(25);
  const [searchPage, setSearchPage] = useState(1);
  const [searchPageSize, setSearchPageSize] = useState(10);
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [loadingExpandedChats, setLoadingExpandedChats] = useState<Set<string>>(new Set());

  // Optimize search result deduplication
  const searchResultIds = React.useRef<Set<string>>(new Set());

  // Status via context
  const [statusText, setStatusText] = useState("Ready");
  const [statusColor, setStatusColor] = useState("text-blue-600");
  const setStatus = useCallback((text: string, kind: StatusKind = "ok") => {
    setStatusText(text);
    const color =
      kind === "ok"
        ? "text-green-600"
        : kind === "warn"
          ? "text-yellow-600"
          : kind === "error"
            ? "text-red-600"
            : "text-blue-600";
    setStatusColor(color);
  }, []);

  const { syncChatById, openChatInProvider, openChatInViewer, exportChatById } = useApi();

  const loadChats = useCallback(async () => {
    setStatus("Loading chats...", "work");
    try {
      const offset = (chatPage - 1) * chatPageSize;
      const request: BackgroundRequest = {
        action: "getSyncedChatsMetadata",
        offset,
        limit: chatPageSize,
        filterProvider: filterProvider !== "all" ? filterProvider : undefined,
        sortBy,
        sortDirection,
      };
      const resp = await chrome.runtime.sendMessage(request);
      if (!resp?.success) {
        throw new Error("error" in resp ? resp.error : "Failed");
      }
      if ("data" in resp && "total" in resp) {
        setDisplayedChats((resp.data || []) as ChatMeta[]);
        setTotalChats(resp.total || 0);
      }
      setSelectedIds(new Set());
      setStatus("Loaded.", "ok");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Failed to load chats: ${msg}`, "error");
    }
  }, [setStatus, chatPage, chatPageSize, filterProvider, sortBy, sortDirection]);

  // Determine provider-open visibility for Open WebUI by peeking at chat params
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Debounce the check to prevent rapid re-runs during bulk syncs
    const checkOpenWebUIChats = () => {
      const missing = displayedChats.filter(
        (c) => (c.source || "").includes("openwebui") && openableById[c.id] === undefined,
      );

      if (missing.length === 0) return;

      // Use metadata params instead of loading full content - much more efficient!
      const updates: Record<string, boolean> = {};
      for (const chat of missing) {
        const hasOrigin = !!(chat.params && typeof chat.params === "object"
          ? chat.params?.openwebui_origin
          : undefined);
        updates[chat.id] = hasOrigin;
      }

      if (cancelled) return;

      setOpenableById((prev) => {
        const next = { ...prev };
        for (const [id, value] of Object.entries(updates)) {
          if (next[id] === undefined) {
            next[id] = value;
          }
        }
        return next;
      });
    };

    // Debounce with 300ms delay to batch rapid updates (e.g., during bulk syncs)
    timeoutId = setTimeout(() => {
      checkOpenWebUIChats();
    }, 300);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [displayedChats, openableById]);

  useEffect(() => {
    loadChats();

    const messageListener = (message: unknown): boolean | undefined => {
      // Type guard to check if it's a BackgroundEvent
      if (typeof message === "object" && message !== null && "action" in message) {
        const event = message as BackgroundEvent;
        switch (event.action) {
          case "chatSynced":
            // Reload current page to reflect the update
            loadChats();
            break;
          case "bulkSyncProgress": {
            let progressStatus = `${Math.round(event.progress)}% - ${event.status}`;
            if (event.failedCount && event.failedCount > 0) {
              progressStatus += ` (${event.failedCount} failed)`;
            }
            setStatus(progressStatus, "work");
            break;
          }
          case "bulkSyncComplete":
            setStatus(event.status || "Bulk sync complete.", "ok");
            loadChats();
            break;
          case "bulkSyncFailed":
            setStatus(`Bulk sync failed: ${event.error}`, "error");
            break;
          case "bulkSyncCanceled":
            setStatus(event.status || "Bulk sync canceled.", "warn");
            break;
          case "bulkExportProgress":
            if (event.total > 0) {
              const percent = Math.round((event.processed / event.total) * 100);
              const statusText =
                event.status || `Batch ${event.currentBatch || 0}/${event.totalBatches || 0}`;
              setStatus(`Exporting: ${statusText} (${percent}%)`, "work");
            }
            break;
          case "bulkExportStarted":
            setStatus(
              `Export started: ${event.totalChats} chats in ${event.totalBatches} batch(es)`,
              "work",
            );
            break;
          case "bulkExportComplete":
            setStatus(event.message || "Export complete.", "ok");
            break;
          case "bulkExportCanceled":
            setStatus(event.status || "Export canceled.", "warn");
            break;
          case "bulkExportFailed":
            setStatus(`Export failed: ${event.error || "Unknown error"}`, "error");
            break;
          case "searchStreamingStarted":
            // Search started - results will arrive via searchStreamingResults
            if (event.query === searchQuery && (event.filterProvider || "all") === filterProvider) {
              log.info(`[Options] Search streaming started for query: "${event.query}"`, {
                filterProvider: event.filterProvider,
              });
              setIsSearching(true);
            } else {
              log.warn(`[Options] Received start for different query:`, {
                receivedQuery: event.query,
                currentQuery: searchQuery,
                receivedFilterProvider: event.filterProvider,
                currentFilterProvider: filterProvider,
              });
            }
            break;
          case "searchStreamingResults":
            // Accumulate results as they arrive
            if (event.query === searchQuery && (event.filterProvider || "all") === filterProvider) {
              const results = (event.results || []) as SearchResult[];
              log.debug(`[Options] Received search results batch:`, {
                query: event.query,
                filterProvider: event.filterProvider,
                batchSize: results.length,
                results: results.map((r) => ({
                  chatId: r.chatId,
                  messageId: r.messageId,
                  role: r.messageRole,
                })),
              });

              // Optimized deduplication using Ref
              const newUnique: SearchResult[] = [];
              for (const r of results) {
                const key = `${r.chatId}:${r.messageId}`;
                if (!searchResultIds.current.has(key)) {
                  searchResultIds.current.add(key);
                  newUnique.push(r);
                }
              }

              if (newUnique.length > 0) {
                setSearchResults((prev) => [...(prev || []), ...newUnique]);
                log.debug(`[Options] Updated search results:`, {
                  newInBatch: newUnique.length,
                });
              }
            } else {
              log.warn(`[Options] Received results for different query:`, {
                receivedQuery: event.query,
                currentQuery: searchQuery,
                receivedFilterProvider: event.filterProvider,
                currentFilterProvider: filterProvider,
              });
            }
            break;
          case "searchStreamingComplete":
            // Search complete
            if (event.query === searchQuery && (event.filterProvider || "all") === filterProvider) {
              log.info(`[Options] Search streaming complete:`, {
                query: event.query,
                filterProvider: event.filterProvider,
                totalResults: event.totalResults,
                chatsScanned: event.chatsScanned,
                durationMs: event.durationMs,
                wasLimited: event.wasLimited,
              });
              setIsSearching(false);
              setStatus(
                `Found ${event.totalResults} results in ${event.durationMs.toFixed(0)}ms (scanned ${
                  event.chatsScanned
                } chats)`,
                "ok",
              );
            } else {
              log.warn(`[Options] Received completion for different query:`, {
                receivedQuery: event.query,
                currentQuery: searchQuery,
                receivedFilterProvider: event.filterProvider,
                currentFilterProvider: filterProvider,
              });
            }
            break;
          case "searchStreamingFailed":
            // Search failed
            if (event.query === searchQuery && (event.filterProvider || "all") === filterProvider) {
              log.error(`[Options] Search streaming failed:`, {
                query: event.query,
                filterProvider: event.filterProvider,
                error: event.error,
              });
              setIsSearching(false);
              setSearchResults([]);
              setStatus(`Search failed: ${event.error}`, "error");
            } else {
              log.warn(`[Options] Received failure for different query:`, {
                receivedQuery: event.query,
                currentQuery: searchQuery,
                receivedFilterProvider: event.filterProvider,
                currentFilterProvider: filterProvider,
                error: event.error,
              });
            }
            break;
        }
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [loadChats, setStatus, searchQuery]);

  useEffect(() => {
    if (!searchQuery) {
      log.debug("[Options] Search query cleared, resetting search state");
      setSearchResults(null);
      setIsSearching(false);
      setExpandedChats(new Set());
      setLoadingExpandedChats(new Set());
      searchResultIds.current.clear();
      return;
    }

    log.info(`[Options] Search params changed:`, {
      query: searchQuery,
      filterProvider,
    });

    // Cancel any previous search
    const cancelPrevious = async () => {
      try {
        log.debug("[Options] Cancelling previous search");
        await chrome.runtime.sendMessage({
          action: "cancelSearchStreaming",
          query: "", // Query is ignored - cancels all active searches
        } as BackgroundRequest);
      } catch (error) {
        log.warn("[Options] Error cancelling previous search:", error);
      }
    };

    // Clear previous results
    setSearchResults([]);
    searchResultIds.current.clear();
    setIsSearching(true);

    // Debounce search start
    const timer = setTimeout(async () => {
      try {
        log.info(`[Options] Starting search after debounce: "${searchQuery}"`);
        // Cancel any previous search first
        await cancelPrevious();

        // Start streaming search
        // Fetch 4 matches per chat initially (but only show 3)
        // This way we know if there are more matches to lazy load
        const request: BackgroundRequest = {
          action: "searchChatsStreaming",
          query: searchQuery,
          filterProvider: filterProvider !== "all" ? filterProvider : undefined,
          streamBatchSize: 5,
          maxChatsToScan: 1000,
          resultsPerChat: 4, // Fetch 4, show 3 - if we have 4, we know there might be more
        };
        log.debug("[Options] Sending searchChatsStreaming request:", {
          query: searchQuery,
          streamBatchSize: request.streamBatchSize,
          maxChatsToScan: request.maxChatsToScan,
          resultsPerChat: request.resultsPerChat,
        });
        await chrome.runtime.sendMessage(request);
        log.debug("[Options] Search request sent successfully");
        // Results will arrive via events handled in messageListener
      } catch (error) {
        setIsSearching(false);
        setSearchResults([]);
        log.error("[Options] Failed to start streaming search:", error);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      // Cancel search on cleanup
      cancelPrevious();
    };
  }, [searchQuery, filterProvider]);

  // Reset pagination when filters change
  useEffect(() => {
    log.debug("[Options] Filters changed, resetting pagination", {
      filterProvider,
      sortBy,
      sortDirection,
    });
    setChatPage(1);
  }, [filterProvider, sortBy, sortDirection]);

  // Reset search pagination when search query changes
  useEffect(() => {
    log.debug("[Options] Search params changed, resetting search pagination", {
      searchQuery,
      filterProvider,
    });
    setSearchPage(1);
  }, [searchQuery, filterProvider]);

  // Reload chats when pagination, filter, or sort changes
  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const handleToggleSelect = (id: string, isChecked: boolean) => {
    const newSelectedIds = new Set(selectedIds);
    if (isChecked) newSelectedIds.add(id);
    else newSelectedIds.delete(id);
    setSelectedIds(newSelectedIds);
  };

  const handleToggleSelectMultiple = useCallback((ids: string[], isChecked: boolean) => {
    setSelectedIds((prev) => {
      const newSelectedIds = new Set(prev);
      if (isChecked) {
        for (const id of ids) {
          newSelectedIds.add(id);
        }
      } else {
        for (const id of ids) {
          newSelectedIds.delete(id);
        }
      }
      return newSelectedIds;
    });
  }, []);

  const openExportModal = useCallback(async (ids: string[]) => {
    setExportModalIds(ids);
    setExportModalOpen(true);
  }, []);

  const handleTableAction = useCallback(
    async (action: string, id: string) => {
      switch (action) {
        case "sync":
          if (await syncChatById(id)) loadChats();
          break;
        case "open_provider":
          await openChatInProvider(id);
          break;
        case "open_viewer":
          await openChatInViewer(id);
          break;
        case "export":
          await openExportModal([id]);
          break;
        case "delete":
          if (confirm("Delete this chat from the archive?")) {
            const request: BackgroundRequest = {
              action: "deleteSyncedChats",
              chatIds: [id],
            };
            await chrome.runtime.sendMessage(request);
            loadChats();
          }
          break;
      }
    },
    [syncChatById, openChatInProvider, openChatInViewer, openExportModal, loadChats],
  );

  const handleSearchResultAction = useCallback(
    async (action: string, payload: SearchResult | string) => {
      const chatId = typeof payload === "string" ? payload : payload.chatId;
      switch (action) {
        case "open_viewer": {
          if (typeof payload === "string") {
            await openChatInViewer(chatId, undefined, searchQuery);
          } else {
            const result = payload;
            await openChatInViewer(result.chatId, result.messageId, searchQuery);
          }
          break;
        }
        case "export":
          await openExportModal([chatId]);
          break;
      }
    },
    [openChatInViewer, searchQuery, openExportModal],
  );

  const handleExpandChat = useCallback(
    async (chatId: string) => {
      if (expandedChats.has(chatId)) {
        // Collapse: keep only first 4 matches (so button can appear again if there were more)
        setSearchResults((prev) => {
          if (!prev) return prev;
          const chatResults = prev.filter((r) => r.chatId === chatId);
          const otherResults = prev.filter((r) => r.chatId !== chatId);
          // Keep only first 4 matches for this chat (so we know if there are more)
          const limited = chatResults.slice(0, 4);
          return [...otherResults, ...limited];
        });
        setExpandedChats((prev) => {
          const next = new Set(prev);
          next.delete(chatId);
          return next;
        });
      } else {
        // Expand: fetch all matches
        setLoadingExpandedChats((prev) => {
          const next = new Set(prev);
          next.add(chatId);
          return next;
        });
        try {
          const request: BackgroundRequest = {
            action: "getAllMatchesForChat",
            query: searchQuery,
            chatId,
          };
          const resp = (await chrome.runtime.sendMessage(request)) as BackgroundResponse;
          if (resp?.success && "results" in resp && Array.isArray(resp.results)) {
            const allMatches = resp.results as SearchResult[];
            // Only update if we got results (defensive check)
            if (allMatches.length > 0) {
              setSearchResults((prev) => {
                if (!prev) return prev;
                // Preserve order: find where this chat's results were, replace them
                const result: SearchResult[] = [];
                let foundChat = false;
                for (const r of prev) {
                  if (r.chatId === chatId) {
                    // First time we encounter this chat, add all matches
                    if (!foundChat) {
                      result.push(...allMatches);
                      foundChat = true;
                    }
                    // Skip other matches for this chat (we've already added all)
                  } else {
                    result.push(r);
                  }
                }
                // If we didn't find the chat (shouldn't happen), add at end
                if (!foundChat) {
                  result.push(...allMatches);
                }
                return result;
              });
              setExpandedChats((prev) => {
                const next = new Set(prev);
                next.add(chatId);
                return next;
              });
            } else {
              log.warn(`No matches found for chat ${chatId} when expanding`);
            }
          } else {
            log.error("Failed to get all matches: invalid response", resp);
          }
        } catch (error) {
          log.error("Failed to load all matches:", error);
        } finally {
          setLoadingExpandedChats((prev) => {
            const next = new Set(prev);
            next.delete(chatId);
            return next;
          });
        }
      }
    },
    [expandedChats, searchQuery],
  );

  const handleExportSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await openExportModal(ids);
  }, [selectedIds, openExportModal]);

  const handleExportAll = useCallback(async () => {
    let ids: string[];

    // If search results are active, export all unique chat IDs from search results
    if (searchResults && searchResults.length > 0) {
      const uniqueChatIds = new Set(searchResults.map((r) => r.chatId));
      ids = Array.from(uniqueChatIds);
    } else {
      // For paginated view, we need to fetch all matching chats
      // This is a special case - we'll fetch all chats matching the current filter
      try {
        const request: BackgroundRequest = {
          action: "getSyncedChatsMetadata",
          offset: 0,
          limit: 10000, // Large limit to get all chats
          filterProvider: filterProvider !== "all" ? filterProvider : undefined,
          sortBy,
          sortDirection,
        };
        const resp = await chrome.runtime.sendMessage(request);
        if (resp?.success && "data" in resp && Array.isArray(resp.data)) {
          ids = (resp.data as ChatMeta[]).map((c) => c.id);
        } else {
          ids = displayedChats.map((c) => c.id);
        }
      } catch {
        // Fallback to displayed chats if fetch fails
        ids = displayedChats.map((c) => c.id);
      }
    }

    if (ids.length === 0) return;
    await openExportModal(ids);
  }, [displayedChats, filterProvider, searchResults, sortBy, sortDirection, openExportModal]);

  const handleDeleteSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected chat(s) from the archive?`)) return;
    const request: BackgroundRequest = {
      action: "deleteSyncedChats",
      chatIds: ids,
    };
    await chrome.runtime.sendMessage(request);
    setSelectedIds(new Set());
    loadChats();
  }, [selectedIds, loadChats]);

  return (
    <StatusContext.Provider value={{ text: statusText, color: statusColor, setStatus }}>
      <div className="flex h-screen bg-background">
        <Sidebar activeView={activeView} setActiveView={setActiveView} />
        <div className="flex-1 ml-64 flex flex-col">
          <Header activeView={activeView} />

          <main className="flex-1 overflow-auto p-6 mt-16">
            {activeView === "providers" ? (
              <ProvidersView
                isActive={activeView === "providers"}
                onRefreshChats={loadChats}
                onOpenImportModal={() => {
                  setImportProviderFilter(null);
                  setImportModalOpen(true);
                }}
                setImportProviderFilter={(format) => {
                  setImportProviderFilter(format);
                }}
              />
            ) : activeView === "gallery" ? (
              <GalleryView />
            ) : activeView === "settings" ? (
              <SettingsView />
            ) : activeView === "manifesto" ? (
              <ManifestoView />
            ) : (
              <ArchiveView
                displayedChats={displayedChats}
                totalChats={totalChats}
                searchResults={searchResults}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                setSearchResults={setSearchResults}
                isSearching={isSearching}
                selectedIds={selectedIds}
                filterProvider={filterProvider}
                setFilterProvider={setFilterProvider}
                sortBy={sortBy}
                setSortBy={setSortBy}
                sortDirection={sortDirection}
                setSortDirection={setSortDirection}
                chatPage={chatPage}
                setChatPage={setChatPage}
                chatPageSize={chatPageSize}
                setChatPageSize={setChatPageSize}
                searchPage={searchPage}
                setSearchPage={setSearchPage}
                searchPageSize={searchPageSize}
                setSearchPageSize={setSearchPageSize}
                openableById={openableById}
                onImportClick={() => {
                  setImportModalOpen(true);
                  setImportProviderFilter(null);
                }}
                onExportSelected={handleExportSelected}
                onExportAll={handleExportAll}
                onDeleteSelected={handleDeleteSelected}
                onRefresh={loadChats}
                onTableAction={handleTableAction}
                onToggleSelect={handleToggleSelect}
                onToggleSelectMultiple={handleToggleSelectMultiple}
                onSearchResultAction={handleSearchResultAction}
                onOpenChatInProvider={openChatInProvider}
                onOpenExportModal={openExportModal}
                expandedChats={expandedChats}
                loadingExpandedChats={loadingExpandedChats}
                onExpandChat={handleExpandChat}
              />
            )}
          </main>
        </div>
      </div>
      <ExportModal
        open={isExportModalOpen}
        onOpenChange={setExportModalOpen}
        exportModalIds={exportModalIds}
        exportOptions={exportOptions}
        onStatus={setStatus}
        onExportChatById={exportChatById}
        onClose={() => {
          setExportModalOpen(false);
          setExportModalIds(null);
        }}
      />
      <ImportModal
        open={isImportModalOpen}
        onOpenChange={setImportModalOpen}
        importProviderFilter={importProviderFilter}
        onLoadChats={loadChats}
      />
    </StatusContext.Provider>
  );
};

// --- Mount Application ---
const container = document.getElementById("app");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
