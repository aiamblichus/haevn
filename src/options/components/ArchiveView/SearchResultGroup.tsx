import { parseEntities } from "parse-entities";
import type { SearchResult } from "../../types";
import { escapeHtml, getPlatformIcon, ICONS, Icon } from "../../utils";
import { SearchResultItem } from "./SearchResultItem";

interface SearchResultGroupProps {
  group: {
    chatId: string;
    chatTitle: string;
    source: string;
    items: SearchResult[];
  };
  isExpanded?: boolean;
  isLoading?: boolean;
  onExpand?: () => void | Promise<void>;
  onOpenViewer: (chatIdOrResult: SearchResult | string) => void;
  onOpenProvider: (chatId: string) => void;
  onExport: (chatId: string) => void;
  canOpenProvider?: boolean;
}

export const SearchResultGroup = ({
  group,
  isExpanded = false,
  isLoading = false,
  onExpand,
  onOpenViewer,
  onOpenProvider,
  onExport,
  canOpenProvider = true,
}: SearchResultGroupProps) => {
  const decodedTitle = parseEntities(group.chatTitle || "");
  const truncatedTitle =
    decodedTitle.length > 80 ? `${decodedTitle.substring(0, 80)}…` : decodedTitle;

  // Show first 3 items by default, all if expanded
  const SHOW_MORE_THRESHOLD = 3;
  const hasMore = group.items.length > SHOW_MORE_THRESHOLD;
  const displayItems = isExpanded ? group.items : group.items.slice(0, SHOW_MORE_THRESHOLD);

  return (
    <div className="bg-haevn-navy-dark/80 rounded-lg border border-haevn-purple/20 shadow-lg w-full max-w-full overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-haevn-purple/20 min-w-0 w-full">
        <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xl flex-shrink-0">
            {getPlatformIcon(group.source)}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div
              className="font-semibold text-haevn-teal-light cursor-pointer hover:text-haevn-teal-bright hover:underline transition-colors"
              title={truncatedTitle}
              onClick={() => onOpenViewer(group.chatId)}
            >
              {truncatedTitle || "(Untitled)"}
            </div>
            <div className="text-xs text-haevn-purple-light/70 truncate w-full">
              {escapeHtml(group.source)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-haevn-teal-light flex-shrink-0">
          {canOpenProvider && (
            <button
              className="p-1 hover:bg-haevn-purple/20 rounded-md transition-colors"
              title="Open at Provider"
              onClick={() => onOpenProvider(group.chatId)}
            >
              <Icon icon={ICONS.open_provider} />
            </button>
          )}
          <button
            className="p-1 hover:bg-haevn-purple/20 rounded-md transition-colors"
            title="Open in Viewer"
            onClick={() => onOpenViewer(group.chatId)}
          >
            <Icon icon={ICONS.open_viewer} />
          </button>
          <button
            className="p-1 hover:bg-haevn-purple/20 rounded-md transition-colors"
            title="Export"
            onClick={() => onExport(group.chatId)}
          >
            <Icon icon={ICONS.export} />
          </button>
        </div>
      </div>
      <div className="p-3 space-y-2">
        {displayItems.map((item) => (
          <SearchResultItem
            key={item.messageId}
            result={item}
            compact={true}
            onAction={(action, payload) => {
              if (action === "open_viewer") {
                // Pass the full SearchResult object to enable message navigation
                onOpenViewer(payload as SearchResult);
              } else if (action === "export") {
                const id = typeof payload === "string" ? payload : (payload as SearchResult).chatId;
                onExport(id);
              }
            }}
          />
        ))}
        {hasMore && onExpand && (
          <button
            className="w-full text-center text-xs text-haevn-purple-light/60 hover:text-haevn-teal-light transition-colors py-2 -mb-2"
            onClick={onExpand}
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 border-2 border-haevn-teal-light/30 border-t-haevn-teal-light rounded-full animate-spin"></div>
                Loading...
              </span>
            ) : isExpanded ? (
              <span className="flex items-center justify-center gap-1">
                <Icon icon={ICONS.chevron_up} className="w-4 h-4" />
                Show less
              </span>
            ) : (
              <span className="flex items-center justify-center gap-1">
                <Icon icon={ICONS.chevron_down} className="w-4 h-4" />
                Show more
                {group.items.length > SHOW_MORE_THRESHOLD + 1 && (
                  <span className="ml-1">({group.items.length - SHOW_MORE_THRESHOLD} more)</span>
                )}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
