/**
 * Service for managing extension settings, particularly OpenWebUI instance configuration.
 * This service abstracts database access for settings-related operations.
 */

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
