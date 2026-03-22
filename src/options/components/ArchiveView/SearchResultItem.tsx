import { parseEntities } from "parse-entities";
import { useMemo } from "react";
import type { SearchResult } from "../../types";
import { escapeHtml, formatTime, getPlatformIcon, ICONS, Icon } from "../../utils";

interface SearchResultItemProps {
  result: SearchResult;
  onAction: (action: string, payload: SearchResult | string) => void;
  compact?: boolean;
}

export const SearchResultItem = ({ result, onAction, compact = false }: SearchResultItemProps) => {
  const highlightedSnippet = useMemo(
    () =>
      (result.messageSnippet || "")
        .replace(
          /\{\{HIGHLIGHT\}\}/g,
          '<mark style="background-color: rgba(212, 175, 55, 0.3); padding: 0 2px; border-radius: 2px; box-shadow: 0 0 8px rgba(212, 175, 55, 0.4);">',
        )
        .replace(/\{\{\/HIGHLIGHT\}\}/g, "</mark>"),
    [result.messageSnippet],
  );

  return (
    <div
      className="bg-haevn-navy-dark/60 rounded-lg border border-haevn-teal/20 p-3 hover:border-haevn-teal/40 hover:shadow-haevn-glow cursor-pointer transition-all"
      onClick={() => onAction("open_viewer", result)}
    >
      <div className="flex items-start gap-3">
        {!compact && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xl flex-shrink-0">
            {getPlatformIcon(result.source)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          {!compact && (
            <div className="flex items-center justify-between">
              <div
                className="font-semibold text-haevn-teal-light truncate"
                title={parseEntities(result.chatTitle || "")}
              >
                {parseEntities(result.chatTitle || "(Untitled)")}
              </div>
              <div className="flex items-center gap-2 text-xs text-haevn-teal-light/60 flex-shrink-0 ml-2">
                <span>{escapeHtml(result.source)}</span>
                <span>•</span>
                <span>{result.messageRole === "user" ? "User" : "Assistant"}</span>
                {result.messageTimestamp && (
                  <>
                    <span>•</span>
                    <span>{formatTime(result.messageTimestamp)}</span>
                  </>
                )}
              </div>
            </div>
          )}
          {compact && (
            <div className="flex items-center gap-2 text-xs text-haevn-teal-light/60 mb-1">
              <span className="font-medium text-haevn-teal-light">
                {result.messageRole === "user" ? "User" : "Assistant"}
              </span>
              {result.messageTimestamp && (
                <>
                  <span>•</span>
                  <span>{formatTime(result.messageTimestamp)}</span>
                </>
              )}
            </div>
          )}
          <div
            className="text-sm text-haevn-teal-light/80 leading-snug break-words overflow-wrap-anywhere"
            dangerouslySetInnerHTML={{ __html: highlightedSnippet }}
          />
        </div>
        <div className="flex flex-col items-center gap-2">
          <button
            className="p-1 hover:bg-haevn-teal/20 rounded-md text-haevn-teal-light"
            title="Open in Viewer"
            onClick={(e) => {
              e.stopPropagation();
              onAction("open_viewer", result);
            }}
          >
            <Icon icon={ICONS.open_viewer} />
          </button>
          <button
            className="p-1 hover:bg-haevn-teal/20 rounded-md text-haevn-teal-light"
            title="Export"
            onClick={(e) => {
              e.stopPropagation();
              onAction("export", result.chatId);
            }}
          >
            <Icon icon={ICONS.export} />
          </button>
        </div>
      </div>
    </div>
  );
};
