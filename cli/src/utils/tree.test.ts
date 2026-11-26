import { describe, expect, it } from "vitest";
import { buildChat, buildForkedChat, LONG_OPENING } from "../testing/fixtures";
import type { BinaryContent, ChatMessage, ModelResponsePart, UserPromptPart } from "../types/chat";
import {
  getAllBranches,
  getBranchContainingMessage,
  getMessageText,
  getPrimaryBranch,
} from "./tree";

describe("getAllBranches", () => {
  it("lists one branch per leaf, and marks the one that holds currentId as primary", () => {
    const branches = getAllBranches(buildForkedChat());
    const byLeaf = new Map(branches.map((b) => [b.leafMessageId, b] as const));

    expect([...byLeaf.keys()].sort()).toEqual(["a3", "a5"]);
    expect(byLeaf.get("a3")).toMatchObject({
      path: ["u0", "a1", "u2", "a3"],
      messageCount: 4,
      isPrimary: true,
    });
    expect(byLeaf.get("a5")).toMatchObject({
      path: ["u0", "a1", "u4", "a5"],
      messageCount: 4,
      isPrimary: false,
    });
  });

  it("gives each branch its first prompt, cut to 60 characters", () => {
    const branch = getAllBranches(buildForkedChat()).find((b) => b.leafMessageId === "a3");

    expect(branch?.firstPrompt).toBe(LONG_OPENING.slice(0, 60));
    expect(branch?.firstPrompt).toHaveLength(60);
  });
});

describe("branch lookup", () => {
  it("finds the primary branch from currentId, and the branch through a given message", () => {
    const chat = buildForkedChat();

    expect(getPrimaryBranch(chat)).toEqual(["u0", "a1", "u2", "a3"]);
    expect(getBranchContainingMessage(chat, "u4")).toEqual(["u0", "a1", "u4"]);
    expect(getBranchContainingMessage(chat, "missing")).toEqual([]);
  });
});

describe("getMessageText", () => {
  const thinking = `${"chain of thought ".repeat(20)}TAIL`;
  const chat = buildChat([
    { id: "u1", parentId: null, role: "user", text: "question" },
    { id: "a1", parentId: "u1", role: "assistant", text: "answer", thinking },
  ]);

  it("shows thinking as a 100-character preview unless asked for it in full", () => {
    const message = chat.messages.a1;

    expect(getMessageText(message)).toBe(`[thinking: ${thinking.slice(0, 100)}...]\n\nanswer`);
    expect(getMessageText(message, { includeThinking: true })).toBe(`${thinking}\n\nanswer`);
  });
});

const TIME = "2026-01-01T00:00:00.000Z";
const IMAGE: BinaryContent = { kind: "binary", data: "", media_type: "image/png" };

/** A stored assistant message whose parts the test states. */
function reply(parts: ModelResponsePart[]): ChatMessage {
  return {
    id: "a1",
    chatId: "chat-1",
    childrenIds: [],
    model: "fixture-model",
    done: true,
    message: [{ kind: "response", parts, timestamp: TIME }],
  };
}

/** A stored user message whose prompt content the test states. */
function prompt(content: UserPromptPart["content"]): ChatMessage {
  return {
    id: "u1",
    chatId: "chat-1",
    childrenIds: [],
    model: "fixture-model",
    done: true,
    message: [{ kind: "request", parts: [{ part_kind: "user-prompt", content, timestamp: TIME }] }],
  };
}

describe("getMessageText with media", () => {
  it("gives the string items of a prompt's list, then a stand-in for each attachment", () => {
    const message = prompt(["Compare these two", IMAGE, "in one line"]);

    expect(getMessageText(message)).toBe("Compare these two\n\nin one line\n\n[image]");
  });

  it("names an attachment by its kind, or by the media type of its bytes", () => {
    const message = prompt([
      { kind: "image-url", url: "" },
      { kind: "binary", data: "", media_type: "video/mp4" },
      { kind: "binary", data: "", media_type: "application/pdf" },
      { kind: "audio-url", url: "" },
      { kind: "document-url", url: "" },
    ]);

    expect(getMessageText(message)).toBe("[image]\n\n[video]\n\n[file]\n\n[audio]\n\n[file]");
  });

  it("shows an image-only reply as [image], where it was blank before", () => {
    const message = reply([
      { part_kind: "text", content: "" },
      { part_kind: "image-response", content: IMAGE },
    ]);

    expect(getMessageText(message)).toBe("[image]");
  });

  it("shows the text of a reply with an image, then the stand-in, whatever the part order", () => {
    const textFirst = reply([
      { part_kind: "text", content: "Here it is." },
      { part_kind: "image-response", content: IMAGE },
    ]);
    const imageFirst = reply([
      { part_kind: "image-response", content: IMAGE },
      { part_kind: "text", content: "Here it is." },
    ]);

    expect(getMessageText(textFirst)).toBe("Here it is.\n\n[image]");
    expect(getMessageText(imageFirst)).toBe("Here it is.\n\n[image]");
  });

  it("gives each media part its own stand-in, in part order", () => {
    const message = reply([
      { part_kind: "video-response", content: { kind: "video-url", url: "" } },
      { part_kind: "image-response", content: IMAGE },
      { part_kind: "audio-response", content: { kind: "audio-url", url: "" } },
      { part_kind: "document-response", content: { kind: "document-url", url: "" } },
    ]);

    expect(getMessageText(message)).toBe("[video]\n\n[image]\n\n[audio]\n\n[file]");
  });

  it("leaves a genuinely empty message empty", () => {
    expect(getMessageText(reply([{ part_kind: "text", content: "" }]))).toBe("");
    expect(getMessageText(reply([]))).toBe("");
    expect(getMessageText(prompt(""))).toBe("");
  });
});
