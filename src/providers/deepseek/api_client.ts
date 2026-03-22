import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import type { DeepseekApiChatListResponse, DeepseekApiResponse } from "./model";

const DEEPSEEK_API_BASE = "https://chat.deepseek.com";

export class DeepseekApiClient {
  private token: string | null = null;

  /**
   * Get DeepSeek auth token from localStorage
   */
  private getAuthToken(): string {
    if (this.token) return this.token;

    const tokenStr = localStorage.getItem("userToken");
    if (!tokenStr) {
      throw new Error("DeepSeek auth token not found. Please ensure you are logged in.");
    }

    try {
      const tokenObj = JSON.parse(tokenStr) as { value: string; __version?: string };
      if (!tokenObj.value) {
        throw new Error("DeepSeek token value is missing");
      }
      this.token = tokenObj.value;
      return this.token;
    } catch (error) {
      log.error("[DeepSeek] Failed to parse token from localStorage", { error, tokenStr });
      throw new Error("Failed to parse DeepSeek auth token");
    }
  }

  private async fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getAuthToken();
    const url = endpoint.startsWith("http") ? endpoint : `${DEEPSEEK_API_BASE}${endpoint}`;

    const response = await fetchWithTimeout(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
      credentials: "include",
      timeoutMs: 30000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("[DeepSeek] API request failed", {
        status: response.status,
        endpoint,
        errorText,
      });
      throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
    }

    // Type for the raw API response wrapper before we know the specific data type
    interface DeepseekApiWrapper {
      code: number;
      msg?: string;
      data?: {
        biz_code?: number;
        biz_msg?: string;
      };
    }

    const data = (await response.json()) as DeepseekApiWrapper;

    if (data.code !== 0) {
      log.error("[DeepSeek] API returned error code", {
        code: data.code,
        msg: data.msg,
        endpoint,
      });
      throw new Error(`DeepSeek API error: ${data.msg || "Unknown error"} (code: ${data.code})`);
    }

    // Check business logic error if applicable
    if (data.data?.biz_code !== undefined && data.data.biz_code !== 0) {
      log.error("[DeepSeek] Business logic error", {
        biz_code: data.data.biz_code,
        biz_msg: data.data.biz_msg,
        endpoint,
      });
      throw new Error(
        `DeepSeek business error: ${data.data.biz_msg || "Unknown error"} (biz_code: ${data.data.biz_code})`,
      );
    }

    // The actual response data will be cast to the expected type T
    return data as unknown as T;
  }

  /**
   * Fetch all chat IDs via pagination
   */
  async fetchAllChatIds(): Promise<string[]> {
    log.info("[DeepSeek] Fetching all chat IDs via API");
    const allIds = new Set<string>();
    let hasMore = true;
    let cursor: number | null = null;
    let page = 0;

    while (hasMore && page < 50) {
      // 50 pages limit (approx 1500-2500 chats)
      let endpoint = "/api/v0/chat_session/fetch_page?lte_cursor.pinned=false";
      if (cursor !== null) {
        endpoint += `&lte_cursor.updated_at=${cursor}`;
      }

      const data = await this.fetchApi<DeepseekApiChatListResponse>(endpoint);
      const sessions = data.data?.biz_data?.chat_sessions || [];

      if (sessions.length === 0) break;

      for (const s of sessions) {
        if (s.id) allIds.add(s.id);
      }

      hasMore = data.data?.biz_data?.has_more || false;
      cursor = data.data?.biz_data?.lte_cursor || null;
      page++;

      if (!hasMore || !cursor) break;
    }

    log.info(`[DeepSeek] Successfully fetched ${allIds.size} chat IDs`);
    return Array.from(allIds);
  }

  /**
   * Fetch full conversation details
   */
  async fetchConversation(chatSessionId: string): Promise<DeepseekApiResponse> {
    log.info("[DeepSeek] Fetching conversation via API", { chatSessionId });
    const endpoint = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatSessionId)}`;
    return this.fetchApi<DeepseekApiResponse>(endpoint);
  }
}

export const deepseekApi = new DeepseekApiClient();
