/**
 * Service for managing extension settings, particularly OpenWebUI instance configuration
 * and CLI integration (WebSocket daemon port + API key).
 */

import { getStorageAdapter } from "../storage";
import { log } from "../utils/logger";
import { getDB } from "./db";

/**
 * Get the configured OpenWebUI base URL.
 * Returns the first (and only) instance's baseUrl, or null if none exists.
 */
export async function getOpenWebUIBaseUrl(): Promise<string | null> {
  try {
    // Use toArray() instead of orderBy() since createdAt is not indexed
    const instances = await getDB().openwebuiInstances.toArray();
    const instance = instances[0];
    return instance?.baseUrl || null;
  } catch (err: unknown) {
    log.error("[SettingsService] Failed to get OpenWebUI base URL:", err);
    // If schema error, clear stale data
    if ((err as { name?: string })?.name === "SchemaError") {
      try {
        await getDB().openwebuiInstances.clear();
        log.info("[SettingsService] Cleared stale OpenWebUI instances due to schema error");
      } catch (clearErr) {
        log.error("[SettingsService] Failed to clear stale instances:", clearErr);
      }
    }
    return null;
  }
}

/**
 * Set the OpenWebUI base URL.
 * Creates a new instance if none exists, or updates the existing one.
 */
export async function setOpenWebUIBaseUrl(baseUrl: string): Promise<void> {
  const normalizedUrl = baseUrl.trim().replace(/\/$/, ""); // Remove trailing slash

  try {
    // Get existing instance, if any
    const instances = await getDB().openwebuiInstances.toArray();
    const existing = instances[0];

    if (existing) {
      // Update existing
      await getDB().openwebuiInstances.update(existing.id, {
        baseUrl: normalizedUrl,
        alias: normalizedUrl,
      });
    } else {
      // Create new
      await getDB().openwebuiInstances.add({
        id: crypto.randomUUID(),
        baseUrl: normalizedUrl,
        alias: normalizedUrl,
        createdAt: Date.now(),
      });
    }
  } catch (err: unknown) {
    log.error("[SettingsService] Failed to save base URL:", err);
    // If schema error, clear stale data and retry
    if ((err as { name?: string })?.name === "SchemaError") {
      try {
        await getDB().openwebuiInstances.clear();
        // Retry creating the instance
        await getDB().openwebuiInstances.add({
          id: crypto.randomUUID(),
          baseUrl: normalizedUrl,
          alias: normalizedUrl,
          createdAt: Date.now(),
        });
        return;
      } catch (retryErr) {
        log.error("[SettingsService] Failed to retry after clearing stale data:", retryErr);
      }
    }
    throw err;
  }
}

/**
 * Clear the OpenWebUI base URL setting.
 * Deletes all instances (should only be one, but clears all to be safe).
 */
export async function clearOpenWebUIBaseUrl(): Promise<void> {
  try {
    // Use toArray() instead of orderBy() since createdAt is not indexed
    const instances = await getDB().openwebuiInstances.toArray();
    // Delete all instances (should only be one, but clear all to be safe)
    for (const instance of instances) {
      await getDB().openwebuiInstances.delete(instance.id);
    }
  } catch (err: unknown) {
    log.error("[SettingsService] Failed to clear base URL:", err);
    // If schema error, try to clear all instances
    if ((err as { name?: string })?.name === "SchemaError") {
      try {
        await getDB().openwebuiInstances.clear();
        return;
      } catch (clearErr) {
        log.error("[SettingsService] Failed to clear stale instances:", clearErr);
      }
    }
    throw err;
  }
}

// ─── CLI Integration Settings ──────────────────────────────────────────────────

const CLI_PORT_KEY = "haevn.cli.port";
const CLI_API_KEY_KEY = "haevn.cli.apiKey";

export const DEFAULT_CLI_PORT = 5517;

export interface CliSettings {
  port: number;
  apiKey: string;
}

/**
 * Get CLI integration settings (daemon port + API key).
 * Lazily creates and persists the API key on first access.
 */
export async function getCliSettings(): Promise<CliSettings> {
  const storage = getStorageAdapter();
  const port = (await storage.get<number>(CLI_PORT_KEY)) ?? DEFAULT_CLI_PORT;

  let apiKey = await storage.get<string>(CLI_API_KEY_KEY);
  if (!apiKey) {
    apiKey = crypto.randomUUID();
    await storage.set(CLI_API_KEY_KEY, apiKey);
    log.info("[SettingsService] Generated new CLI API key");
  }

  return { port, apiKey };
}

/**
 * Update the CLI daemon port.
 */
export async function setCliPort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be an integer between 1024 and 65535");
  }
  await getStorageAdapter().set(CLI_PORT_KEY, port);
  log.info("[SettingsService] CLI daemon port updated", { port });
}

/**
 * Replace the CLI API key with a freshly generated UUID.
 * Returns the new key so callers can immediately display it.
 */
export async function regenerateCliApiKey(): Promise<string> {
  const apiKey = crypto.randomUUID();
  await getStorageAdapter().set(CLI_API_KEY_KEY, apiKey);
  log.info("[SettingsService] CLI API key regenerated");
  return apiKey;
}

// ─── AI Metadata Settings ──────────────────────────────────────────────────────

const METADATA_AI_KEY = "haevn.metadata.ai";

export interface CategoryConfig {
  name: string;
  description: string;
}

export interface MetadataAIConfig {
  enabled: boolean;
  warningAcknowledged: boolean;
  url: string;
  apiKey: string;
  model: string;
  autoGenerate: boolean;
  categories: CategoryConfig[];
}

const METADATA_AI_DEFAULTS: MetadataAIConfig = {
  enabled: false,
  warningAcknowledged: false,
  url: "",
  apiKey: "",
  model: "",
  autoGenerate: false,
  categories: [],
};

export async function getMetadataAIConfig(): Promise<MetadataAIConfig> {
  const stored = await getStorageAdapter().get<Partial<MetadataAIConfig>>(METADATA_AI_KEY);
  const merged = { ...METADATA_AI_DEFAULTS, ...(stored ?? {}) };
  // Migrate from old string[] format
  if (
    Array.isArray(merged.categories) &&
    merged.categories.length > 0 &&
    typeof merged.categories[0] === "string"
  ) {
    merged.categories = (merged.categories as unknown as string[]).map((name) => ({
      name,
      description: "",
    }));
  }
  return merged;
}

export async function setMetadataAIConfig(config: Partial<MetadataAIConfig>): Promise<void> {
  const current = await getMetadataAIConfig();
  await getStorageAdapter().set(METADATA_AI_KEY, { ...current, ...config });
  log.info("[SettingsService] Metadata AI config updated");
}
