import React, { useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as List } from "react-window";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Table, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import type { ChatMeta, SearchResult, SortDirection, SortKey } from "../../types";
import { ICONS, Icon } from "../../utils";
import { ChatTableRow } from "./ChatTableRow";
import { Pagination } from "./Pagination";
import { SearchResultGroup } from "./SearchResultGroup";

interface ArchiveViewProps {
  displayedChats: ChatMeta[];
  totalChats: number;
  searchResults: SearchResult[] | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: SearchResult[] | null) => void;
  isSearching: boolean;
  selectedIds: Set<string>;
  filterProvider: string;
  setFilterProvider: (provider: string) => void;
  filterCategory: string;
  setFilterCategory: (category: string) => void;
  availableCategories: string[];
  sortBy: SortKey;
  setSortBy: (key: SortKey) => void;
  sortDirection: SortDirection;
  setSortDirection: (dir: SortDirection) => void;
  chatPage: number;
  setChatPage: (page: number) => void;
  chatPageSize: number;
  setChatPageSize: (size: number) => void;
  searchPage: number;
  setSearchPage: (page: number) => void;
  searchPageSize: number;
  setSearchPageSize: (size: number) => void;
  openableById: Record<string, boolean>;
  onImportClick: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
  onDeleteSelected: () => void;
  onRefresh: () => void;
  onTableAction: (action: string, id: string) => void;
  onToggleSelect: (id: string, checked: boolean) => void;
  onToggleSelectMultiple: (ids: string[], checked: boolean) => void;
  onSearchResultAction: (action: string, payload: SearchResult | string) => void;
  onOpenChatInProvider: (id: string) => void;
  onOpenExportModal: (ids: string[]) => void;
  expandedChats?: Set<string>;
  loadingExpandedChats?: Set<string>;
  onExpandChat?: (chatId: string) => void | Promise<void>;
}

export const ArchiveView = ({
  displayedChats,
  totalChats,
  searchResults,
  searchQuery,
  setSearchQuery,
  setSearchResults,
  isSearching,
  selectedIds,
  filterProvider,
  setFilterProvider,
  filterCategory,
  setFilterCategory,
  availableCategories,
  sortBy,
  setSortBy,
  sortDirection,
  setSortDirection,
  chatPage,
  setChatPage,
  chatPageSize,
  setChatPageSize,
  searchPage,
  setSearchPage,
  searchPageSize,
  setSearchPageSize,
  openableById,
  onImportClick,
  onExportSelected,
  onExportAll,
  onDeleteSelected,
  onRefresh,
  onTableAction,
  onToggleSelect,
  onToggleSelectMultiple,
  onSearchResultAction,
  onOpenChatInProvider,
  onOpenExportModal,
  expandedChats = new Set(),
  loadingExpandedChats = new Set(),
  onExpandChat,
}: ArchiveViewProps) => {
  // No client-side filtering/sorting needed - data comes pre-filtered and sorted from DB
  const isAllSelected = useMemo(() => {
    const visibleIds = displayedChats.map((c) => c.id);
    return visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  }, [displayedChats, selectedIds]);

  const handleSelectAll = (checked: boolean | undefined) => {
    const isChecked = !!checked;
    // Select all visible items in the current page
    const visibleIds = displayedChats.map((chat) => chat.id);
    onToggleSelectMultiple(visibleIds, isChecked);
  };

  // Dynamic height calculation for virtualized list
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState(600);

  useEffect(() => {
    const updateHeight = () => {
      if (tableContainerRef.current) {
        const rect = tableContainerRef.current.getBoundingClientRect();
        setTableHeight(Math.max(100, rect.height)); // Ensure minimum height
      }
    };

    // Initial calculation
    const timeoutId = setTimeout(updateHeight, 0);

    window.addEventListener("resize", updateHeight);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  // Recalculate when controls might change layout
  useEffect(() => {
    if (tableContainerRef.current) {
      const timeoutId = setTimeout(() => {
        const rect = tableContainerRef.current?.getBoundingClientRect();
        if (rect) {
          setTableHeight(Math.max(100, rect.height));
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, []);

  // Memoize search results grouping to avoid re-calculation on every render
  const { searchPagedGroups, searchTotalGroups } = useMemo(() => {
    if (!searchResults || searchResults.length === 0) {
      return { searchPagedGroups: [], searchTotalGroups: 0 };
    }

    const groupMap = new Map<
      string,
      {
        chatId: string;
        chatTitle: string;
        source: string;
        params?: Record<string, unknown>;
        items: SearchResult[];
      }
    >();
    const order: string[] = [];
    for (const r of searchResults) {
      let g = groupMap.get(r.chatId);
      if (!g) {
        g = {
          chatId: r.chatId,
          chatTitle: r.metaTitle || r.chatTitle,
          source: r.source,
          params: r.params,
          items: [],
        };
        groupMap.set(r.chatId, g);
        order.push(r.chatId);
      }
      g.items.push(r);
    }
    const groups = order
      .map((id) => groupMap.get(id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);

    const total = groups.length;
    const start = (searchPage - 1) * searchPageSize;
    const slice = groups.slice(start, start + searchPageSize);

    return { searchPagedGroups: slice, searchTotalGroups: total };
  }, [searchResults, searchPage, searchPageSize]);

  // Row component for virtualized list
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const chat = displayedChats[index];
    if (!chat) {
      // Return empty div instead of null for react-window compatibility
      return <div style={style} />;
    }

    const isOpenWebUI = (chat.source || "").includes("openwebui");
    const canOpenProvider = isOpenWebUI
      ? !!chat.params?.openwebui_origin || !!openableById[chat.id]
      : true;

    return (
      <div style={style}>
        <ChatTableRow
          chat={chat}
          isSelected={selectedIds.has(chat.id)}
          onToggleSelect={onToggleSelect}
          onAction={onTableAction}
          canOpenProvider={canOpenProvider}
        />
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Controls and Filters */}
      <div className="space-y-3 mb-4 flex-shrink-0">
        {/* Top Controls */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex-1 relative">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              placeholder="Search conversations (title and content)..."
              className="w-full pr-10"
            />
            {searchQuery && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                title="Clear search"
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults(null);
                }}
              >
                <Icon icon={ICONS.clear} />
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onImportClick}>
              Import
            </Button>
            <Button variant="outline" disabled={selectedIds.size === 0} onClick={onExportSelected}>
              Export Selected
            </Button>
            <Button variant="outline" disabled={displayedChats.length === 0} onClick={onExportAll}>
              Export All
            </Button>
            <Button
              variant="destructive"
              disabled={selectedIds.size === 0}
              onClick={onDeleteSelected}
            >
              Delete Selected
            </Button>
            <Button variant="outline" onClick={onRefresh}>
              Refresh
            </Button>
          </div>
        </div>
        {/* Filter/Sort Controls */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex items-center gap-2">
            <label htmlFor="filterProvider" className="text-sm font-medium text-foreground">
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
                <SelectItem value="claudecode">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="pi">PI</SelectItem>
                <SelectItem value="poe">Poe</SelectItem>
                <SelectItem value="chatgpt">ChatGPT</SelectItem>
                <SelectItem value="openwebui">Open WebUI</SelectItem>
                <SelectItem value="qwen">Qwen</SelectItem>
                <SelectItem value="aistudio">AI Studio</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
                <SelectItem value="grok">Grok</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {availableCategories.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="filterCategory" className="text-sm font-medium text-foreground">
                Category:
              </label>
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger id="filterCategory" className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {availableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                  <SelectItem value="Other">Other</SelectItem>
                  <SelectItem value="_unset">Not indexed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="sortBy" className="text-sm font-medium text-foreground">
              Sort by:
            </label>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
              <SelectTrigger id="sortBy" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lastSyncedTimestamp">Sync Time</SelectItem>
                <SelectItem value="providerLastModifiedTimestamp">Modified Time</SelectItem>
                <SelectItem value="title">Title</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                const newDirection: SortDirection = sortDirection === "asc" ? "desc" : "asc";
                setSortDirection(newDirection);
              }}
            >
              <Icon icon={sortDirection === "asc" ? ICONS.sort_asc : ICONS.sort_desc} />
            </Button>
          </div>
        </div>
      </div>

      {/* Content Area */}
      {searchQuery ? (
        isSearching ? (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-8 h-8">
                <div className="absolute inset-0 border-4 border-haevn-teal/20 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-transparent border-t-haevn-teal rounded-full animate-spin"></div>
              </div>
              <p className="text-sm text-haevn-teal-light font-medium">SEARCHING...</p>
            </div>
          </div>
        ) : searchResults ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {!searchResults || searchResults.length === 0 ? (
              <p className="text-sm text-slate-500">No results.</p>
            ) : (
              <>
                <div className="flex-shrink-0 mb-2">
                  <Pagination
                    page={searchPage}
                    pageSize={searchPageSize}
                    total={searchTotalGroups}
                    onPageChange={setSearchPage}
                    onPageSizeChange={(s) => {
                      setSearchPageSize(s);
                      setSearchPage(1);
                    }}
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                  <div className="space-y-3 pr-2">
                    {searchPagedGroups.map((g) => (
                      <SearchResultGroup
                        key={g.chatId}
                        group={g}
                        isExpanded={expandedChats.has(g.chatId)}
                        isLoading={loadingExpandedChats.has(g.chatId)}
                        onExpand={onExpandChat ? () => onExpandChat(g.chatId) : undefined}
                        onOpenViewer={(chatIdOrResult) =>
                          onSearchResultAction("open_viewer", chatIdOrResult)
                        }
                        onOpenProvider={(id) => onOpenChatInProvider(id)}
                        onExport={(id) => onOpenExportModal([id])}
                        canOpenProvider={
                          (g.source || "").includes("openwebui")
                            ? !!g.params?.openwebui_origin || !!openableById[g.chatId]
                            : true
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex-shrink-0 mt-2">
                  <Pagination
                    page={searchPage}
                    pageSize={searchPageSize}
                    total={searchTotalGroups}
                    onPageChange={setSearchPage}
                    onPageSizeChange={(s) => {
                      setSearchPageSize(s);
                      setSearchPage(1);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <p className="text-sm text-slate-500">No results.</p>
          </div>
        )
      ) : (
        <Card className="flex-1 flex flex-col min-h-0">
          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-shrink-0">
                <Table className="[table-layout:fixed]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 flex-shrink-0 h-8 py-1 px-2">
                        <Checkbox
                          checked={isAllSelected}
                          onCheckedChange={(checked) => handleSelectAll(checked === true)}
                        />
                      </TableHead>
                      <TableHead className="hidden sm:table-cell w-32 sm:w-40 flex-shrink-0 h-8 py-1 px-2">
                        Platform
                      </TableHead>
                      <TableHead className="h-8 py-1 px-2 min-w-0 flex-1">Title</TableHead>
                      <TableHead className="w-56 flex-shrink-0 whitespace-nowrap h-8 py-1 px-2">
                        Last Modified
                      </TableHead>
                      <TableHead className="w-56 flex-shrink-0 h-8 py-1 px-2">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                </Table>
              </div>
              <div ref={tableContainerRef} className="flex-1 min-h-0 w-full">
                <List
                  height={tableHeight}
                  itemCount={displayedChats.length}
                  itemSize={48}
                  width="100%"
                >
                  {Row}
                </List>
              </div>
              <div className="flex-shrink-0 p-2 border-t">
                <Pagination
                  page={chatPage}
                  pageSize={chatPageSize}
                  total={totalChats}
                  onPageChange={setChatPage}
                  onPageSizeChange={(s) => {
                    setChatPageSize(s);
                    setChatPage(1);
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
