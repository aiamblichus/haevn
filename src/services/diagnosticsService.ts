/**
 * @file Diagnostics Service
 * @description Tracks background operations to detect crashes and timeouts.
 *
 * It uses a direct storage approach to persist "Active Operations" state.
 * If the Service Worker crashes, the "Active Operations" will remain in storage.
 * On next boot, we can inspect this to see what was running when it died.
 */

import { log } from "../utils/logger";

const STORAGE_KEY_DIAGNOSTICS = "diagnostics:state";
const HEARTBEAT_INTERVAL_MS = 5000;

interface ActiveOperation {
  id: string;
  name: string;
  startTime: number;
  metadata?: unknown;
}

interface DiagnosticsState {
  lastHeartbeat: number;
  activeOperations: Record<string, ActiveOperation>;
  bootTime: number;
}

class DiagnosticsService {
  private activeOps: Map<string, ActiveOperation> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private storage: typeof chrome.storage.local | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      this.storage = chrome.storage.local;
    } else {
      console.warn("[Diagnostics] chrome.storage.local not available");
      return;
    }

    this.initialized = true;

    // Check for previous crash
    await this.checkCrash();

    // Reset state for this session
    await this.persistState();

    // Start heartbeat
    this.startHeartbeat();

    log.info("[Diagnostics] Service initialized");
  }

  /**
   * Start tracking an operation.
   * Persists to storage immediately (fire-and-forget to avoid blocking too much).
   */
  trackOperation(name: string, metadata?: unknown): string {
    const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const op: ActiveOperation = {
      id,
      name,
      startTime: Date.now(),
      metadata,
    };

    this.activeOps.set(id, op);
    this.persistState().catch((err) => {
      console.error("[Diagnostics] Failed to persist trackOperation:", err);
    });

    return id;
  }

  /**
   * End tracking an operation.
   */
  async endOperation(id: string): Promise<void> {
    if (!this.activeOps.has(id)) return;

    const op = this.activeOps.get(id);
    const duration = Date.now() - (op?.startTime || 0);

    this.activeOps.delete(id);

    // Log long-running operations (>5s)
    if (duration > 5000) {
      log.warn(`[Diagnostics] Long-running operation: ${op?.name} (${duration}ms)`, op?.metadata);
    }

    try {
      await this.persistState();
    } catch (err) {
      console.error("[Diagnostics] Failed to persist endOperation:", err);
    }
  }

  /**
   * Wrap a promise-returning function with operation tracking
   */
  async wrap<T>(name: string, fn: () => Promise<T>, metadata?: unknown): Promise<T> {
    const opId = this.trackOperation(name, metadata);
    try {
      return await fn();
    } finally {
      await this.endOperation(opId);
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      this.persistState().catch((err) => {
        console.error("[Diagnostics] Heartbeat flush failed", err);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async persistState(): Promise<void> {
    if (!this.storage) return;

    const state: DiagnosticsState = {
      lastHeartbeat: Date.now(),
      activeOperations: Object.fromEntries(this.activeOps),
      bootTime: Date.now(), // This updates on every persist, essentially "process active since..."
      // Actually, we want bootTime to be constant for the session.
      // But since we overwrite the whole object, we need to store the original boot time?
      // For simplified crash detection, just lastHeartbeat is enough.
    };

    await this.storage.set({ [STORAGE_KEY_DIAGNOSTICS]: state });
  }

  private async checkCrash(): Promise<void> {
    if (!this.storage) return;

    try {
      const result = await this.storage.get(STORAGE_KEY_DIAGNOSTICS);
      const lastState = result[STORAGE_KEY_DIAGNOSTICS] as DiagnosticsState | undefined;

      if (!lastState) return;

      const now = Date.now();
      const timeSinceHeartbeat = now - lastState.lastHeartbeat;

      // If last heartbeat was > 30s ago (and we just booted), it might be a crash or just normal idle termination.
      // Normal idle termination usually kills the SW cleanly? actually no, SW just stops.
      // But if there were ACTIVE operations when it stopped, THAT is a crash/kill during active work.

      const staleOps = Object.values(lastState.activeOperations || {});

      if (staleOps.length > 0) {
        log.error(
          `[Diagnostics] CRASH DETECTED: Extension restarted with ${staleOps.length} active operations pending.`,
          {
            timeSinceLastHeartbeat: timeSinceHeartbeat,
            staleOperations: staleOps,
          },
        );

        // Also log to console for visibility
        console.error(
          "%c[Diagnostics] Previous session crashed with active operations:",
          "color: red; font-weight: bold",
          staleOps,
        );
      } else {
        log.info("[Diagnostics] Clean startup. No pending operations from previous session.");
      }
    } catch (err) {
      console.error("[Diagnostics] Failed to check for crash:", err);
    }
  }
}

export const diagnosticsService = new DiagnosticsService();
