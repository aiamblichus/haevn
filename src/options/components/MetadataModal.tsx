import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import type {
  ChatMetadataRecord,
  MetadataAIConfig,
  MetadataQueueRecord,
} from "../../types/messaging";
import { log } from "../../utils/logger";

interface MetadataModalProps {
  chatId: string;
  chatTitle: string;
  open: boolean;
  onClose: () => void;
  onMetadataSaved: (chatId: string, metaTitle: string) => void;
}

type Mode = "view" | "edit";

export const MetadataModal = ({
  chatId,
  chatTitle,
  open,
  onClose,
  onMetadataSaved,
}: MetadataModalProps) => {
  const [mode, setMode] = useState<Mode>("view");
  const [metadata, setMetadata] = useState<ChatMetadataRecord | null>(null);
  const [queueItem, setQueueItem] = useState<MetadataQueueRecord | null>(null);
  const [aiConfig, setAiConfig] = useState<MetadataAIConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingFailure, setResettingFailure] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSynopsis, setEditSynopsis] = useState("");
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [editKeywordsStr, setEditKeywordsStr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, configRes, queueRes] = await Promise.all([
        chrome.runtime.sendMessage({ action: "getChatMetadata", chatId }),
        chrome.runtime.sendMessage({ action: "getMetadataAIConfig" }),
        chrome.runtime.sendMessage({ action: "getMetadataQueueItem", chatId }),
      ]);
      const record = metaRes.success ? (metaRes.data as ChatMetadataRecord | null) : null;
      const config = configRes.success ? (configRes.data as MetadataAIConfig) : null;
      const queue = queueRes.success
        ? ((queueRes.data as MetadataQueueRecord | null) ?? null)
        : null;
      setMetadata(record);
      setQueueItem(queue);
      setAiConfig(config);
    } catch (err) {
      log.error("[MetadataModal] Failed to load metadata:", err);
      setError("Failed to load metadata");
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    if (open) {
      setMode("view");
      load();
    }
  }, [open, load]);

  const enterEdit = () => {
    setEditTitle(metadata?.title ?? "");
    setEditDescription(metadata?.description ?? "");
    setEditSynopsis(metadata?.synopsis ?? "");
    setEditCategories(metadata?.categories ?? []);
    setEditKeywordsStr((metadata?.keywords ?? []).join(", "));
    setMode("edit");
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const keywords = editKeywordsStr
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const res = await chrome.runtime.sendMessage({
        action: "setChatMetadata",
        chatId,
        metadata: {
          title: editTitle,
          description: editDescription,
          synopsis: editSynopsis,
          categories: editCategories,
          keywords,
        },
      });
      if (!res.success) throw new Error(res.error ?? "Save failed");
      onMetadataSaved(chatId, editTitle);
      await load();
      setMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({ action: "generateChatMetadata", chatId });
      if (!res.success) throw new Error(res.error ?? "Generation failed");
      const record = res.data as ChatMetadataRecord;
      setMetadata(record);
      onMetadataSaved(chatId, record.title ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleResetFailure = async () => {
    setResettingFailure(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({ action: "resetMetadataQueueItem", chatId });
      if (!res.success) throw new Error(res.error ?? "Failed to reset metadata error");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset metadata error");
    } finally {
      setResettingFailure(false);
    }
  };

  const toggleCategory = (cat: string, checked: boolean) => {
    setEditCategories((prev) => (checked ? [...prev, cat] : prev.filter((c) => c !== cat)));
  };

  const allCategories = aiConfig?.categories ?? [];
  const allCategoryNames = allCategories.map((category) => category.name);
  const staleCategories = (metadata?.categories ?? []).filter((c) => !allCategoryNames.includes(c));
  const displayDate = metadata?.generatedAt
    ? new Date(metadata.generatedAt).toLocaleDateString()
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="min-w-0">
            Chat Metadata
            <span
              className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-sm font-normal text-muted-foreground"
              title={chatTitle}
            >
              {chatTitle}
            </span>
          </DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

        {!loading && mode === "view" && (
          <div className="space-y-4 text-sm">
            {queueItem?.status === "failed" && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                <p className="text-sm font-medium">
                  This chat is marked unprocessable for AI metadata.
                </p>
                <p className="mt-1 text-xs">
                  Last error: {queueItem.error || "Unknown error"}
                  {typeof queueItem.retries === "number" ? ` (attempts: ${queueItem.retries})` : ""}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={handleResetFailure}
                  disabled={resettingFailure}
                >
                  {resettingFailure ? "Resetting…" : "Reset and retry"}
                </Button>
              </div>
            )}

            <Field label="Title" value={metadata?.title} placeholder="Not set" />
            <Field label="Description" value={metadata?.description} placeholder="Not set" />
            <Field label="Synopsis" value={metadata?.synopsis} placeholder="Not set" multiline />

            {(metadata?.categories?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Categories
                </p>
                <div className="flex flex-wrap gap-1">
                  {(metadata?.categories ?? []).map((cat) => {
                    const isStale = !allCategoryNames.includes(cat);
                    return (
                      <Badge
                        key={cat}
                        variant="secondary"
                        className={isStale ? "line-through opacity-50" : ""}
                        title={isStale ? "This category was removed from Settings" : undefined}
                      >
                        {cat}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            {(metadata?.keywords?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                  Keywords
                </p>
                <div className="flex flex-wrap gap-1">
                  {(metadata?.keywords ?? []).map((kw) => (
                    <Badge key={kw} variant="outline">
                      {kw}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {metadata?.source && metadata.source !== "unset" && (
              <p className="text-xs text-muted-foreground">
                Source: {metadata.source === "ai" ? "AI-generated" : "Manual"}
                {displayDate && ` · ${displayDate}`}
              </p>
            )}
          </div>
        )}

        {!loading && mode === "edit" && (
          <div className="space-y-4 text-sm">
            <div className="space-y-1">
              <Label htmlFor="meta-title">Title</Label>
              <Input
                id="meta-title"
                value={editTitle}
                onChange={(e) => setEditTitle((e.target as HTMLInputElement).value)}
                placeholder="Enter a title…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="meta-desc">Description</Label>
              <textarea
                id="meta-desc"
                className="w-full border rounded p-2 text-sm resize-none bg-background text-foreground"
                rows={2}
                value={editDescription}
                onChange={(e) => setEditDescription((e.target as HTMLTextAreaElement).value)}
                placeholder="1–2 sentence description…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="meta-synopsis">Synopsis</Label>
              <textarea
                id="meta-synopsis"
                className="w-full border rounded p-2 text-sm resize-none bg-background text-foreground"
                rows={4}
                value={editSynopsis}
                onChange={(e) => setEditSynopsis((e.target as HTMLTextAreaElement).value)}
                placeholder="Longer summary…"
              />
            </div>

            {(allCategories.length > 0 || staleCategories.length > 0) && (
              <div className="space-y-2">
                <Label>Categories</Label>
                <div className="flex flex-wrap gap-3">
                  {allCategories.map((cat) => (
                    <div key={cat.name} className="flex items-center gap-1.5">
                      <Checkbox
                        id={`cat-${cat.name}`}
                        checked={editCategories.includes(cat.name)}
                        onCheckedChange={(v) => toggleCategory(cat.name, !!v)}
                      />
                      <label htmlFor={`cat-${cat.name}`} className="cursor-pointer text-sm">
                        {cat.name}
                      </label>
                    </div>
                  ))}
                  {staleCategories.map((cat) => (
                    <div key={cat} className="flex items-center gap-1.5 opacity-50">
                      <Checkbox
                        id={`cat-stale-${cat}`}
                        checked={editCategories.includes(cat)}
                        onCheckedChange={(v) => toggleCategory(cat, !!v)}
                      />
                      <label
                        htmlFor={`cat-stale-${cat}`}
                        className="cursor-pointer text-sm line-through"
                        title="Removed from Settings"
                      >
                        {cat}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="meta-keywords">Keywords</Label>
              <Input
                id="meta-keywords"
                value={editKeywordsStr}
                onChange={(e) => setEditKeywordsStr((e.target as HTMLInputElement).value)}
                placeholder="comma, separated, keywords"
              />
              <p className="text-xs text-muted-foreground">Separate keywords with commas</p>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {mode === "view" && (
            <>
              {aiConfig?.enabled && (
                <Button variant="outline" onClick={handleGenerate} disabled={generating}>
                  {generating ? "Generating…" : "Generate with AI"}
                </Button>
              )}
              <Button variant="outline" onClick={enterEdit}>
                Edit
              </Button>
              <Button onClick={onClose}>Close</Button>
            </>
          )}
          {mode === "edit" && (
            <>
              <Button variant="outline" onClick={() => setMode("view")} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Small helper ─────────────────────────────────────────────────────────────

const Field = ({
  label,
  value,
  placeholder,
  multiline,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
}) => (
  <div className="space-y-0.5">
    <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
    {value ? (
      multiline ? (
        <p className="whitespace-pre-wrap break-words text-foreground">{value}</p>
      ) : (
        <p className="break-words text-foreground">{value}</p>
      )
    ) : (
      <p className="text-muted-foreground italic">{placeholder}</p>
    )}
  </div>
);
