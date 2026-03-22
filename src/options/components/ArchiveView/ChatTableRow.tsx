import { parseEntities } from "parse-entities";
import type React from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import type { ChatMeta } from "../../types";
import { escapeHtml, formatTime, getPlatformIcon, ICONS, Icon } from "../../utils";

interface ChatTableRowProps {
  chat: ChatMeta;
  isSelected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onAction: (action: string, id: string) => void;
  canOpenProvider?: boolean;
}

export const ChatTableRow = ({
  chat,
  isSelected,
  onToggleSelect,
  onAction,
  canOpenProvider = true,
}: ChatTableRowProps) => {
  const handleAction = (e: React.MouseEvent, action: string) => {
    e.stopPropagation();
    onAction(action, chat.id);
  };

  return (
    <div className="flex items-center border-b border-border hover:bg-muted/50 transition-colors">
      {/* Checkbox column */}
      <div className="w-12 flex-shrink-0 py-1 px-2 flex items-center">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onToggleSelect(chat.id, !!checked)}
        />
      </div>

      {/* Platform column */}
      <div className="hidden sm:flex w-32 sm:w-40 flex-shrink-0 py-1 px-2 items-center">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center text-base flex-shrink-0">
            {getPlatformIcon(chat.source)}
          </div>
          <span className="text-sm font-medium">{escapeHtml(chat.source)}</span>
        </div>
      </div>

      {/* Title column - flexible to take remaining space */}
      <div className="flex-1 min-w-0 py-1 px-2 flex items-center">
        <div
          className="font-semibold truncate cursor-pointer hover:underline w-full"
          title={parseEntities(chat.title || "")}
          onClick={(e) => handleAction(e, "open_viewer")}
        >
          {parseEntities(chat.title || "(Untitled)")}
        </div>
      </div>

      {/* Last Modified column */}
      <div className="text-sm text-muted-foreground w-56 flex-shrink-0 whitespace-nowrap py-1 px-2 flex items-center">
        {formatTime(chat.providerLastModifiedTimestamp ?? chat.lastSyncedTimestamp)}
      </div>

      {/* Actions column */}
      <div className="w-56 flex-shrink-0 py-1 px-2 flex items-center">
        <div className="flex items-center gap-1 text-muted-foreground">
          <Button
            variant="ghost"
            size="icon"
            title="Sync Now"
            onClick={(e) => handleAction(e, "sync")}
          >
            <Icon icon={ICONS.sync} />
          </Button>
          {canOpenProvider && (
            <Button
              variant="ghost"
              size="icon"
              title="Open at Provider"
              onClick={(e) => handleAction(e, "open_provider")}
            >
              <Icon icon={ICONS.open_provider} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="Open in Viewer"
            onClick={(e) => handleAction(e, "open_viewer")}
          >
            <Icon icon={ICONS.open_viewer} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Export"
            onClick={(e) => handleAction(e, "export")}
          >
            <Icon icon={ICONS.export} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            className="hover:text-destructive hover:bg-destructive/10"
            onClick={(e) => handleAction(e, "delete")}
          >
            <Icon icon={ICONS.delete} />
          </Button>
        </div>
      </div>
    </div>
  );
};
