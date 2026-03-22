import { getStorageAdapter } from "../../storage";

const EXPORT_STATE_KEY = "exportJobState";

export type ExportJobStatus = "running" | "paused" | "cancelled" | "complete" | "error";

export interface ExportJobState {
  exportId: string;
  status: ExportJobStatus;
  totalChats: number;
  processedChats: number;
  processedMedia: number;
  bytesWritten: number;
  startedAt: number;
  lastCheckpointAt: number;
  stagingRoot: string;
  zipPath: string;
  manifestPaths: {
    meta: string;
    chats: string;
    media: string;
  };
  error?: string;
}

export async function getExportJobState(): Promise<ExportJobState | null> {
  const storage = getStorageAdapter();
  return await storage.get<ExportJobState>(EXPORT_STATE_KEY);
}

export async function setExportJobState(state: ExportJobState | null): Promise<void> {
  const storage = getStorageAdapter();
  if (state === null) {
    await storage.remove(EXPORT_STATE_KEY);
    return;
  }
  await storage.set(EXPORT_STATE_KEY, state);
}
