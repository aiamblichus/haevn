/**
 * CLI daemon configuration.
 *
 * Reads/writes a JSON file at ~/.haevn/config.json so the user only needs to
 * configure the port and API key once.  CLI flags always take precedence.
 *
 * Schema:
 *   {
 *     "port":   5517,
 *     "apiKey": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_DAEMON_PORT = 5517;

export const HAEVN_DIR = path.join(os.homedir(), ".haevn");
export const CONFIG_PATH = path.join(HAEVN_DIR, "config.json");

export interface DaemonConfig {
  port: number;
  apiKey: string;
}

/**
 * Load config from disk, falling back to defaults for any missing fields.
 * Never throws — a missing or malformed file is treated as empty config.
 */
export function loadConfig(): Partial<DaemonConfig> {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as Partial<DaemonConfig>;
  } catch {
    return {};
  }
}

/**
 * Persist config to disk, merging with any existing values.
 */
export function saveConfig(updates: Partial<DaemonConfig>): void {
  const existing = loadConfig();
  const merged = { ...existing, ...updates };
  fs.mkdirSync(HAEVN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Resolve the effective daemon config from disk config + CLI flag overrides.
 * Throws a user-friendly error if the API key is missing from both sources.
 */
export function resolveConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  const file = loadConfig();
  const port = overrides.port ?? file.port ?? DEFAULT_DAEMON_PORT;
  const apiKey = overrides.apiKey ?? file.apiKey;

  if (!apiKey) {
    throw new Error(
      "No API key configured.\n\n" +
        "Copy the API key from the HAEVN extension Settings page and run:\n" +
        "  haevn daemon --api-key <key>\n\n" +
        "To save it permanently:\n" +
        `  echo '{"apiKey":"<key>"}' > ${CONFIG_PATH}`,
    );
  }

  return { port, apiKey };
}
