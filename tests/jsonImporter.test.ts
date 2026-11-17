import { describe, expect, it } from "vitest";
import { sha256Hex, validateAndNormalizeChat } from "../src/utils/jsonImporter";

describe("jsonImporter", () => {
  it("hashes text with SHA-256 as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("names a chat that carries no id after its content hash", async () => {
    const text = JSON.stringify({
      title: "Hand-edited",
      currentId: "m1",
      messages: { m1: { id: "m1", childrenIds: [], message: [], done: true } },
    });
    const hash = await sha256Hex(text);

    const chat = validateAndNormalizeChat(JSON.parse(text), hash);

    expect(chat.sourceId).toBe(hash);
    expect(chat.id).toBe(hash);
    expect(chat.source).toBe("unknown");
  });

  it("keeps the id and sourceId a chat file names", async () => {
    const chat = validateAndNormalizeChat(
      {
        id: "chat-1",
        sourceId: "src-1",
        source: "claude",
        title: "Exported",
        currentId: "m1",
        messages: { m1: { id: "m1" } },
      },
      "unused-hash",
    );

    expect(chat.id).toBe("chat-1");
    expect(chat.sourceId).toBe("src-1");
  });
});
