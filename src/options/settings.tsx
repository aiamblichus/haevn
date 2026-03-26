import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import type { CategoryConfig, MetadataAIConfig } from "../services/settingsService";
import { DEFAULT_CLI_PORT } from "../services/settingsService";
import { log } from "../utils/logger";

export const SettingsView = () => {
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadBaseUrl = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "getOpenWebUIBaseUrl",
      });
      if (response.success && response.baseUrl) {
        setBaseUrl(response.baseUrl);
      }
    } catch (err: unknown) {
      log.error("Failed to load Open WebUI base URL:", err);
      setError("Failed to load base URL");
    }
  }, []);

  useEffect(() => {
    loadBaseUrl();
  }, [loadBaseUrl]);

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaved(false);

    if (!baseUrl.trim()) {
      // Clear the setting if empty
      try {
        const response = await chrome.runtime.sendMessage({
          action: "clearOpenWebUIBaseUrl",
        });
        if (response.success) {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } else {
          setError(response.error || "Failed to clear base URL");
        }
      } catch (err: unknown) {
        log.error("Failed to clear base URL:", err);
        setError("Failed to clear base URL");
      }
      return;
    }

    if (!validateUrl(baseUrl.trim())) {
      setError("Invalid URL format. Must be http:// or https://");
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: "setOpenWebUIBaseUrl",
        baseUrl: baseUrl.trim(),
      });
      if (response.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(response.error || "Failed to save base URL");
      }
    } catch (err: unknown) {
      log.error("Failed to save base URL:", err);
      setError("Failed to save base URL");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure Open WebUI base URL for imports and syncs
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open WebUI Base URL</CardTitle>
          <CardDescription>
            Set the base URL for your Open WebUI instance. All imported chats will be assigned to
            this instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="baseUrl">Base URL</Label>
            <Input
              id="baseUrl"
              type="url"
              placeholder="https://your-openwebui.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to clear the setting. All imported Open WebUI chats will use this base
              URL.
            </p>
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
          {saved && (
            <div className="text-sm text-green-600 bg-green-50 p-2 rounded">
              Settings saved successfully
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={handleSave}>Save</Button>
          </div>
        </CardContent>
      </Card>

      <CliSettingsCard />
      <AIMetadataSettingsCard />
    </div>
  );
};

// ─── CLI Integration Card ─────────────────────────────────────────────────────

const CliSettingsCard = () => {
  const [port, setPort] = useState<string>(String(DEFAULT_CLI_PORT));
  const [apiKey, setApiKey] = useState<string>("");
  const [portError, setPortError] = useState<string | null>(null);
  const [portSaved, setPortSaved] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyRegenConfirm, setKeyRegenConfirm] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load current settings on mount.
  useEffect(() => {
    chrome.runtime
      .sendMessage({ action: "getCliSettings" })
      .then((response) => {
        if (response.success) {
          setPort(String(response.port));
          setApiKey(response.apiKey ?? "");
        }
      })
      .catch((err) => log.error("Failed to load CLI settings:", err))
      .finally(() => setLoading(false));
  }, []);

  const handleSavePort = async () => {
    setPortError(null);
    setPortSaved(false);

    const parsed = Number.parseInt(port, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setPortError("Port must be an integer between 1024 and 65535");
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ action: "setCliPort", port: parsed });
      if (response.success) {
        setPortSaved(true);
        setTimeout(() => setPortSaved(false), 2000);
      } else {
        setPortError(response.error ?? "Failed to save port");
      }
    } catch (err: unknown) {
      log.error("Failed to save CLI port:", err);
      setPortError("Failed to save port");
    }
  };

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — do nothing
    }
  };

  const handleRegenKey = async () => {
    if (!keyRegenConfirm) {
      // First click: show confirmation state
      setKeyRegenConfirm(true);
      setTimeout(() => setKeyRegenConfirm(false), 4000);
      return;
    }

    setKeyRegenConfirm(false);
    try {
      const response = await chrome.runtime.sendMessage({ action: "regenerateCliApiKey" });
      if (response.success) {
        setApiKey(response.apiKey ?? "");
      }
    } catch (err: unknown) {
      log.error("Failed to regenerate CLI API key:", err);
    }
  };

  if (loading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>CLI Integration</CardTitle>
        <CardDescription>
          Configure the local daemon that bridges the{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">haevn</code> CLI to this extension.
          Start the daemon with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">haevn daemon</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Port */}
        <div className="space-y-2">
          <Label htmlFor="cliPort">Daemon port</Label>
          <div className="flex gap-2">
            <Input
              id="cliPort"
              type="number"
              min={1024}
              max={65535}
              className="w-32"
              value={port}
              onChange={(e) => setPort((e.target as HTMLInputElement).value)}
            />
            <Button variant="outline" onClick={handleSavePort}>
              Save
            </Button>
          </div>
          {portError && <p className="text-xs text-red-600">{portError}</p>}
          {portSaved && (
            <p className="text-xs text-green-600">Port saved — restart the daemon to apply</p>
          )}
          <p className="text-xs text-muted-foreground">
            The daemon listens on <code className="bg-muted px-1 rounded">localhost:{port}</code>.
            Change only if the default conflicts with another service.
          </p>
        </div>

        {/* API key */}
        <div className="space-y-2">
          <Label htmlFor="cliApiKey">API key</Label>
          <div className="flex gap-2">
            <Input
              id="cliApiKey"
              type="text"
              readOnly
              value={apiKey}
              className="font-mono text-xs"
            />
            <Button variant="outline" onClick={handleCopyKey}>
              {keyCopied ? "Copied!" : "Copy"}
            </Button>
            <Button variant={keyRegenConfirm ? "destructive" : "outline"} onClick={handleRegenKey}>
              {keyRegenConfirm ? "Confirm regen" : "Regenerate"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pass this key to the daemon:{" "}
            <code className="bg-muted px-1 rounded">haevn daemon --api-key &lt;key&gt;</code>.
            Regenerating invalidates the current daemon connection.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

function formatQueueStatus(s: {
  missing: number;
  pending: number;
  processing: number;
  failed: number;
}): string {
  const parts: string[] = [];
  if (s.missing > 0) parts.push(`${s.missing} unindexed`);
  if (s.pending > 0) parts.push(`${s.pending} pending`);
  if (s.processing > 0) parts.push(`${s.processing} processing`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : "All chats indexed";
}

// ─── AI Metadata Settings Card ────────────────────────────────────────────────

const DEFAULT_CONFIG: MetadataAIConfig = {
  enabled: false,
  warningAcknowledged: false,
  url: "",
  apiKey: "",
  model: "",
  autoGenerate: false,
  indexMissing: false,
  categories: [],
};

interface QueueStatus {
  pending: number;
  processing: number;
  failed: number;
  missing: number;
}

const AIMetadataSettingsCard = () => {
  const [config, setConfig] = useState<MetadataAIConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWarning, setShowWarning] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDesc, setNewCategoryDesc] = useState("");
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const pendingEnableRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ action: "getMetadataAIConfig" })
      .then((res) => {
        if (res.success) setConfig(res.data as MetadataAIConfig);
      })
      .catch((err) => log.error("[Settings] Failed to load metadata AI config:", err))
      .finally(() => setLoading(false));
  }, []);

  const save = async (patch: Partial<MetadataAIConfig>) => {
    setError(null);
    setSaved(false);
    try {
      const res = await chrome.runtime.sendMessage({
        action: "setMetadataAIConfig",
        config: patch,
      });
      if (!res.success) throw new Error(res.error ?? "Save failed");
      setConfig((prev) => ({ ...prev, ...patch }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleEnableToggle = (checked: boolean) => {
    if (checked && !config.warningAcknowledged) {
      pendingEnableRef.current = true;
      setShowWarning(true);
    } else {
      save({ enabled: checked });
    }
  };

  const handleWarningConfirm = () => {
    setShowWarning(false);
    save({ enabled: true, warningAcknowledged: true });
  };

  const handleWarningCancel = () => {
    setShowWarning(false);
    pendingEnableRef.current = false;
  };

  const loadQueueStatus = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: "getMetadataQueueStatus" });
      if (res.success) setQueueStatus(res.data as QueueStatus);
    } catch {
      // ignore
    }
  }, []);

  // Load queue status when AI is enabled; poll while items are in flight
  useEffect(() => {
    if (!config.enabled) return;
    loadQueueStatus();
    const interval = setInterval(() => {
      loadQueueStatus();
    }, 4000);
    return () => clearInterval(interval);
  }, [config.enabled, loadQueueStatus]);

  const handleRebuildAll = async () => {
    setRebuilding(true);
    setShowRebuildConfirm(false);
    try {
      await chrome.runtime.sendMessage({ action: "rebuildAllMetadata" });
      await loadQueueStatus();
    } catch {
      // ignore
    } finally {
      setRebuilding(false);
    }
  };

  const handleAddCategory = () => {
    const name = newCategoryName.trim();
    if (!name || config.categories.some((c) => c.name === name)) return;
    const entry: CategoryConfig = { name, description: newCategoryDesc.trim() };
    save({ categories: [...config.categories, entry] });
    setNewCategoryName("");
    setNewCategoryDesc("");
  };

  const handleRemoveCategory = (name: string) => {
    save({ categories: config.categories.filter((c) => c.name !== name) });
  };

  if (loading) return null;

  return (
    <>
      <Dialog
        open={showRebuildConfirm}
        onOpenChange={(open) => !open && setShowRebuildConfirm(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rebuild All Metadata?</DialogTitle>
            <DialogDescription>
              This will permanently delete all existing metadata (titles, descriptions, categories,
              keywords) for every chat and re-queue them for AI generation.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Any metadata you have set or edited manually will be lost. The AI will regenerate
            everything from scratch. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRebuildConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRebuildAll}>
              Yes, rebuild all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showWarning} onOpenChange={(open) => !open && handleWarningCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Privacy Warning</DialogTitle>
            <DialogDescription>
              When AI metadata generation is enabled, the full content of your chats will be sent to
              the configured API URL for analysis. This data leaves your device.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p>
              We strongly recommend using a <strong>local LLM</strong> such as{" "}
              <strong>Ollama</strong> or <strong>LM Studio</strong> to keep your conversations
              private. External APIs (OpenAI, etc.) will receive and may log your chat content.
            </p>
            <p className="text-muted-foreground">
              Only enable this if you understand and accept that your chat content will be sent to
              the configured URL.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleWarningCancel}>
              Cancel
            </Button>
            <Button onClick={handleWarningConfirm}>I understand, enable AI</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>AI Metadata Generation</CardTitle>
          <CardDescription>
            Automatically generate titles, descriptions, synopses, categories, and keywords for your
            chats using an OpenAI-compatible LLM. Recommended: use a local model via{" "}
            <strong>Ollama</strong> or <strong>LM Studio</strong> for privacy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable toggle */}
          <div className="flex items-center gap-3">
            <Checkbox
              id="metaEnabled"
              checked={config.enabled}
              onCheckedChange={(v) => handleEnableToggle(!!v)}
            />
            <Label htmlFor="metaEnabled" className="cursor-pointer">
              Enable AI metadata generation
            </Label>
          </div>

          {config.enabled && (
            <>
              <div className="space-y-2">
                <Label htmlFor="metaUrl">OpenAI-compatible API URL</Label>
                <Input
                  id="metaUrl"
                  type="url"
                  placeholder="http://localhost:11434/v1"
                  value={config.url}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, url: (e.target as HTMLInputElement).value }))
                  }
                  onBlur={() => save({ url: config.url })}
                />
                <p className="text-xs text-muted-foreground">
                  For Ollama:{" "}
                  <code className="bg-muted px-1 rounded">http://localhost:11434/v1</code>
                  {" | "}For LM Studio:{" "}
                  <code className="bg-muted px-1 rounded">http://localhost:1234/v1</code>
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="metaApiKey">API Key</Label>
                <Input
                  id="metaApiKey"
                  type="password"
                  placeholder="sk-... (leave empty for local models)"
                  value={config.apiKey}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, apiKey: (e.target as HTMLInputElement).value }))
                  }
                  onBlur={() => save({ apiKey: config.apiKey })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="metaModel">Model</Label>
                <Input
                  id="metaModel"
                  type="text"
                  placeholder="e.g. llama3.2, gpt-4o-mini, mistral"
                  value={config.model}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, model: (e.target as HTMLInputElement).value }))
                  }
                  onBlur={() => save({ model: config.model })}
                />
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  id="metaAutoGenerate"
                  checked={config.autoGenerate}
                  onCheckedChange={(v) => save({ autoGenerate: !!v })}
                />
                <Label htmlFor="metaAutoGenerate" className="cursor-pointer">
                  Auto-generate metadata for newly synced / imported chats
                </Label>
              </div>

              <div className="flex items-center gap-3">
                <Checkbox
                  id="metaIndexMissing"
                  checked={config.indexMissing}
                  onCheckedChange={(v) => {
                    save({ indexMissing: !!v });
                    if (v) {
                      chrome.runtime
                        .sendMessage({ action: "queueMissingMetadata" })
                        .then(() => loadQueueStatus())
                        .catch(() => {});
                    }
                  }}
                />
                <Label htmlFor="metaIndexMissing" className="cursor-pointer">
                  Index existing chats without metadata
                </Label>
              </div>

              {/* Queue status + rebuild */}
              <div className="rounded-md border px-3 py-2.5 bg-muted/30">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-xs text-muted-foreground">
                    {queueStatus === null ? "Loading…" : formatQueueStatus(queueStatus)}
                  </p>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setShowRebuildConfirm(true)}
                    disabled={rebuilding}
                  >
                    {rebuilding ? "Rebuilding…" : "Rebuild all"}
                  </Button>
                </div>
              </div>
            </>
          )}

          {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}
          {saved && <div className="text-sm text-green-600 bg-green-50 p-2 rounded">Saved</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata Categories</CardTitle>
          <CardDescription>
            Define the categories the AI (and you) can assign to chats. The AI will only pick from
            this list, plus a built-in <strong>Other</strong> fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No categories configured yet.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border">
              {config.categories.map((cat) => (
                <div key={cat.name} className="flex items-start gap-3 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{cat.name}</p>
                    {cat.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                        {cat.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0 text-sm leading-none"
                    onClick={() => handleRemoveCategory(cat.name)}
                    aria-label={`Remove category ${cat.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Name (e.g. Coding)"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
                className="w-44 shrink-0"
              />
              <Input
                type="text"
                placeholder="Description (optional)"
                value={newCategoryDesc}
                onChange={(e) => setNewCategoryDesc((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
              />
              <Button variant="outline" onClick={handleAddCategory} className="shrink-0">
                Add
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
};
