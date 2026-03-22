/**
 * @file Logger viewer UI
 * @description Displays centralized logs from all extension contexts
 */

import type {
  BackgroundRequest,
  BackgroundResponse,
  LogEntry,
  LogFilter,
  LoggerConfig,
} from "../types/messaging";
import { LogLevel } from "../types/messaging";

// UI state
let logs: LogEntry[] = [];
let config: LoggerConfig | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let filterContext: string = "all";
let filterLevel: string = "all";
let filterSearch: string = "";
let autoRefresh: boolean = true;
let selectedLogIds: Set<string> = new Set();
const expandedLogIds: Set<string> = new Set();
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

// DOM elements (will be initialized)
let logsContainer: HTMLElement;
let statusIndicator: HTMLElement;
let contextFilter: HTMLSelectElement;
let levelFilter: HTMLSelectElement;
let searchFilter: HTMLInputElement;
let levelConfig: HTMLSelectElement;
let clearButton: HTMLButtonElement;
let refreshButton: HTMLButtonElement;
let copyButton: HTMLButtonElement;
let autoRefreshCheckbox: HTMLInputElement;
let selectAllCheckbox: HTMLInputElement;
let logsCount: HTMLElement;
let selectedCount: HTMLElement;

/**
 * Send message to background and await response
 */
async function sendMessage(request: BackgroundRequest): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Fetch logs from background
 */
async function fetchLogs(): Promise<void> {
  try {
    const filter: LogFilter = {};
    if (filterContext !== "all") {
      filter.context = filterContext;
    }
    if (filterLevel !== "all") {
      filter.level = filterLevel;
    }
    if (filterSearch.trim() !== "") {
      filter.match = filterSearch;
    }

    const response = await sendMessage({ action: "getLogs", filter });
    if (response.success && "logs" in response) {
      logs = response.logs as LogEntry[];
      pruneSelection();
      renderLogs();
    }
  } catch (err) {
    console.error("[LogsViewer] Failed to fetch logs:", err);
    updateStatus("error", "Failed to fetch logs");
  }
}

/**
 * Fetch config from background
 */
async function fetchConfig(): Promise<void> {
  try {
    const response = await sendMessage({ action: "getLoggerConfig" });
    if (response.success && "config" in response) {
      config = response.config as LoggerConfig;
      updateLevelConfig();
    }
  } catch (err) {
    console.error("[LogsViewer] Failed to fetch config:", err);
  }
}

/**
 * Update log level config
 */
async function updateLogLevel(level: number): Promise<void> {
  try {
    await sendMessage({
      action: "setLoggerConfig",
      config: { minLevel: level },
    });
    await fetchConfig();
  } catch (err) {
    console.error("[LogsViewer] Failed to update log level:", err);
    updateStatus("error", "Failed to update log level");
  }
}

/**
 * Clear all logs
 */
async function clearLogs(): Promise<void> {
  if (!confirm("Clear all logs?")) {
    return;
  }

  try {
    await sendMessage({ action: "clearLogs" });
    logs = [];
    selectedLogIds.clear();
    renderLogs();
    updateStatus("success", "Logs cleared");
  } catch (err) {
    console.error("[LogsViewer] Failed to clear logs:", err);
    updateStatus("error", "Failed to clear logs");
  }
}

/**
 * Copy logs to clipboard as plain text
 */
async function copyLogsToClipboard(): Promise<void> {
  const targetLogs = getLogsForCopy();

  if (targetLogs.length === 0) {
    updateStatus("error", selectedLogIds.size > 0 ? "No selected logs to copy" : "No logs to copy");
    return;
  }

  try {
    // Format logs as plain text
    const lines: string[] = [];

    // Sort logs by timestamp (oldest first for chronological order)
    const sortedLogs = [...targetLogs].sort((a, b) => a.timestamp - b.timestamp);

    for (const log of sortedLogs) {
      // Add log level and message
      lines.push(
        `${formatTimestamp(log.timestamp)} [${log.level}] (${log.context}) ${log.message}`,
      );

      // Add data object if present
      if (log.data !== undefined && log.data !== null) {
        try {
          const dataStr =
            typeof log.data === "string" ? log.data : JSON.stringify(log.data, null, 2);
          lines.push(`  Data: ${dataStr}`);
        } catch (err) {
          lines.push(`  Data: [Unable to stringify: ${err}]`);
        }
      }

      // Add blank line between entries
      lines.push("");
    }

    const text = lines.join("\n");

    // Copy to clipboard
    await navigator.clipboard.writeText(text);
    const copyScope = selectedLogIds.size > 0 ? "selected " : "";
    updateStatus("success", `Copied ${copyScope}${targetLogs.length} log(s) to clipboard`);

    // Reset status after 2 seconds
    setTimeout(() => {
      if (statusIndicator.textContent?.includes("Copied")) {
        checkServiceWorkerStatus();
      }
    }, 2000);
  } catch (err) {
    console.error("[LogsViewer] Failed to copy logs:", err);
    updateStatus("error", "Failed to copy logs to clipboard");
  }
}

/**
 * Check service worker status
 */
async function checkServiceWorkerStatus(): Promise<void> {
  try {
    // Try to ping the background
    await sendMessage({ action: "getLoggerConfig" });
    updateStatus("active", "Service worker active");
  } catch (_err) {
    updateStatus("inactive", "Service worker inactive");
  }
}

/**
 * Update status indicator
 */
function updateStatus(status: "active" | "inactive" | "error" | "success", message: string): void {
  statusIndicator.className = `status status-${status}`;
  statusIndicator.textContent = message;
}

/**
 * Update level config dropdown
 */
function updateLevelConfig(): void {
  if (!config) return;

  levelConfig.value = config.minLevel.toString();
}

/**
 * Format timestamp (HH:mm:ss.SSS)
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    date.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
    "." +
    date.getMilliseconds().toString().padStart(3, "0")
  );
}

/**
 * Get log level color class
 */
function getLevelColorClass(level: string): string {
  switch (level) {
    case "DEBUG":
      return "level-debug";
    case "INFO":
      return "level-info";
    case "WARN":
      return "level-warn";
    case "ERROR":
      return "level-error";
    default:
      return "";
  }
}

/**
 * Render logs to DOM
 */
function renderLogs(): void {
  logsContainer.innerHTML = "";

  if (logs.length === 0) {
    logsContainer.innerHTML = '<div class="empty">No logs found</div>';
    logsCount.textContent = "0";
    updateSelectionUI();
    return;
  }

  logsCount.textContent = logs.length.toString();

  // Render in reverse order (newest first)
  const reversed = [...logs].reverse();

  for (const log of reversed) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${getLevelColorClass(log.level)}`;
    if (log.data || log.stack) {
      entry.classList.add("has-details");
    }
    if (expandedLogIds.has(log.id)) {
      entry.classList.add("is-expanded");
    }

    const header = document.createElement("div");
    header.className = "log-main";
    header.addEventListener("click", (e) => {
      // Don't toggle if clicking checkbox
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (log.data || log.stack) {
        if (expandedLogIds.has(log.id)) {
          expandedLogIds.delete(log.id);
          entry.classList.remove("is-expanded");
        } else {
          expandedLogIds.add(log.id);
          entry.classList.add("is-expanded");
        }
      }
    });

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "log-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.logId = log.id;
    checkbox.checked = selectedLogIds.has(log.id);
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        selectedLogIds.add(log.id);
      } else {
        selectedLogIds.delete(log.id);
      }
      updateSelectionUI();
    });
    checkboxLabel.appendChild(checkbox);
    header.appendChild(checkboxLabel);

    const timestamp = document.createElement("span");
    timestamp.className = "log-timestamp";
    timestamp.textContent = formatTimestamp(log.timestamp);
    header.appendChild(timestamp);

    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = log.level;
    header.appendChild(level);

    const context = document.createElement("span");
    context.className = "log-context";
    context.textContent = log.context;
    header.appendChild(context);

    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = log.message;
    header.appendChild(message);

    entry.appendChild(header);

    const detailsContainer = document.createElement("div");
    detailsContainer.className = "log-details";

    if (log.data) {
      const data = document.createElement("pre");
      data.className = "log-data";
      data.textContent = JSON.stringify(log.data, null, 2);
      detailsContainer.appendChild(data);
    }

    if (log.stack) {
      const stack = document.createElement("pre");
      stack.className = "log-stack";
      stack.textContent = log.stack;
      detailsContainer.appendChild(stack);
    }

    if (log.url) {
      const url = document.createElement("div");
      url.className = "log-url";
      url.textContent = log.url;
      detailsContainer.appendChild(url);
    }

    if (detailsContainer.children.length > 0) {
      entry.appendChild(detailsContainer);
    }

    logsContainer.appendChild(entry);
  }

  updateSelectionUI();
}

/**
 * Initialize UI
 */
function initializeUI(): void {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    <div class="container">
      <header class="header">
        <div class="title-group">
          <h1>HAEVN Logs</h1>
          <div id="status-indicator" class="status status-active">Service worker active</div>
        </div>
      </header>

      <div class="controls">
        <div class="controls-left">
          <div class="control-group">
            <label for="context-filter">Context</label>
            <select id="context-filter">
              <option value="all">All</option>
            </select>
          </div>

          <div class="control-group">
            <label for="level-filter">Level</label>
            <select id="level-filter">
              <option value="all">All</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>

          <div class="control-group">
            <label for="level-config">Capture</label>
            <select id="level-config">
              <option value="${LogLevel.DEBUG}">DEBUG+</option>
              <option value="${LogLevel.INFO}">INFO+</option>
              <option value="${LogLevel.WARN}">WARN+</option>
              <option value="${LogLevel.ERROR}">ERROR+</option>
              <option value="${LogLevel.NONE}">NONE</option>
            </select>
          </div>

          <div class="control-group search-group">
            <label for="search-filter">Search</label>
            <input type="text" id="search-filter" placeholder="Search logs..." />
          </div>

          <div class="control-group checkbox-group">
            <label>
              <input type="checkbox" id="auto-refresh" checked />
              Live
            </label>
          </div>
        </div>

        <div class="controls-right">
          <label class="control-group select-all-group">
            <input type="checkbox" id="select-all" />
            Select all
          </label>
          <div class="stats-group">
            <div class="selected-count">
              <span id="selected-count">0</span> chosen
            </div>
            <div class="logs-count">
              <span id="logs-count">0</span> total
            </div>
          </div>
          <button id="refresh-button" class="button button-secondary">Refresh</button>
          <button id="copy-button" class="button">Copy Logs</button>
          <button id="clear-button" class="button button-danger">Clear</button>
        </div>
      </div>

      <div id="logs-container" class="logs-container"></div>
    </div>
  `;

  // Get references to DOM elements
  const logsContainerEl = document.getElementById("logs-container");
  const statusIndicatorEl = document.getElementById("status-indicator");
  const logsCountEl = document.getElementById("logs-count");
  if (!logsContainerEl || !statusIndicatorEl || !logsCountEl) {
    throw new Error("Required DOM elements not found");
  }
  logsContainer = logsContainerEl;
  statusIndicator = statusIndicatorEl;
  logsCount = logsCountEl;
  contextFilter = document.getElementById("context-filter") as HTMLSelectElement;
  levelFilter = document.getElementById("level-filter") as HTMLSelectElement;
  searchFilter = document.getElementById("search-filter") as HTMLInputElement;
  levelConfig = document.getElementById("level-config") as HTMLSelectElement;
  clearButton = document.getElementById("clear-button") as HTMLButtonElement;
  refreshButton = document.getElementById("refresh-button") as HTMLButtonElement;
  copyButton = document.getElementById("copy-button") as HTMLButtonElement;
  autoRefreshCheckbox = document.getElementById("auto-refresh") as HTMLInputElement;
  selectAllCheckbox = document.getElementById("select-all") as HTMLInputElement;
  selectedCount = document.getElementById("selected-count") as HTMLElement;

  // Set up event listeners
  contextFilter.addEventListener("change", (e) => {
    filterContext = (e.target as HTMLSelectElement).value;
    fetchLogs();
  });

  levelFilter.addEventListener("change", (e) => {
    filterLevel = (e.target as HTMLSelectElement).value;
    fetchLogs();
  });

  searchFilter.addEventListener("input", (e) => {
    filterSearch = (e.target as HTMLInputElement).value;

    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      fetchLogs();
    }, 300);
  });

  levelConfig.addEventListener("change", (e) => {
    const level = parseInt((e.target as HTMLSelectElement).value, 10);
    updateLogLevel(level);
  });

  clearButton.addEventListener("click", clearLogs);
  copyButton.addEventListener("click", copyLogsToClipboard);
  refreshButton.addEventListener("click", () => {
    fetchLogs();
    fetchConfig();
    checkServiceWorkerStatus();
  });

  autoRefreshCheckbox.addEventListener("change", (e) => {
    autoRefresh = (e.target as HTMLInputElement).checked;
    if (autoRefresh) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  selectAllCheckbox.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) {
      selectedLogIds = new Set(logs.map((log) => log.id));
    } else {
      selectedLogIds.clear();
    }

    // Update visible checkboxes without losing scroll position
    const checkboxes = logsContainer.querySelectorAll<HTMLInputElement>("input[data-log-id]");
    checkboxes.forEach((cb) => {
      cb.checked = checked;
    });

    updateSelectionUI();
  });

  // Initial load
  fetchConfig();
  fetchLogs();
  checkServiceWorkerStatus();
  updateContextFilter();
  startAutoRefresh();
}

/**
 * Update context filter options
 */
async function updateContextFilter(): Promise<void> {
  try {
    const response = await sendMessage({ action: "getLogs" });
    if (response.success && "logs" in response) {
      const allLogs = response.logs as LogEntry[];
      const contexts = new Set(allLogs.map((log) => log.context));
      const sorted = Array.from(contexts).sort();

      // Clear existing options except "All"
      contextFilter.innerHTML = '<option value="all">All</option>';

      // Add context options
      for (const context of sorted) {
        const option = document.createElement("option");
        option.value = context;
        option.textContent = context;
        contextFilter.appendChild(option);
      }
    }
  } catch (err) {
    console.error("[LogsViewer] Failed to update context filter:", err);
  }
}

/**
 * Start auto-refresh
 */
function startAutoRefresh(): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(() => {
    if (autoRefresh) {
      fetchLogs();
      checkServiceWorkerStatus();
    }
  }, 2000);
}

/**
 * Keep selection limited to currently loaded logs
 */
function pruneSelection(): void {
  if (selectedLogIds.size === 0) return;
  const availableIds = new Set(logs.map((log) => log.id));
  for (const id of Array.from(selectedLogIds)) {
    if (!availableIds.has(id)) {
      selectedLogIds.delete(id);
    }
  }
}

/**
 * Determine which logs should be used for copy actions
 */
function getLogsForCopy(): LogEntry[] {
  if (selectedLogIds.size === 0) {
    return logs;
  }
  return logs.filter((log) => selectedLogIds.has(log.id));
}

/**
 * Update selection-related UI affordances
 */
function updateSelectionUI(): void {
  if (!selectAllCheckbox || !selectedCount || !copyButton) return;

  const total = logs.length;
  const selected = selectedLogIds.size;

  selectAllCheckbox.checked = selected > 0 && selected === total;
  selectAllCheckbox.indeterminate = selected > 0 && selected < total;
  selectedCount.textContent = selected.toString();
  copyButton.textContent = selected > 0 ? `Copy Selected (${selected})` : "Copy Logs";
  copyButton.title = selected > 0 ? `Copy ${selected} selected log(s)` : "Copy all logs";
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeUI);
} else {
  initializeUI();
}
