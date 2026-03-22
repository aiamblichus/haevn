// Logger message handlers

import { loggerService } from "../../services/loggerService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";

export async function handleGetLogs(
  message: Extract<BackgroundRequest, { action: "getLogs" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { filter } = message;
    const logs = loggerService.getLogs(filter);
    sendResponse({ success: true, logs });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get logs",
    });
  }
}

export async function handleGetLoggerConfig(
  _message: Extract<BackgroundRequest, { action: "getLoggerConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const config = loggerService.getConfig();
    sendResponse({ success: true, config });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get logger config",
    });
  }
}

export async function handleSetLoggerConfig(
  message: Extract<BackgroundRequest, { action: "setLoggerConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { config } = message;
    await loggerService.setConfig(config);
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to set logger config",
    });
  }
}

export async function handleClearLogs(
  _message: Extract<BackgroundRequest, { action: "clearLogs" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await loggerService.clearLogs();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to clear logs",
    });
  }
}
