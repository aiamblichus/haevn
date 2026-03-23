/**
 * Output formatting utilities.
 */

import consola from "consola";
import pc from "picocolors";

export { consola, pc };

/**
 * Format a timestamp for display.
 */
export function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "unknown";
  const date = new Date(ts);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a relative time (e.g., "2h ago", "3d ago").
 */
export function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return "unknown";

  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return formatTimestamp(ts);
}

/**
 * Platform display names and colors.
 */
const platformColors: Record<string, (s: string) => string> = {
  claude: pc.magenta,
  chatgpt: pc.green,
  gemini: pc.blue,
  poe: pc.yellow,
  openwebui: pc.cyan,
  qwen: pc.red,
  deepseek: pc.dim,
  aistudio: pc.blue,
  grok: pc.white,
};

export function formatPlatform(platform: string): string {
  const colorFn = platformColors[platform.toLowerCase()] || pc.white;
  return colorFn(platform);
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

/**
 * Create a horizontal divider line.
 */
export function divider(char = "━", width = 60): string {
  return char.repeat(width);
}

/**
 * Create a section header with styling.
 */
export function header(text: string, char = "━"): string {
  const trailing = Math.max(0, 60 - text.length - 6);
  return `${pc.dim(char.repeat(3))} ${pc.bold(text)} ${pc.dim(char.repeat(trailing))}`;
}

/**
 * Create a box around content.
 */
export function box(content: string, _title?: string): string {
  const lines = content.split("\n");
  const maxLen = Math.max(...lines.map((l) => l.length), 40);
  const top = `┌${"─".repeat(maxLen + 2)}┐`;
  const bottom = `└${"─".repeat(maxLen + 2)}┘`;
  const middle = lines.map((l) => `│ ${l.padEnd(maxLen)} │`).join("\n");
  return `${top}\n${middle}\n${bottom}`;
}
