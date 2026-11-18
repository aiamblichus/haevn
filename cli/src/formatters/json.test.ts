import { describe, expect, it } from "vitest";
import { buildChat } from "../testing/fixtures";
import { resolveMessageRef } from "../utils/messageRefs";
import { formatBranchAsJson, toJsonString } from "./json";

const chat = buildChat(
  [
    { id: "sys", parentId: null, role: "system", text: "Be brief." },
    { id: "u1", parentId: "sys", role: "user", text: "hello" },
    { id: "a1", parentId: "u1", role: "assistant", text: "hi there" },
    { id: "u2", parentId: "a1", role: "user", text: "how are you?" },
    { id: "a2", parentId: "u2", role: "assistant", text: "fine" },
  ],
  { system: "Be brief." },
);
const path = ["sys", "u1", "a1", "u2", "a2"];

interface FormattedBranch {
  chatId: string;
  platform: string;
  system?: string;
  branch: {
    path: string[];
    messageCount: number;
    messages: Array<{ ref: string; role: string; content: string }>;
  };
}

/** The JSON the user reads, after the round trip through a string. */
function parsed(output: object): FormattedBranch {
  return JSON.parse(JSON.stringify(output)) as FormattedBranch;
}

describe("formatBranchAsJson", () => {
  it("lists the branch's messages in order, each with its role and text", () => {
    const out = parsed(formatBranchAsJson(chat, path));

    expect(out.chatId).toBe("chat-1");
    expect(out.platform).toBe("claude");
    expect(out.branch.messageCount).toBe(5);
    expect(out.branch.messages.map((m) => [m.role, m.content])).toEqual([
      ["system", "Be brief."],
      ["user", "hello"],
      ["assistant", "hi there"],
      ["user", "how are you?"],
      ["assistant", "fine"],
    ]);
  });

  it("gives every message a ref that resolves back to that message", () => {
    // A ref copied from the JSON is what `get --message` takes, so the two must agree.
    const out = parsed(formatBranchAsJson(chat, path));

    expect(out.branch.messages.map((m) => resolveMessageRef(chat, m.ref).messageId)).toEqual(path);
  });

  it("with skipSystem, drops the system messages and the system prompt, and counts what it lists", () => {
    const withSystem = parsed(formatBranchAsJson(chat, path));
    const withoutSystem = parsed(formatBranchAsJson(chat, path, { skipSystem: true }));

    expect(withSystem.system).toBe("Be brief.");
    expect(withoutSystem).not.toHaveProperty("system");
    expect(withoutSystem.branch.messages.map((m) => m.role)).not.toContain("system");
    expect(withoutSystem.branch.messageCount).toBe(4);
    expect(withoutSystem.branch.messages).toHaveLength(4);
  });
});

describe("toJsonString", () => {
  it("escapes DEL and C1, which JSON.stringify leaves raw, without changing the value", () => {
    const value = { title: "a\u009b2Jb\u007fc", plain: "ok é 😀" };
    const out = toJsonString(value, false);
    expect(out).not.toMatch(/[\u007f-\u009f]/);
    expect(out).toContain("\\u009b");
    expect(JSON.parse(out)).toEqual(value);
  });
});
