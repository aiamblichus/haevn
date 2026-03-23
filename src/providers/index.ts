import { aistudioProvider } from "./aistudio/provider";
import { chatgptProvider } from "./chatgpt/provider";
import { claudeProvider } from "./claude/provider";
import { claudeCodeProvider } from "./claudecode/provider";
import { codexProvider } from "./codex/provider";
import { deepseekProvider } from "./deepseek/provider";
import { geminiProvider } from "./gemini/provider";
import { grokProvider } from "./grok/provider";
import { openwebuiProvider } from "./openwebui/provider";
import { piProvider } from "./pi/provider";
import { poeProvider } from "./poe/provider";
import { registerProvider } from "./provider";
import { qwenProvider } from "./qwen/provider";

/**
 * Registers all supported providers.
 * Should be called once during extension initialization (background and content scripts).
 */
export function registerAllProviders(): void {
  registerProvider(geminiProvider);
  registerProvider(claudeProvider);
  registerProvider(poeProvider);
  registerProvider(chatgptProvider);
  registerProvider(openwebuiProvider);
  registerProvider(qwenProvider);
  registerProvider(aistudioProvider);
  registerProvider(deepseekProvider);
  registerProvider(grokProvider);
  registerProvider(claudeCodeProvider);
  registerProvider(codexProvider);
  registerProvider(piProvider);
}
