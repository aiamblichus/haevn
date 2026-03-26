import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
