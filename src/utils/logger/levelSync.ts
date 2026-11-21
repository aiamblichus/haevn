/**
 * Level sync: keeps this context's logger level in step with the Capture level
 * that the logs viewer saves (`logger:config` in chrome.storage.local).
 *
 * LoggerService also filters at the sink, so this is an economy: a context that
 * follows the stored level never builds or sends the entries the sink would drop.
 * Contexts without chrome.storage (Web Workers, offscreen documents) skip it and
 * rely on the sink.
 */

import { setLogLevel } from "./core";
import { LogLevel } from "./types";

export const LOGGER_CONFIG_STORAGE_KEY = "logger:config";

function applyStoredConfig(value: unknown): void {
  const minLevel = (value as { minLevel?: unknown } | undefined)?.minLevel;
  if (typeof minLevel === "number" && minLevel in LogLevel) {
    setLogLevel(minLevel as LogLevel);
  }
}

export function followStoredLogLevel(): void {
  const storage = typeof chrome !== "undefined" ? chrome.storage : undefined;
  if (!storage?.local) return;

  try {
    storage.local
      .get(LOGGER_CONFIG_STORAGE_KEY)
      .then((result) => applyStoredConfig(result?.[LOGGER_CONFIG_STORAGE_KEY]))
      .catch(() => {});
    storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const change = changes[LOGGER_CONFIG_STORAGE_KEY];
      if (change) applyStoredConfig(change.newValue);
    });
  } catch {
    // Logging must never break a context; the sink still filters.
  }
}
