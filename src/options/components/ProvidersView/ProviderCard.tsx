import React from "react";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Progress } from "../../../components/ui/progress";
import type { Provider } from "../../../providers/provider";
import type { ProviderStats, ProviderSyncState } from "../../types";

interface ProviderCardProps {
  provider: Provider;
  baseUrl?: string;
  alias?: string;
  stats: ProviderStats;
  syncState: ProviderSyncState;
  onImport?: () => void;
  onStartSync?: () => void;
  onCancelSync?: () => void;
}

export const ProviderCard = ({
  provider,
  baseUrl,
  alias,
  stats,
  syncState,
  onImport,
  onStartSync,
  onCancelSync,
}: ProviderCardProps) => {
  const displayName = alias || provider.displayName;

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden">
              <img
                src={chrome.runtime.getURL(`icons/${provider.name}.png`)}
                alt={displayName}
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <CardTitle>{displayName}</CardTitle>
              {baseUrl && <CardDescription className="text-xs mt-1">{baseUrl}</CardDescription>}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Downloaded</div>
            <div className="text-lg font-semibold">{stats.downloaded}</div>
          </div>
        </div>
        {syncState.isSyncing ? (
          <div className="space-y-2">
            <Progress value={syncState.progress} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{syncState.status}</span>
              <span>{Math.round(syncState.progress)}%</span>
            </div>
            {syncState.failedCount !== undefined && syncState.failedCount > 0 && (
              <div className="text-xs text-red-600 dark:text-red-400">
                {syncState.failedCount} failed
              </div>
            )}
            {onCancelSync && (
              <Button variant="destructive" size="sm" className="w-full" onClick={onCancelSync}>
                Cancel Sync
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {onStartSync && (
              <Button variant="default" size="sm" className="w-full" onClick={onStartSync}>
                Sync All
              </Button>
            )}
            {!onStartSync && (
              <div className="text-xs text-muted-foreground text-center py-2">
                Sync from popup when on provider page
              </div>
            )}
            {provider.importer && onImport && (
              <Button variant="outline" size="sm" className="w-full" onClick={onImport}>
                Import
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
