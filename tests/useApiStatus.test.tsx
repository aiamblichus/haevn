import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApi } from "../src/options/hooks/useApi";
import type { StatusContextValue } from "../src/options/types";

// HVN-111: the archive's status lines reach the setter the hook is given. App calls useApi above
// StatusContext.Provider, where the context has only its default no-op setter.

type Api = ReturnType<typeof useApi>;
type Setter = StatusContextValue["setStatus"];

function captureApi(setStatus: Setter): Api {
  let api: Api | undefined;
  const Probe = () => {
    api = useApi(setStatus);
    return null;
  };
  renderToStaticMarkup(<Probe />);
  if (!api) throw new Error("useApi did not render");
  return api;
}

type Runtime = { sendMessage: (message: unknown) => Promise<unknown> };
const runtime = (globalThis as unknown as { chrome: { runtime: Runtime } }).chrome.runtime;
const originalSendMessage = runtime.sendMessage;

afterEach(() => {
  runtime.sendMessage = originalSendMessage;
});

describe("archive status lines reach the given setter (HVN-111)", () => {
  it("reports a failed Open on the given setter", async () => {
    runtime.sendMessage = async () => ({ success: false, error: "Chat not found in archive" });
    const setStatus = vi.fn<Setter>();
    await captureApi(setStatus).openChatInProvider("chat-1");
    expect(setStatus).toHaveBeenCalledWith("Open failed: Chat not found in archive", "error");
  });

  it("reports a failed Sync Now on the given setter, with the background's message", async () => {
    runtime.sendMessage = async (request) =>
      (request as { action: string }).action === "getSyncedChatContent"
        ? { success: true, data: { id: "chat-1", source: "claude", sourceId: "s1" } }
        : { success: false, error: "Could not find organizationId" };
    const setStatus = vi.fn<Setter>();
    const synced = await captureApi(setStatus).syncChatById("chat-1");
    expect(synced).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith(
      "Sync failed: Could not find organizationId",
      "error",
    );
  });

  it("reports the import-only Open as a warning on the given setter", async () => {
    runtime.sendMessage = async () => ({
      success: true,
      data: { id: "cc-1", source: "claudecode", sourceId: "cc-1" },
    });
    const setStatus = vi.fn<Setter>();
    await captureApi(setStatus).openChatInProvider("cc-1");
    expect(setStatus).toHaveBeenCalledWith("Cannot open this platform from archive.", "warn");
  });
});
