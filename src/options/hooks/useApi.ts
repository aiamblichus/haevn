import { useCallback } from "react";
import type { Chat } from "../../model/haevn_model";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { useStatus } from "../context/StatusContext";
import type { ExportOptions } from "../types";
import { buildChatUrl } from "../utils";

export const useApi = () => {
  const { setStatus } = useStatus();

  const syncChatById = useCallback(
    async (chatId: string): Promise<boolean> => {
      try {
        const request: BackgroundRequest = {
          action: "getSyncedChatContent",
          chatId,
        };
        const resp = (await chrome.runtime.sendMessage(request)) as BackgroundResponse;
        if (!resp?.success || !resp.data)
          throw new Error("error" in resp ? resp.error : "Not found");
        const chat = resp.data as Chat;
        const url = buildChatUrl(chat.source, chat.sourceId);
        if (!url) {
          setStatus("Cannot sync this platform yet from archive.", "warn");
          return false;
        }
        setStatus("Syncing chat...", "work");
        const syncRequest: BackgroundRequest = {
          action: "syncChatByUrl",
          url,
        };
        const syncResp = (await chrome.runtime.sendMessage(syncRequest)) as BackgroundResponse;
        if (!syncResp?.success)
          throw new Error("error" in syncResp ? syncResp.error : "Sync failed");
        setStatus("Chat synced.", "ok");
        return true;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Sync failed: ${msg}`, "error");
        return false;
      }
    },
    [setStatus],
  );

  const exportChatById = useCallback(
    async (chatId: string, options: ExportOptions): Promise<void> => {
      const request: BackgroundRequest = {
        action: "exportSyncedChat",
        chatId,
        options,
      };
      await chrome.runtime.sendMessage(request);
      setStatus("Export triggered.", "ok");
    },
    [setStatus],
  );

  const openChatInProvider = useCallback(
    async (chatId: string): Promise<void> => {
      try {
        const request: BackgroundRequest = {
          action: "getSyncedChatContent",
          chatId,
        };
        const resp = (await chrome.runtime.sendMessage(request)) as BackgroundResponse;
        if (!resp?.success || !resp.data)
          throw new Error("error" in resp ? resp.error : "Chat not found");
        const chat = resp.data as Chat;
        let url = buildChatUrl(chat.source, chat.sourceId);
        if (!url && chat.source?.includes("openwebui")) {
          const origin = chat.params?.openwebui_origin as string | undefined;
          if (origin && chat.sourceId) url = `${origin}/c/${chat.sourceId}`;
        }
        if (!url) {
          setStatus("Cannot open this platform from archive.", "warn");
          return;
        }
        await chrome.tabs.create({ url, active: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Open failed: ${msg}`, "error");
      }
    },
    [setStatus],
  );

  const openChatInViewer = useCallback(
    async (chatId: string, messageId?: string, query?: string): Promise<void> => {
      const url = chrome.runtime.getURL(
        `viewer.html?chatId=${encodeURIComponent(chatId)}${
          messageId ? `&messageId=${encodeURIComponent(messageId)}` : ""
        }${query ? `&query=${encodeURIComponent(query)}` : ""}`,
      );
      await chrome.tabs.create({ url, active: true });
    },
    [],
  );

  return { syncChatById, exportChatById, openChatInProvider, openChatInViewer };
};
