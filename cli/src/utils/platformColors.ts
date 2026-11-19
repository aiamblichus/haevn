/**
 * The colour each known platform prints in, by provider name (HVN-103).
 *
 * This file has no imports on purpose: the extension's test (tests/cliPlatformColors.test.ts)
 * compares these names with the provider registry, because the CLI cannot import the registry.
 * A platform not listed here prints uncoloured.
 */

export type PlatformColor =
  | "magenta"
  | "green"
  | "blue"
  | "yellow"
  | "cyan"
  | "red"
  | "dim"
  | "white";

export const PLATFORM_COLORS: ReadonlyMap<string, PlatformColor> = new Map<string, PlatformColor>([
  ["claude", "magenta"],
  ["claudecode", "magenta"],
  ["chatgpt", "green"],
  ["codex", "green"],
  ["gemini", "blue"],
  ["poe", "yellow"],
  ["openwebui", "cyan"],
  ["pi", "cyan"],
  ["qwen", "red"],
  ["deepseek", "dim"],
  ["aistudio", "blue"],
  ["openrouter", "blue"],
  ["grok", "white"],
]);
