import { parseEntities } from "parse-entities";
import React from "react";
import type { ChatMetadataRecord } from "../../../services/db";
import type { ChatMeta } from "../../types";
import { formatTime, getPlatformIcon } from "../../utils";

export interface PreviewData {
  metadata: ChatMetadataRecord | null;
  messageCount: number;
  createdAt: number;
  models: string[];
}

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "muted";
}) {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  const cls =
    variant === "muted"
      ? `${base} bg-muted text-muted-foreground`
      : `${base} bg-primary/10 text-primary`;
  return <span className={cls}>{children}</span>;
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </span>
      <span className="text-xs text-foreground">{value}</span>
    </div>
  );
}

interface ChatPreviewCardProps {
  chat: ChatMeta;
  data: PreviewData | null;
  isLoading: boolean;
}

export function ChatPreviewCard({ chat, data, isLoading }: ChatPreviewCardProps) {
  const displayTitle = parseEntities(
    data?.metadata?.title || chat.metaTitle || chat.title || "(Untitled)",
  );
  const description = data?.metadata?.description;
  const synopsis = data?.metadata?.synopsis;
  const categories = data?.metadata?.categories ?? [];
  const keywords = data?.metadata?.keywords ?? [];
  const models = data?.models ?? [];
  const metaSource = data?.metadata?.source;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-muted overflow-hidden">
          {getPlatformIcon(chat.source)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-snug line-clamp-2">{displayTitle}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge variant="muted">{chat.source}</Badge>
            {models.length > 0 && <Badge variant="muted">{models[0]}</Badge>}
            {metaSource === "ai" && <Badge variant="default">AI indexed</Badge>}
            {metaSource === "manual" && <Badge variant="muted">Manual</Badge>}
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-2">
          <div className="h-3 bg-muted rounded animate-pulse w-3/4" />
          <div className="h-3 bg-muted rounded animate-pulse w-1/2" />
        </div>
      )}

      {!isLoading && description && (
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      )}

      {!isLoading && synopsis && !description && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{synopsis}</p>
      )}

      {!isLoading && categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {categories.map((cat) => (
            <Badge key={cat} variant="default">
              {cat}
            </Badge>
          ))}
        </div>
      )}

      {!isLoading && keywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {keywords.slice(0, 8).map((kw) => (
            <Badge key={kw} variant="muted">
              {kw}
            </Badge>
          ))}
          {keywords.length > 8 && <Badge variant="muted">+{keywords.length - 8} more</Badge>}
        </div>
      )}

      <div className="border-t border-border" />

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {data !== null && <StatItem label="Messages" value={String(data.messageCount)} />}
        {data?.createdAt ? <StatItem label="Created" value={formatTime(data.createdAt)} /> : null}
        {chat.providerLastModifiedTimestamp ? (
          <StatItem label="Updated" value={formatTime(chat.providerLastModifiedTimestamp)} />
        ) : null}
        {chat.lastSyncedTimestamp ? (
          <StatItem label="Synced" value={formatTime(chat.lastSyncedTimestamp)} />
        ) : null}
      </div>

      {!isLoading && data?.metadata === null && (
        <p className="text-[10px] text-muted-foreground italic">
          No AI metadata yet — generate it from the metadata editor.
        </p>
      )}
    </div>
  );
}
