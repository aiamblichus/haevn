import { describe, expect, it } from "vitest";
import { parseMarkdownContent } from "../src/utils/markdownImporter";

describe("markdownImporter", () => {
  it("parses HAEVN markdown with YAML frontmatter", async () => {
    const markdown = `---
title: Gemini Session
source: Gemini
conversation_id: convo-123
created_at: 2024-01-01T10:00:00.000Z
modified_at: 2024-01-01T10:05:00.000Z
system: You are helpful
models_used:
  - gemini-2.5-pro
---

<!-- HAEVN: role="user" -->
Hello there

<!-- HAEVN: role="assistant" -->
Hi! How can I help?
`;

    const chat = await parseMarkdownContent(markdown);

    expect(chat.id).toBe("convo-123");
    expect(chat.source).toBe("Gemini");
    expect(chat.title).toBe("Gemini Session");
    expect(chat.models).toEqual(["gemini-2.5-pro"]);
    expect(chat.system).toBe("You are helpful");
    expect(chat.timestamp).toBe(Date.parse("2024-01-01T10:00:00.000Z"));
    expect(chat.providerLastModifiedTimestamp).toBe(Date.parse("2024-01-01T10:05:00.000Z"));
    expect(Object.keys(chat.messages)).toHaveLength(2);

    const first = chat.messages.msg_0;
    expect(first.message[0].kind).toBe("request");
    if (first.message[0].kind === "request") {
      expect(first.message[0].parts[0].part_kind).toBe("system-prompt");
      expect(first.message[0].parts[1].part_kind).toBe("user-prompt");
    }
  });

  it("uses hash id when conversation_id is missing", async () => {
    const markdown = `---
title: Untitled Session
source: Gemini
---

<!-- HAEVN: role="user" -->
Ping

<!-- HAEVN: role="assistant" -->
Pong
`;

    const chat = await parseMarkdownContent(markdown);

    expect(chat.id).toBeTruthy();
    expect(chat.id).not.toBe("convo-123");
    expect(chat.source).toBe("Gemini");
    expect(chat.models).toEqual(["unknown"]);
  });

  it("tolerates optional message separators for backward compatibility", async () => {
    const markdown = `---
title: Delimited Session
source: Gemini
---

<!-- HAEVN: role="user" -->
Hi
---
<!-- HAEVN: role="assistant" -->
Hello
---
`;

    const chat = await parseMarkdownContent(markdown);
    expect(Object.keys(chat.messages)).toHaveLength(2);
  });

  it("rejects legacy bold-key metadata format", async () => {
    const markdown = `# Legacy Header

**Source:** Gemini
**Conversation ID:** old-123
---
<!-- HAEVN: role="user" -->
Hi
---
<!-- HAEVN: role="assistant" -->
Hello
---
`;

    await expect(parseMarkdownContent(markdown)).rejects.toThrow("Missing YAML frontmatter");
  });
});
