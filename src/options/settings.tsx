import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
    </div>
  );
};
