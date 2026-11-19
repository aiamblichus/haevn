/**
 * The import format a provider's Import button opens the import dialog on (HVN-101). The button
 * shows only on a provider with an importer; tests/importFormatByProvider.test.ts holds every such
 * provider to having a format here. A provider with no entry opens on the dialog's default.
 */
const IMPORT_FORMAT_BY_PROVIDER: Partial<Record<string, string>> = {
  chatgpt: "chatgpt_zip",
  claude: "claude_zip",
  claudecode: "claudecode_jsonl",
  codex: "codex_jsonl",
  pi: "pi_jsonl",
  openrouter: "openrouter_json",
  openwebui: "openwebui_zip",
};

export function importFormatFor(providerName: string): string | undefined {
  return IMPORT_FORMAT_BY_PROVIDER[providerName];
}
