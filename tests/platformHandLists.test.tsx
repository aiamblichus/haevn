import { beforeAll, describe, expect, it } from "vitest";
import { extractProviderName } from "../src/services/chatService";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders } from "../src/providers/provider";
import { buildChatUrl, getPlatformIcon } from "../src/options/utils";

// HVN-103: the hand-written lists that map a chat's source to a provider, an icon or a web URL.
// Each is held to the registry: every registered provider must come out of it, and Claude Code
// must not fall into the claude branch (it is import-only, with no web chat and its own icon).

function iconSrc(source: string): string {
  return (getPlatformIcon(source).props as { src: string }).src;
}

describe("provider name from a chat's source (HVN-103)", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  it("maps every registered provider's own name to that provider", () => {
    for (const provider of getAllProviders()) {
      expect(extractProviderName(provider.name), provider.name).toBe(provider.name);
    }
  });

  it("keeps Claude Code apart from Claude", () => {
    expect(extractProviderName("claudecode")).toBe("claudecode");
    expect(extractProviderName("claude")).toBe("claude");
  });

  it("returns null for a source it does not know", () => {
    expect(extractProviderName("no-such-provider")).toBeNull();
  });
});

describe("Archive icon and Open at Provider link (HVN-103)", () => {
  beforeAll(() => {
    registerAllProviders();
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it("shows each registered provider its own icon", () => {
    for (const provider of getAllProviders()) {
      expect(iconSrc(provider.name), provider.name).toBe(
        `chrome-extension://test/icons/${provider.name}.png`,
      );
    }
  });

  it("gives each registered provider the link its own definition builds", () => {
    for (const provider of getAllProviders()) {
      // Open WebUI's host is the user's own, so the Archive cannot build its link
      if (provider.name === "openwebui") continue;
      expect(buildChatUrl(provider.name, "chat-1"), provider.name).toBe(
        provider.buildChatUrl("chat-1") || null,
      );
    }
  });

  it("gives a Claude Code chat no web link", () => {
    expect(buildChatUrl("claudecode", "chat-1")).toBeNull();
  });
});
