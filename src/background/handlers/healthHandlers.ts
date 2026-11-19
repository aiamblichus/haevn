// Provider health message handler: the extension's own entry (haevnDebug.providerHealth). The CLI
// verb `haevn health` reaches the same operation through the bridge (wsBridge.ts).

import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { chromeHealthDeps } from "../health/chromeProbe";
import { HealthBusyError, HealthRequestError, runProviderHealth } from "../health/providerHealth";

export async function handleProviderHealth(
  message: Extract<BackgroundRequest, { action: "providerHealth" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const report = await runProviderHealth(
      {
        providers: message.providers,
        chats: message.chats,
        timeoutMs: message.timeoutMs,
        totalMs: message.totalMs,
      },
      chromeHealthDeps(),
    );
    sendResponse({ success: true, data: report });
  } catch (err: unknown) {
    if (err instanceof HealthBusyError) {
      sendResponse({ success: false, error: err.message, errorCode: "BUSY" });
      return;
    }
    if (err instanceof HealthRequestError) {
      sendResponse({ success: false, error: err.message, errorCode: "BAD_REQUEST" });
      return;
    }
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "The provider health check failed",
    });
  }
}
