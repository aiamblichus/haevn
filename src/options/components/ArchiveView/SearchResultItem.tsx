import { parseEntities } from "parse-entities";
import { useMemo } from "react";
import { snippetToHtml } from "../../../utils/snippetHtml";
import type { SearchResult } from "../../types";
import { escapeHtml, formatTime, getPlatformIcon, ICONS, Icon } from "../../utils";
import { ChatPreviewPopover } from "./ChatPreviewPopover";

interface SearchResultItemProps {
  result: SearchResult;
  onAction: (action: string, payload: SearchResult | string) => void;
  compact?: boolean;
}

export const SearchResultItem = ({ result, onAction, compact = false }: SearchResultItemProps) => {
  const previewChat = useMemo(
    () => ({
      id: result.chatId,
      source: result.source,
      title: result.chatTitle,
      metaTitle: result.metaTitle || result.chatTitle,
    }),
    [result.chatId, result.source, result.chatTitle, result.metaTitle],
  );

  // The snippet is untrusted conversation text: escaped, then marked (HVN-56).
  const highlightedSnippet = useMemo(
    () => snippetToHtml(result.messageSnippet),
    [result.messageSnippet],
  );

  // A model or a tag is no one's message: it says what it is, and has no time of its own.
  const speaker =
    result.label === "model"
      ? "Model"
      : result.label === "tag"
        ? "Tag"
        : result.messageRole === "user"
          ? "User"
          : "Assistant";
  // A chat with a rough date shows it as given, in the place of a time its messages do not have.
  const when = result.label
    ? undefined
    : (result.dateLabel ??
      (result.messageTimestamp ? formatTime(result.messageTimestamp) : undefined));

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
              <ChatPreviewPopover chat={previewChat}>
                <div
                  className="font-semibold text-haevn-teal-light truncate cursor-pointer hover:underline"
                  title={parseEntities(result.chatTitle || "")}
                >
                  {parseEntities(result.metaTitle || result.chatTitle || "(Untitled)")}
                </div>
              </ChatPreviewPopover>
              <div className="flex items-center gap-2 text-xs text-haevn-teal-light/60 flex-shrink-0 ml-2">
                <span>{escapeHtml(result.source)}</span>
                <span>•</span>
                <span>{speaker}</span>
                {when && (
                  <>
                    <span>•</span>
                    <span>{when}</span>
                  </>
                )}
              </div>
            </div>
          )}
          {compact && (
            <div className="flex items-center gap-2 text-xs text-haevn-teal-light/60 mb-1">
              <span className="font-medium text-haevn-teal-light">{speaker}</span>
              {when && (
                <>
                  <span>•</span>
                  <span>{when}</span>
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
