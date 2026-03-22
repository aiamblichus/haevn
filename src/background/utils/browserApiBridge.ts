// Browser API Bridge - CRD-003
// Service worker acts as a lightweight bridge, handling all browser API calls
// on behalf of workers and offscreen documents.
//
// Message Flow Pattern:
//   Worker/Offscreen → Service Worker → Browser API → Service Worker → Worker/Offscreen
//
// Request/Response Pattern:
//   1. Worker sends request with unique requestId
//   2. Service worker executes browser API call
//   3. Service worker sends response back with matching requestId
//
// This pattern ensures:
//   - Clear separation of concerns
//   - Workers stay focused on processing
//   - Service worker remains lightweight
//   - Easy to test and maintain

/**
 * Types for browser API bridge messages
 */
export interface BrowserApiRequest {
  type: "requestBrowserAPI";
  requestId: string;
  api: "downloads" | "storage" | "tabs" | "scripting" | "runtime";
  operation: string;
  params: unknown;
}

export interface BrowserApiResponse {
  type: "browserApiResponse";
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Handle browser API requests from workers/offscreen documents
 * This implements the request/response pattern from CRD-003
 */
export async function handleBrowserApiRequest(
  message: BrowserApiRequest,
  worker: Worker | null,
): Promise<void> {
  const { requestId, api, operation, params } = message;

  try {
    let result: unknown;

    switch (api) {
      case "downloads": {
        result = await handleDownloadsApi(operation, params);
        break;
      }

      case "storage": {
        result = await handleStorageApi(operation, params);
        break;
      }

      case "tabs": {
        result = await handleTabsApi(operation, params);
        break;
      }

      case "scripting": {
        result = await handleScriptingApi(operation, params);
        break;
      }

      case "runtime": {
        result = await handleRuntimeApi(operation, params);
        break;
      }

      default: {
        throw new Error(`Unsupported API: ${api}`);
      }
    }

    // Send success response back to worker
    if (worker) {
      worker.postMessage({
        type: "browserApiResponse",
        requestId,
        success: true,
        result,
      } as BrowserApiResponse);
    }
  } catch (error) {
    // Send error response back to worker
    if (worker) {
      worker.postMessage({
        type: "browserApiResponse",
        requestId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      } as BrowserApiResponse);
    }
  }
}

/**
 * Handle downloads API operations
 */
async function handleDownloadsApi(operation: string, params: unknown): Promise<unknown> {
  switch (operation) {
    case "download": {
      const downloadParams = params as {
        url: string;
        filename: string;
        saveAs?: boolean;
      };

      return new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: downloadParams.url,
            filename: downloadParams.filename,
            saveAs: downloadParams.saveAs ?? false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve({ downloadId });
            }
          },
        );
      });
    }

    default: {
      throw new Error(`Unsupported downloads operation: ${operation}`);
    }
  }
}

/**
 * Handle storage API operations
 */
async function handleStorageApi(operation: string, params: unknown): Promise<unknown> {
  switch (operation) {
    case "get": {
      const getParams = params as {
        area?: "sync" | "local" | "managed";
        keys: string | string[] | Record<string, unknown> | null;
      };
      const area = getParams.area || "sync";
      return new Promise((resolve, reject) => {
        chrome.storage[area].get(getParams.keys, (result: unknown) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
    }

    case "set": {
      const setParams = params as {
        area?: "sync" | "local" | "managed";
        items: Record<string, unknown>;
      };
      const area = setParams.area || "sync";
      return new Promise((resolve, reject) => {
        chrome.storage[area].set(setParams.items, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ success: true });
          }
        });
      });
    }

    case "remove": {
      const removeParams = params as {
        area?: "sync" | "local" | "managed";
        keys: string | string[];
      };
      const area = removeParams.area || "sync";
      return new Promise((resolve, reject) => {
        chrome.storage[area].remove(removeParams.keys, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ success: true });
          }
        });
      });
    }

    default: {
      throw new Error(`Unsupported storage operation: ${operation}`);
    }
  }
}

/**
 * Handle tabs API operations
 */
async function handleTabsApi(operation: string, params: unknown): Promise<unknown> {
  switch (operation) {
    case "get": {
      const getParams = params as { tabId: number };
      return chrome.tabs.get(getParams.tabId);
    }

    case "create": {
      const createParams = params as {
        createProperties: chrome.tabs.CreateProperties;
      };
      return chrome.tabs.create(createParams.createProperties);
    }

    case "update": {
      const updateParams = params as {
        tabId: number;
        updateProperties: chrome.tabs.UpdateProperties;
      };
      return chrome.tabs.update(updateParams.tabId, updateParams.updateProperties);
    }

    case "remove": {
      const removeParams = params as { tabIds: number | number[] };
      if (Array.isArray(removeParams.tabIds)) {
        return chrome.tabs.remove(removeParams.tabIds);
      } else {
        return chrome.tabs.remove(removeParams.tabIds);
      }
    }

    case "query": {
      const queryParams = params as {
        queryInfo: chrome.tabs.QueryInfo;
      };
      return chrome.tabs.query(queryParams.queryInfo);
    }

    case "sendMessage": {
      const sendParams = params as {
        tabId: number;
        message: unknown;
      };
      return chrome.tabs.sendMessage(sendParams.tabId, sendParams.message);
    }

    default: {
      throw new Error(`Unsupported tabs operation: ${operation}`);
    }
  }
}

/**
 * Handle scripting API operations
 */
async function handleScriptingApi(operation: string, params: unknown): Promise<unknown> {
  switch (operation) {
    case "executeScript": {
      const scriptParams = params as {
        injection: chrome.scripting.ScriptInjection<unknown[], unknown>;
      };
      return chrome.scripting.executeScript(scriptParams.injection);
    }

    default: {
      throw new Error(`Unsupported scripting operation: ${operation}`);
    }
  }
}

/**
 * Handle runtime API operations
 */
async function handleRuntimeApi(operation: string, params: unknown): Promise<unknown> {
  switch (operation) {
    case "getURL": {
      const urlParams = params as { path: string };
      return chrome.runtime.getURL(urlParams.path);
    }

    case "sendMessage": {
      const sendParams = params as { message: unknown };
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(sendParams.message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    }

    default: {
      throw new Error(`Unsupported runtime operation: ${operation}`);
    }
  }
}
