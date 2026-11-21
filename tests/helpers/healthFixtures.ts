/**
 * Raw payloads in the shape each web provider's extractor hands its transformer, small and
 * plausible, for the provider health tests. They are synthetic: no site was asked. Each takes a
 * `tag` so a test can plant a sentinel in the id, the title and the text and look for it again.
 */

const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

export interface Sentinels {
  id: string;
  title: string;
  user: string;
  model: string;
}

export function sentinels(tag: string): Sentinels {
  return {
    id: `ID-${tag}-0123456789abcdef`,
    title: `TITLE-${tag}`,
    user: `USER-TEXT-${tag}`,
    model: `MODEL-TEXT-${tag}`,
  };
}

export function claudeRaw(s: Sentinels, extra: { files?: unknown[] } = {}) {
  return {
    uuid: s.id,
    name: s.title,
    summary: "",
    created_at: iso(0),
    updated_at: iso(10),
    settings: {},
    is_starred: false,
    is_temporary: false,
    current_leaf_message_uuid: `${s.id}-a`,
    chat_messages: [
      {
        uuid: `${s.id}-u`,
        text: s.user,
        sender: "human",
        created_at: iso(1),
        updated_at: iso(1),
        attachments: [],
        files: [],
        files_v2: extra.files ?? [],
        parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      },
      {
        uuid: `${s.id}-a`,
        text: s.model,
        sender: "assistant",
        created_at: iso(5),
        updated_at: iso(5),
        attachments: [],
        files: [],
        files_v2: [],
        parent_message_uuid: `${s.id}-u`,
        stop_reason: "stop_sequence",
      },
    ],
  };
}

export function geminiRaw(s: Sentinels, extra: { files?: unknown[] } = {}) {
  return {
    platform: "gemini",
    url: `https://gemini.google.com/app/${s.id}`,
    conversationId: s.id,
    title: s.title,
    messageCount: 2,
    extractedAt: iso(20),
    messages: [
      {
        index: 1,
        content: s.user,
        timestamp: iso(1),
        localTime: "x",
        role: "user",
        files: extra.files ?? [],
      },
      {
        index: 2,
        content: s.model,
        timestamp: iso(5),
        localTime: "x",
        role: "assistant",
        files: [],
      },
    ],
  };
}

export function aistudioRaw(s: Sentinels, extra: { files?: unknown[] } = {}) {
  return {
    platform: "aistudio",
    url: `https://aistudio.google.com/prompts/${s.id}`,
    conversationId: s.id,
    title: s.title,
    modelName: "gemini-2.5-pro",
    messages: [
      { role: "user", content: s.user, files: extra.files ?? [], timestamp: iso(1) },
      { role: "assistant", content: s.model, files: [], timestamp: iso(5) },
    ],
    extractedAt: iso(20),
  };
}

export function deepseekRaw(s: Sentinels) {
  return {
    sourceId: s.id,
    title: s.title,
    url: `https://chat.deepseek.com/a/chat/s/${s.id}`,
    extractedAt: iso(20),
    messages: [
      { role: "user", content: s.user },
      { role: "assistant", content: s.model },
    ],
  };
}

export function openwebuiRaw(s: Sentinels) {
  return {
    chat: {
      id: s.id,
      user_id: "u",
      title: s.title,
      updated_at: Math.floor(T0 / 1000) + 10,
      created_at: Math.floor(T0 / 1000),
      archived: false,
      chat: {
        models: ["llama3"],
        history: {
          messages: {
            m1: { id: "m1", role: "user", content: s.user, timestamp: Math.floor(T0 / 1000) + 1 },
            m2: {
              id: "m2",
              role: "assistant",
              content: s.model,
              parentId: "m1",
              model: "llama3",
              timestamp: Math.floor(T0 / 1000) + 5,
            },
          },
          currentId: "m2",
        },
      },
    },
  };
}

export function qwenRaw(s: Sentinels, extra: { files?: unknown[] } = {}) {
  const seconds = Math.floor(T0 / 1000);
  return {
    id: s.id,
    user_id: "u",
    title: s.title,
    chat: {
      history: {
        messages: {
          m1: {
            id: "m1",
            role: "user",
            content: s.user,
            chat_type: "t2t",
            parentId: null,
            childrenIds: ["m2"],
            timestamp: seconds + 1,
            files: extra.files ?? [],
          },
          m2: {
            id: "m2",
            role: "assistant",
            content: s.model,
            chat_type: "t2t",
            parentId: "m1",
            childrenIds: [],
            timestamp: seconds + 5,
          },
        },
        currentId: "m2",
        currentResponseIds: [],
      },
      models: ["qwen3-max"],
      messages: [],
    },
    created_at: seconds,
    updated_at: seconds + 10,
    chat_type: "t2t",
  };
}

export function grokRaw(s: Sentinels, extra: { attachments?: unknown[] } = {}) {
  const response = (id: string, sender: "human" | "assistant", message: string, at: number) => ({
    responseId: id,
    message,
    sender,
    createTime: iso(at),
    manual: false,
    partial: false,
    shared: false,
    query: "",
    queryType: "",
    webSearchResults: [],
    xpostIds: [],
    xposts: [],
    generatedImageUrls: [],
    imageAttachments: [],
    fileAttachments: [],
    cardAttachmentsJson: [],
    fileUris: [],
    fileAttachmentsMetadata: sender === "human" ? (extra.attachments ?? []) : [],
    isControl: false,
    steps: [],
    imageEditUris: [],
    mediaTypes: [],
    webpageUrls: [],
    metadata: {},
    citedWebSearchResults: [],
    toolResponses: [],
    model: "grok-4",
  });
  return {
    conversation: {
      conversationId: s.id,
      title: s.title,
      starred: false,
      createTime: iso(0),
      modifyTime: iso(10),
      systemPromptName: "",
      temporary: false,
      mediaTypes: [],
      workspaces: [],
      taskResult: {},
    },
    responseNodes: [
      { responseId: `${s.id}-u`, sender: "human" },
      { responseId: `${s.id}-a`, sender: "assistant", parentResponseId: `${s.id}-u` },
    ],
    responses: [
      response(`${s.id}-u`, "human", s.user, 1),
      response(`${s.id}-a`, "assistant", s.model, 5),
    ],
  };
}

/**
 * `image` puts one image in the user's message, as a web sync extracts it: a pointer in the
 * conversation and a reference to download it from (HVN-123).
 */
export function chatgptRaw(s: Sentinels, extra: { image?: { pointer: string; url: string } } = {}) {
  const seconds = T0 / 1000;
  const message = (id: string, role: string, text: string, at: number) => ({
    id,
    author: { role },
    create_time: seconds + at,
    update_time: seconds + at,
    content: { content_type: "text", parts: [text] },
    status: "finished_successfully",
    end_turn: true,
    weight: 1,
    metadata: { model_slug: "gpt-5" },
    recipient: "all",
    channel: null,
  });
  return {
    conversation: {
      id: s.id,
      conversation_id: s.id,
      title: s.title,
      create_time: seconds,
      update_time: seconds + 10,
      current_node: "n2",
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["n1"] },
        n1: {
          id: "n1",
          message: extra.image
            ? {
                ...message("n1", "user", s.user, 1),
                content: {
                  content_type: "multimodal_text",
                  parts: [
                    {
                      content_type: "image_asset_pointer",
                      asset_pointer: extra.image.pointer,
                      size_bytes: 10,
                      width: 1,
                      height: 1,
                    },
                    s.user,
                  ],
                },
              }
            : message("n1", "user", s.user, 1),
          parent: "root",
          children: ["n2"],
        },
        n2: {
          id: "n2",
          message: message("n2", "assistant", s.model, 5),
          parent: "n1",
          children: [],
        },
      },
      moderation_results: [],
      is_archived: false,
      is_starred: null,
      is_do_not_remember: null,
      safe_urls: [],
      blocked_urls: [],
    },
    assets: {},
    ...(extra.image
      ? {
          assetRefs: {
            [extra.image.pointer]: {
              downloadUrl: extra.image.url,
              contentType: "image/png",
              filename: "a.png",
            },
          },
        }
      : {}),
  };
}

/**
 * A Poe message, as the GraphQL API returns it (creationTime in microseconds). A user turn carries
 * `authorUser` and no `bot`; a bot turn the reverse. There is no `author` field (HVN-112).
 */
export function poeMessage(
  id: string,
  role: "user" | "bot",
  text: string,
  at: number,
  attachments: unknown[] = [],
) {
  const creationTime = (T0 + at * 1000) * 1000;
  return {
    id: `msg-${id}`,
    messageId: creationTime,
    messageCode: `code-${id}`,
    authorUser:
      role === "user"
        ? { uid: 1001, id: "user-1001", fullName: "Synthetic User", handle: "synthetic-user" }
        : null,
    bot:
      role === "user"
        ? null
        : {
            botId: 456,
            id: "bot-456",
            displayName: "TestBot",
            deletionState: "not_deleted",
            picture: null,
            smallPicture: null,
          },
    text,
    contentType: "text_markdown",
    sourceType: "chat_input",
    state: "complete",
    creationTime,
    isEdited: false,
    isDeleted: false,
    isChatAnnouncement: false,
    hasCitations: false,
    attachments,
    referencedMessageV2: null,
    usersCanEdit: [],
    messageStateText: null,
    parameters: null,
    command: null,
  };
}

export function poeRaw(s: Sentinels, extra: { attachments?: unknown[] } = {}) {
  return {
    chatId: "Q2hhdDoxMjM=",
    chatCode: s.id,
    title: s.title,
    botName: "Claude-in-Poe",
    extractedAt: iso(20),
    messages: [
      poeMessage("1", "user", s.user, 1000, extra.attachments),
      poeMessage("2", "bot", s.model, 5000),
    ],
  };
}

/** One healthy raw payload per web provider, by provider name. */
export const RAW_BY_PROVIDER: Record<string, (s: Sentinels) => unknown> = {
  claude: claudeRaw,
  chatgpt: chatgptRaw,
  gemini: geminiRaw,
  poe: poeRaw,
  openwebui: openwebuiRaw,
  qwen: qwenRaw,
  deepseek: deepseekRaw,
  aistudio: aistudioRaw,
  grok: grokRaw,
};
