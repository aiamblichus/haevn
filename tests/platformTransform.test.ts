import { beforeAll, describe, expect, it } from "vitest";
import { getProviderByPlatform } from "../src/background/utils/platformTransform";
import { registerAllProviders } from "../src/providers/index";

// Every (platform name, hostname) pair the hand-written chain recognised, with the provider it
// chose (HVN-35). The chain matched a hostname by substring and tried the providers in
// registration order, so the mixed rows pin that order: the first provider that matches wins.
// Import-only providers (claudecode, codex, pi, openrouter) were never selected, and still are not.
const CASES: Array<[platformName: string | undefined, hostname: string, provider: string | null]> = [
  // Platform name alone
  ["gemini", "", "gemini"],
  ["claude", "", "claude"],
  ["poe", "", "poe"],
  ["chatgpt", "", "chatgpt"],
  ["openwebui", "", "openwebui"],
  ["qwen", "", "qwen"],
  ["aistudio", "", "aistudio"],
  ["deepseek", "", "deepseek"],
  ["grok", "", "grok"],

  // Hostname alone, every host the chain named (bard.google.com is Gemini's old host)
  [undefined, "gemini.google.com", "gemini"],
  [undefined, "bard.google.com", "gemini"],
  [undefined, "claude.ai", "claude"],
  [undefined, "poe.com", "poe"],
  [undefined, "chat.openai.com", "chatgpt"],
  [undefined, "chatgpt.com", "chatgpt"],
  [undefined, "chat.qwen.ai", "qwen"],
  [undefined, "aistudio.google.com", "aistudio"],
  [undefined, "chat.deepseek.com", "deepseek"],
  [undefined, "grok.com", "grok"],
  [undefined, "x.ai", "grok"],

  // Platform name and a matching host agree
  ["claude", "claude.ai", "claude"],
  ["chatgpt", "chatgpt.com", "chatgpt"],

  // Mixed: the first provider in registration order that matches wins
  ["claude", "gemini.google.com", "gemini"],
  ["grok", "chat.openai.com", "chatgpt"],
  ["chatgpt", "x.ai", "chatgpt"],
  ["poe", "claude.ai", "claude"],
  ["claude", "claude.ai.poe.com", "claude"],

  // Substring match, as before: a longer hostname still selects the provider
  [undefined, "myclaude.ai", "claude"],

  // Import-only providers are never selected for a sync, by name or by hostname
  ["claudecode", "", null],
  ["codex", "", null],
  ["pi", "", null],
  ["openrouter", "", null],
  ["openrouter", "openrouter.ai", null],
  ["claudecode", "claude.ai", "claude"],

  // Nothing recognised
  [undefined, "", null],
  [undefined, "example.com", null],
  [undefined, "localhost", null],
  ["unknown", "example.com", null],
];

describe("provider selection for a sync (HVN-35)", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  it.each(CASES)("platform %s on host %s selects %s", (platformName, hostname, provider) => {
    expect(getProviderByPlatform(platformName, hostname)?.name ?? null).toBe(provider);
  });
});
