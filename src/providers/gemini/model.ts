// Gemini Raw Data Models
// These types represent the raw, untransformed data structure extracted from Gemini's DOM/API

export interface GeminiFileInfo {
  url: string;
  name?: string;
  type?: string;
}

export interface GeminiMessage {
  index: number;
  content: string;
  timestamp: string;
  localTime: string;
  role: "user" | "assistant";
  files: GeminiFileInfo[];
  thinking?: string; // Internal reasoning from model-thoughts
}

export interface GeminiConversationData {
  platform: "gemini";
  url: string;
  conversationId: string;
  title: string;
  messageCount: number;
  messages: GeminiMessage[];
  extractedAt: string;
}
