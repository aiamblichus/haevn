export interface Chat extends Node {
  id: string;
  chatId: number;
  chatCode: string;
  title: string | null;
  lastInteractionTime: number;
  defaultBotObject: Bot | null;
  owner: Owner;
  membersCount: number;
  userMembersConnection: UserMembersConnection;
  viewerHasMutedChat: boolean;
  viewerHasPinnedChat: boolean;
  lastMessage: Message | null;
}

interface Node {
  id: string;
}

export interface Bot extends Node {
  botId: number;
  id: string;
  deletionState: "not_deleted" | string;
  displayName: string;
  picture: BotPicture | null;
  smallPicture: BotPicture | null;
  // Additional properties found in specific Bot responses:
  handle?: string;
  introduction?: string;
  nickname?: string;
  promptPlaintext?: string;
  model?: string;
  creator?: Owner;
  description?: string;
  poweredBy?: string;
}

export interface BotPicture {
  url: string;
}

interface Owner {
  uid: number;
  id: string;
}

interface UserMembersConnection {
  edges: UserMemberEdge[];
}

interface UserMemberEdge {
  node: PoeUser;
  id: string;
}

export interface PoeUser extends Node {
  uid: number;
  id: string;
  smallProfilePhotoUrl: string;
  fullName: string;
  // Additional properties found in specific PoeUser references:
  handle?: string;
  viewerIsFollowing?: boolean;
  isDeleted?: boolean;
}

export interface Message extends Node {
  author: "human" | "chat_break" | string;
  isChatAnnouncement: boolean;
  id: string;
  bot: Bot | null;
  messageId: number;
  creationTime: number;
  text: string;
  state: "complete" | string;
  messageCode: string;
  parameters: unknown;
  contentType: string;
  sourceType: string;
  messageStateText: string | null;
  isEdited: boolean;
  attachments: Attachment[];
  command: unknown;
  referencedMessageV2: Message | null;
  usersCanEdit: Owner[];
  isDeleted: boolean;
  hasCitations: boolean;
  messageSource?: MessageSource;
}

export interface Attachment {
  isInline: boolean;
  file: FileInfo;
  id: string;
  name?: string;
  url?: string;
  attachmentId?: number;
}

export interface FileInfo {
  mimeType: string;
  id: string;
  url: string;
  size: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string | null;
}

export interface HistoryPageInfo {
  endCursor: string;
  hasNextPage: boolean;
}

export interface ChatPageInfo {
  startCursor: string;
  hasPreviousPage: boolean;
}

export interface MessageSource {
  sourceType: "repeat_followup" | "upscale" | "animate" | "chat_input";
  metadata: string; // JSON string that may not be fully parsed here
}

export interface ChatEdges {
  node: Chat;
  cursor: string;
  id: string;
}

export interface ChatList extends Node {
  edges: ChatEdges[];
  pageInfo: HistoryPageInfo;
  id: string;
  __typename: "ChatConnection";
}

export interface ChatData extends Node {
  edges: ChatEdges[];
  pageInfo: HistoryPageInfo;
  id: string;
}

export interface ChatOfCode extends Node {
  id: string;
  isDeleted: boolean;
  title: string | null;
  chatId: number;
  hasMultipleUsers: boolean;
  defaultBotObject: Bot | null;
  chatNonce: string | null;
  chatCode: string;
  creationTime: number;
  lastMessage: Message | null;
  messagesConnection: MessagesConnection;
}

export interface MessagesConnection {
  edges: MessageEdge[];
  pageInfo: ChatPageInfo;
  id: string;
}

export interface MessageEdge {
  node: Message;
  id: string;
  cursor: string;
}

// ============================================================================
// Root query types
// ============================================================================

export interface Query<TVariables> {
  queryName: string;
  variables: TVariables;
  extensions: {
    hash: string;
  };
}

// HASHES

const HASHES = {
  chatsHistoryPageQuery: "7c5072a3c0a8bfc272f3606e24809ba1080d5fdc80c9fe9f535b6edc4378b565",
  chatHistoryListWithSearchPaginationQuery:
    "016db36793c2af755e6a29f2f2bc393f9b7d8d6c621ee7109361db9f5bae285f",
  chatListPaginationQuery: "5c894ac9b3b851de6600998326db3edc692182d8110cd59d8d0a80f5bf128a3d",
  chatPageQuery: "04b99c21530109236868886cf465da6e255e6a5a77ae60fd58d4e7553f20a556",
  chatLastMessageAreaQuery: "3be41870263dd0f7fd431b7645322c6275142d2d4e9bc190c7ae8e075595fe45",
};

// ============================================================================
// Use this query to get the initial chat list for the user
// The response will contain the chat list for the user and the cursor for the last chat, which is used to fetch the rest of the chats using chatHistoryListWithSearchPaginationQuery

export function chatsHistoryPageQuery(): Query<{ handle: string; useBot: boolean }> {
  return {
    queryName: "chatsHistoryPageQuery",
    variables: { handle: "", useBot: false },
    extensions: {
      hash: HASHES.chatsHistoryPageQuery,
    },
  };
}

export interface ChatsHistoryPageResponse {
  chats: ChatList;
}

// ============================================================================
// Use this query to get the chat list for the user

export function chatHistoryListWithSearchPaginationQuery(
  count: number,
  cursor: string | null,
): Query<{ count: number; cursor: string | null }> {
  return {
    queryName: "ChatHistoryListWithSearchPaginationQuery",
    variables: { count, cursor: cursor || null },
    extensions: {
      hash: HASHES.chatHistoryListWithSearchPaginationQuery,
    },
  };
}

export interface ChatHistoryListWithSearchPaginationResponse {
  chats: ChatList;
}

// ============================================================================
// Use this query to get the messages for a specific chat using the internal chat ID
// The response will contain the messages for the chat and the cursor for the last message, which is used to fetch the rest of the messages for the chat using this query again

export function chatListPaginationQuery(
  count: number,
  cursor: string,
  id: string,
): Query<{ count: number; cursor: string; id: string }> {
  return {
    queryName: "ChatListPaginationQuery",
    variables: { count, cursor, id },
    extensions: {
      hash: HASHES.chatListPaginationQuery,
    },
  };
}

export interface ChatListPaginationResponse {
  node: {
    messagesConnection: MessagesConnection;
  };
  id: string;
}

// ============================================================================
// Use this query to get the chat data for a specific chat code (corresponds to the slug in the URL)
// The response will contain the internal chat ID and the cursor for the last message, which is used to fetch the previous messages for the chat using chatListPaginationQuery

export function chatPageQuery(chatCode: string): Query<{ chatCode: string }> {
  return {
    queryName: "ChatPageQuery",
    variables: { chatCode },
    extensions: {
      hash: HASHES.chatPageQuery,
    },
  };
}

export interface ChatPageResponse {
  chatOfCode: ChatOfCode;
}

// ============================================================================

export function chatLastMessageAreaQuery(
  messageNodeId: string,
  chatNodeId: string,
): Query<{ messageNodeId: string; chatNodeId: string }> {
  return {
    queryName: "ChatLastMessageAreaQuery",
    variables: { messageNodeId, chatNodeId },
    extensions: {
      hash: HASHES.chatLastMessageAreaQuery,
    },
  };
}

export interface ChatLastMessageAreaResponse {
  messageNode: Message;
  chatNode: Chat;
}

export interface PoeConversationData {
  chatId: string;
  chatCode: string;
  title: string;
  botName: string;
  messages: Message[];
  extractedAt: string;
  systemPrompt?: string;
}
