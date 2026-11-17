import { describe, expect, it } from "vitest";
import { buildChat } from "../testing/fixtures";
import {
  buildMessageRefIndex,
  createMessageRef,
  getMessageRef,
  resolveMessageRef,
} from "./messageRefs";

// Twenty messages. Their refs are 12 hex digits, and twenty refs over sixteen first digits must
// share one, so the ambiguous-prefix case below does not depend on luck.
const chat = buildChat(
  Array.from({ length: 20 }, (_, i) => ({
    id: `msg_${i}`,
    parentId: i === 0 ? null : `msg_${i - 1}`,
    role: "user" as const,
    text: `message ${i}`,
  })),
);
const ids = Object.keys(chat.messages);
const index = buildMessageRefIndex(chat);
const refs = ids.map((id) => getMessageRef(index, id));

describe("message refs", () => {
  it("keeps a ref fixed, because users copy refs out and paste them back later", () => {
    // The hash input (chat id, a colon, message id) and the 12-digit length are the format.
    expect(createMessageRef("chat-1", "msg_0")).toBe("aada14e5ecba");
  });

  it("resolves a message by its full id, its ref, or its ref in capitals", () => {
    for (const id of ids) {
      const ref = getMessageRef(index, id);
      expect(resolveMessageRef(chat, id)).toEqual({ messageId: id });
      expect(resolveMessageRef(chat, ref)).toEqual({ messageId: id });
      expect(resolveMessageRef(chat, ref.toUpperCase())).toEqual({ messageId: id });
    }
  });

  it("resolves a prefix that only one message has, and refuses a prefix that two share", () => {
    const shared = refs
      .map((ref) => ref[0])
      .find((c) => refs.filter((r) => r.startsWith(c)).length > 1);
    expect(shared).toBeDefined();
    expect(resolveMessageRef(chat, shared ?? "").error).toContain("Ambiguous message reference");

    const prefix = refs[0].slice(0, 8);
    expect(refs.filter((r) => r.startsWith(prefix))).toHaveLength(1);
    expect(resolveMessageRef(chat, prefix)).toEqual({ messageId: ids[0] });
  });

  it("refuses a ref that no message has, and an empty one", () => {
    expect(resolveMessageRef(chat, "")).toEqual({ error: "Empty message reference" });
    expect(resolveMessageRef(chat, "ffffffffffffffff")).toEqual({
      error: 'Unknown message reference "ffffffffffffffff"',
    });
  });
});
