// AI Studio Data Models

export interface AIStudioFileInfo {
  url: string;
  name?: string;
  type?: string;
}

export interface AIStudioCodeBlock {
  language?: string;
  code: string;
}

export interface AIStudioMessage {
  role: "user" | "assistant";
  content: string; // Main text content
  codeBlocks?: AIStudioCodeBlock[];
  files: AIStudioFileInfo[];
  timestamp: string; // ISO 8601
  thinking?: string; // Internal reasoning if available
}

export interface AIStudioConversationData {
  platform: "aistudio";
  url: string;
  conversationId: string;
  title: string;
  modelName?: string;
  systemInstructions?: string;
  messages: AIStudioMessage[];
  extractedAt: string;
}
