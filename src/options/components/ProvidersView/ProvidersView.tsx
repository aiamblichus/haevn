import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BulkSyncState } from "../../../background/bulkSync/types";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { getAllProviders } from "../../../providers/provider";
import type { BackgroundEvent } from "../../../types/messaging";
import { fireAndForget } from "../../../utils/error_utils";
import { log } from "../../../utils/logger";
import type { ProviderStats, ProviderSyncState } from "../../types";
import { ProviderCard } from "./ProviderCard";

interface ProvidersViewProps {
  isActive?: boolean;
  onRefreshChats: () => void;
  onOpenImportModal: () => void;
  setImportProviderFilter: (provider: string) => void;
}

export const ProvidersView = ({
  isActive,
  onRefreshChats,
  onOpenImportModal,
  setImportProviderFilter,
}: ProvidersViewProps) => {
  const providers = useMemo(() => getAllProviders(), []);
  const [openwebuiBaseUrl, setOpenwebuiBaseUrl] = useState<string | null>(null);
  const [providerStats, setProviderStats] = useState<Record<string, ProviderStats>>({});
  // NEW: State to hold the global bulk sync status
  const [globalSyncState, setGlobalSyncState] = useState<BulkSyncState | null>(null);
  // Confirmation dialog for providers that require an active (visible) tab
  const [activeTabConfirmOpen, setActiveTabConfirmOpen] = useState(false);
  const [activeTabConfirmProvider, setActiveTabConfirmProvider] = useState<{
    name: string;
    displayName: string;
    baseUrl?: string;
  } | null>(null);

  // Resume dialog state (Spec 03.02)
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeDialogData, setResumeDialogData] = useState<{
    provider: string;
    baseUrl?: string;
    incompleteState: BulkSyncState;
    options?: { overwriteExisting?: boolean };
  } | null>(null);

  const loadOpenWebUIBaseUrl = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "getOpenWebUIBaseUrl",
      });
      if (response.success) {
        setOpenwebuiBaseUrl(response.baseUrl || null);
      }
    } catch (err: unknown) {
      log.error("Failed to load Open WebUI base URL:", err);
    }
  }, []);

  const getDownloadedChatsCount = useCallback(async (providerName: string): Promise<number> => {
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "getProviderStats",
        providerName,
      });
      if (!resp?.success) return 0;
      return resp.count || 0;
    } catch {
      return 0;
    }
  }, []);

  const updateProviderStats = useCallback(
    async (providerName: string) => {
      try {
        const downloaded = await getDownloadedChatsCount(providerName);
        setProviderStats((prev) => ({
          ...prev,
          [providerName]: { downloaded },
        }));
      } catch (error) {
        log.error("Failed to update provider stats:", error);
      }
    },
    [getDownloadedChatsCount],
  );

  // Function to query and update the sync state
  const refreshSyncState = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        action: "getBulkSyncState",
      });
      if (res.success) {
        setGlobalSyncState(res.state);
      }
    } catch (e) {
      log.warn("Could not get bulk sync state", e);
    }
  }, []);

  useEffect(() => {
    loadOpenWebUIBaseUrl();
    // Query state on initial load
    refreshSyncState();
  }, [loadOpenWebUIBaseUrl, refreshSyncState]);

  // Refresh base URL when view becomes active (e.g., switching from Settings view)
  useEffect(() => {
    if (isActive) {
      loadOpenWebUIBaseUrl();
    }
  }, [isActive, loadOpenWebUIBaseUrl]);

  useEffect(() => {
    // Load stats for all providers in parallel
    const loadStats = async () => {
      const statsPromises = providers.map((p) => updateProviderStats(p.name));

      // Execute all requests in parallel - they'll complete asynchronously
      Promise.allSettled(statsPromises).catch((err) => {
        log.error("Failed to load some provider stats:", err);
      });
    };

    loadStats();
  }, [providers, updateProviderStats]);

  useEffect(() => {
    const messageListener = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("action" in message) ||
        typeof message.action !== "string"
      ) {
        return;
      }
      const msg = message as BackgroundEvent;
      if (msg.action.startsWith("bulkSync")) {
        // If any bulk sync event happens, just re-query the canonical state
        refreshSyncState();
        // Refresh stats and chat list when sync completes
        if (
          msg.action === "bulkSyncComplete" ||
          msg.action === "bulkSyncFailed" ||
          msg.action === "bulkSyncCanceled"
        ) {
          if ("provider" in msg && typeof msg.provider === "string") {
            updateProviderStats(msg.provider);
          }
          onRefreshChats();
        }
      }
      if (message.action === "chatSynced") {
        // Refresh stats when a chat is synced (optimistic update)
        const source = message.meta?.source?.toLowerCase() || "";
        if (source) {
          let providerName: string | undefined;

          if (source.includes("openwebui")) {
            providerName = "openwebui";
          } else if (source.includes("gemini")) {
            providerName = "gemini";
          } else if (source.includes("claude")) {
            providerName = "claude";
          } else if (source.includes("poe")) {
            providerName = "poe";
          } else if (source.includes("chatgpt")) {
            providerName = "chatgpt";
          } else if (source.includes("qwen")) {
            providerName = "qwen";
          } else if (source.includes("aistudio")) {
            providerName = "aistudio";
          } else if (source.includes("deepseek")) {
            providerName = "deepseek";
          } else if (source.includes("grok")) {
            providerName = "grok";
          }

          if (providerName) {
            // Optimistically increment the count
            setProviderStats((prev) => {
              const current = prev[providerName] || { downloaded: 0 };
              return {
                ...prev,
                [providerName]: { downloaded: current.downloaded + 1 },
              };
            });
            // Also refresh from server to ensure accuracy
            fireAndForget(updateProviderStats(providerName), "Background provider stats refresh");
          }
        }
      } else if (message.action === "providerStatsUpdated") {
        // Update stats when they're recalculated in the background
        setProviderStats((prev) => ({
          ...prev,
          [message.providerName]: { downloaded: message.count || 0 },
        }));
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [updateProviderStats, onRefreshChats, refreshSyncState]);

  // Handler for importing to a provider
  const handleProviderImport = useCallback(
    (providerName: string) => {
      // Map provider name to import format
      const formatMap: Record<string, string> = {
        chatgpt: "chatgpt_zip",
        claude: "claude_zip",
        openwebui: "openwebui_zip",
      };
      const defaultFormat = formatMap[providerName] || "chatgpt_zip";
      setImportProviderFilter(defaultFormat);
      onOpenImportModal();
    },
    [setImportProviderFilter, onOpenImportModal],
  );

  const handleStartSyncConfirmed = async (providerName: string, baseUrl?: string) => {
    const options = { overwriteExisting: false };

    // Send message and check response for incomplete sync (Spec 03.02)
    const response = await chrome.runtime.sendMessage({
      action: "startBulkSync",
      provider: providerName,
      baseUrl: baseUrl,
      options,
    });

    // Check if we need to show resume dialog
    if (
      !response.success &&
      "errorCode" in response &&
      response.errorCode === "INCOMPLETE_SYNC_FOUND" &&
      "canResume" in response &&
      response.canResume &&
      "incompleteState" in response
    ) {
      // Show resume dialog
      setResumeDialogData({
        provider: providerName,
        baseUrl,
        incompleteState: response.incompleteState as BulkSyncState,
        options,
      });
      setResumeDialogOpen(true);
    }
  };

  const handleStartSync = (providerName: string, baseUrl?: string) => {
    const provider = providers.find((p) => p.name === providerName);
    if (provider?.bulkSyncConfig?.requiresActiveTab) {
      setActiveTabConfirmProvider({
        name: providerName,
        displayName: provider.displayName,
        baseUrl,
      });
      setActiveTabConfirmOpen(true);
    } else {
      handleStartSyncConfirmed(providerName, baseUrl);
    }
  };

  const handleCancelSync = async () => {
    chrome.runtime.sendMessage({ action: "cancelBulkSync" });
  };

  const handleResumeBulkSync = async () => {
    if (!resumeDialogData) return;

    // Close dialog first
    setResumeDialogOpen(false);

    // Send resume message
    await chrome.runtime.sendMessage({
      action: "resumeBulkSync",
      provider: resumeDialogData.provider,
    });

    // Clear dialog data
    setResumeDialogData(null);
  };

  const handleAbandonAndStartFresh = async () => {
    if (!resumeDialogData) return;

    // Close dialog first
    setResumeDialogOpen(false);

    // Abandon incomplete sync
    await chrome.runtime.sendMessage({
      action: "abandonBulkSync",
      provider: resumeDialogData.provider,
    });

    // Start fresh sync
    await chrome.runtime.sendMessage({
      action: "startBulkSync",
      provider: resumeDialogData.provider,
      baseUrl: resumeDialogData.baseUrl,
      options: resumeDialogData.options,
    });

    // Clear dialog data
    setResumeDialogData(null);
  };

  return (
    <>
      {/* Active-tab confirmation dialog */}
      <Dialog open={activeTabConfirmOpen} onOpenChange={setActiveTabConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep the sync tab visible during sync</DialogTitle>
            <DialogDescription>
              <strong>{activeTabConfirmProvider?.displayName}</strong> uses live page rendering to
              extract conversations. The browser tab must remain visible while the sync runs —
              switching to another tab or minimising the window will cause it to stall.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveTabConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setActiveTabConfirmOpen(false);
                if (activeTabConfirmProvider) {
                  handleStartSyncConfirmed(
                    activeTabConfirmProvider.name,
                    activeTabConfirmProvider.baseUrl,
                  );
                }
              }}
            >
              Start Sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resume Dialog (Spec 03.02) */}
      <Dialog open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resume Bulk Sync?</DialogTitle>
            <DialogDescription>
              {resumeDialogData && (
                <>
                  Found an incomplete sync for{" "}
                  <strong>
                    {providers.find((p) => p.name === resumeDialogData.provider)?.displayName ||
                      resumeDialogData.provider}
                  </strong>
                  :
                  <div className="mt-2 p-3 bg-muted rounded-md text-sm">
                    <div className="font-semibold">
                      {resumeDialogData.incompleteState.processedChatIds.length} /{" "}
                      {resumeDialogData.incompleteState.total} chats synced
                    </div>
                    {resumeDialogData.incompleteState.failedSyncs.length > 0 && (
                      <div className="text-destructive mt-1">
                        {resumeDialogData.incompleteState.failedSyncs.length} failed
                      </div>
                    )}
                    {resumeDialogData.incompleteState.skippedCount > 0 && (
                      <div className="text-muted-foreground mt-1">
                        {resumeDialogData.incompleteState.skippedCount} skipped
                      </div>
                    )}
                  </div>
                  <div className="mt-3">
                    Do you want to resume where you left off or start fresh?
                  </div>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResumeDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleAbandonAndStartFresh}>
              Start Fresh
            </Button>
            <Button variant="default" onClick={handleResumeBulkSync}>
              Resume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Providers</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Sync all chats from your AI providers
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((provider) => {
            const key = provider.name;
            const stats = providerStats[key] || { downloaded: 0 };

            // Check if a sync is running for this provider
            const isSyncingThisProvider =
              globalSyncState?.status === "running" && globalSyncState?.provider === provider.name;

            const syncState: ProviderSyncState = isSyncingThisProvider
              ? {
                  isSyncing: true,
                  progress: globalSyncState
                    ? (globalSyncState.currentIndex / globalSyncState.total) * 100
                    : 0,
                  status: isSyncingThisProvider
                    ? `Syncing ${globalSyncState.currentIndex}/${globalSyncState.total}...`
                    : "",
                  failedCount: globalSyncState?.failedSyncs.length || 0,
                }
              : {
                  isSyncing: false,
                  progress: 0,
                  status: "",
                };

            // For Open WebUI, only show if base URL is configured
            if (provider.name === "openwebui" && !openwebuiBaseUrl) {
              return null;
            }

            return (
              <ProviderCard
                key={key}
                provider={provider}
                baseUrl={provider.name === "openwebui" ? openwebuiBaseUrl || undefined : undefined}
                stats={stats}
                syncState={syncState}
                onImport={
                  provider.hasImporter ? () => handleProviderImport(provider.name) : undefined
                }
                onStartSync={
                  isSyncingThisProvider
                    ? undefined
                    : () =>
                        handleStartSync(
                          provider.name,
                          provider.name === "openwebui" ? openwebuiBaseUrl || undefined : undefined,
                        )
                }
                onCancelSync={isSyncingThisProvider ? handleCancelSync : undefined}
              />
            );
          })}
        </div>
      </div>
    </>
  );
};
