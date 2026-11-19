import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTranscript } from "../src/providers/claude/model";
import { convertClaudeTranscriptToHaevn } from "../src/providers/claude/transformer";
import type {
  QwenChatData,
  QwenContentListItem,
  QwenFile,
  QwenMessage,
} from "../src/providers/qwen/model";
import { transformQwenToHaevn } from "../src/providers/qwen/transformer";
import { processExternalAssets, type UrlAsset } from "../src/utils/media_utils";

// HVN-97: a file is downloaded only when the transformer keeps it. A file downloaded and then
// dropped sits in OPFS, referenced by nothing, until the sweep removes it. The download is mocked
// here, so each test reads what the transformer asked to download, per message.

vi.mock("../src/utils/media_utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/media_utils")>();
  return {
    ...actual,
    // Stands in for the download: each asset becomes an image-url of its own address.
    processExternalAssets: vi.fn(async (assets: UrlAsset[]) =>
      assets.map((asset) => ({ kind: "image-url", url: asset.url })),
    ),
  };
});

beforeEach(() => {
  vi.mocked(processExternalAssets).mockClear();
});

/** The asset URLs the transformer asked to download for one message, in order. */
function downloadedFor(messageId: string): string[] {
  return vi
    .mocked(processExternalAssets)
    .mock.calls.filter(([, options]) => options.messageId === messageId)
    .flatMap(([assets]) => assets.map((asset) => asset.url));
}

describe("Claude downloads the files of the messages it keeps (HVN-97)", () => {
  it("downloads a user message's files, and not an assistant message's", async () => {
    const transcript = {
      uuid: "chat-c1",
      name: "A chat",
      created_at: "2024-01-01T11:00:00Z",
      updated_at: "2024-01-01T12:00:00Z",
      current_leaf_message_uuid: "a1",
      chat_messages: [
        {
          uuid: "u1",
          text: "look at this",
          sender: "human",
          created_at: "2024-01-01T11:59:00Z",
          updated_at: "2024-01-01T11:59:00Z",
          attachments: [],
          files_v2: [
            {
              file_uuid: "f1",
              file_name: "photo.png",
              file_kind: "image",
              preview_url: "/api/files/f1/preview",
            },
          ],
        },
        {
          uuid: "a1",
          text: "here is a picture",
          sender: "assistant",
          created_at: "2024-01-01T12:00:00Z",
          updated_at: "2024-01-01T12:00:00Z",
          attachments: [],
          files: [
            {
              file_uuid: "f2",
              file_name: "generated.png",
              file_kind: "image",
              preview_url: "/api/files/f2/preview",
            },
          ],
        },
      ],
    } as unknown as ChatTranscript;

    const chat = await convertClaudeTranscriptToHaevn(transcript);

    expect(downloadedFor("u1")).toEqual(["https://claude.ai/api/files/f1/preview"]);
    expect(downloadedFor("a1")).toEqual([]);
    // The user's request keeps its file, so the download is not wasted.
    const request = chat.messages.u1.message[0] as unknown as {
      parts: Array<{ content: unknown }>;
    };
    expect(request.parts[0].content).toContainEqual({
      kind: "image-url",
      url: "https://claude.ai/api/files/f1/preview",
    });
  });
});

describe("Qwen downloads the assets of the messages it keeps (HVN-97)", () => {
  function message(overrides: Partial<QwenMessage>): QwenMessage {
    return {
      id: "m1",
      role: "assistant",
      content: "",
      chat_type: "t2i",
      parentId: null,
      childrenIds: [],
      timestamp: 1_700_000_000,
      ...overrides,
    };
  }

  function file(name: string, url: string): QwenFile {
    return { id: name, name, url, file_type: "image/png", type: "image", size: 1 } as QwenFile;
  }

  function generated(content: string): QwenContentListItem {
    return { phase: "image_gen", content };
  }

  function chatData(messages: QwenMessage[]): QwenChatData {
    return {
      id: "chat-q1",
      user_id: "user-1",
      title: "A chat",
      chat: {
        history: {
          messages: Object.fromEntries(messages.map((m) => [m.id, m])),
          currentId: messages[messages.length - 1].id,
          currentResponseIds: [],
        },
        models: ["qwen3-max"],
        messages,
      },
      created_at: 1_700_000_000,
      updated_at: 1_700_000_100,
      chat_type: "t2i",
    };
  }

  it("downloads a user message's files only", async () => {
    await transformQwenToHaevn(
      chatData([
        message({
          id: "u1",
          role: "user",
          content: "draw a cat",
          files: [file("ref.png", "https://qwen.example/ref.png")],
        }),
      ]),
    );

    expect(downloadedFor("u1")).toEqual(["https://qwen.example/ref.png"]);
  });

  it("downloads an assistant message's generated images, not its files", async () => {
    await transformQwenToHaevn(
      chatData([
        message({ id: "u1", role: "user", content: "draw two cats", parentId: null }),
        message({
          id: "a1",
          role: "assistant",
          parentId: "u1",
          content: "",
          files: [file("attached.pdf", "https://qwen.example/attached.pdf")],
          content_list: [
            generated("https://qwen.example/gen-1.png"),
            { phase: "answer", content: "two cats" },
            generated("https://qwen.example/gen-2.png"),
          ],
        }),
      ]),
    );

    expect(downloadedFor("a1")).toEqual([
      "https://qwen.example/gen-1.png",
      "https://qwen.example/gen-2.png",
    ]);
  });

  it("gives each generated image its own download, when the message also has files", async () => {
    // The n-th generated image takes the n-th downloaded asset. A file in front of the images
    // used to shift every image one place, so the first image showed the attached file.
    const chat = await transformQwenToHaevn(
      chatData([
        message({
          id: "a1",
          role: "assistant",
          files: [file("attached.pdf", "https://qwen.example/attached.pdf")],
          content_list: [
            generated("https://qwen.example/gen-1.png"),
            generated("https://qwen.example/gen-2.png"),
          ],
        }),
      ]),
    );

    const images = (
      chat.messages.a1.message[0] as unknown as {
        parts: Array<{ part_kind: string; content: { url?: string } }>;
      }
    ).parts
      .filter((part) => part.part_kind === "image-response")
      .map((part) => part.content.url);
    expect(images).toEqual(["https://qwen.example/gen-1.png", "https://qwen.example/gen-2.png"]);
  });

  it("downloads nothing for a user message's generated-image items, which it never shows", async () => {
    await transformQwenToHaevn(
      chatData([
        message({
          id: "u1",
          role: "user",
          content: "hi",
          content_list: [generated("https://qwen.example/stray.png")],
        }),
      ]),
    );

    expect(downloadedFor("u1")).toEqual([]);
  });
});
