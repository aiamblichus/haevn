import { describe, expect, it } from "vitest";
import {
  type ExportOptions,
  generateExportContent,
  generateExportFilename,
} from "../src/formatters";
import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../src/model/haevn_model";
import { parseMarkdownContent } from "../src/utils/markdownImporter";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  const req: ModelRequest = {
    kind: "request",
    parts: [
      {
        part_kind: "user-prompt",
        content: "Hello AI",
        timestamp: new Date("2024-01-01T10:00:00Z").toISOString(),
      },
    ],
  };
  const res: ModelResponse = {
    kind: "response",
    parts: [{ part_kind: "text", content: "Hi! How can I help?" }],
    timestamp: new Date("2024-01-01T10:00:05Z").toISOString(),
    model_name: "test-model",
  };
  const msg: ChatMessage = {
    id: "m1",
    childrenIds: [],
    message: [req],
    model: "user",
    done: true,
    chatId: "c1",
    timestamp: Date.now(),
  };
  const msg2: ChatMessage = {
    id: "m2",
    parentId: "m1",
    childrenIds: [],
    message: [res],
    model: "assistant-model",
    done: true,
    chatId: "c1",
    timestamp: Date.now(),
  };
  const base: Chat = {
    id: "c1",
    source: "claude",
    sourceId: "c1",
    title: "Sample Chat: test/<>",
    models: ["test-model"],
    params: {},
    currentId: "m2",
    messages: { m1: msg, m2: msg2 },
    tags: [],
    timestamp: Date.now(),
    files: [],
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: Date.now(),
    checksum: "abc",
    syncStatus: "synced",
  } as Chat;
  return { ...base, ...overrides };
}

describe("formatters", () => {
  it("generates JSON export", async () => {
    const chat = makeChat();
    const content = await generateExportContent(chat, {
      format: "json",
      includeMetadata: true,
      includeTimestamps: true,
    } as ExportOptions);
    expect(content).toContain("Sample Chat");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("c1");
  });

  it("generates Markdown export with YAML frontmatter", async () => {
    const chat = makeChat();
    const content = await generateExportContent(chat, {
      format: "markdown",
      includeMetadata: true,
      includeTimestamps: true,
    });
    expect(content).toMatch(/^---\n[\s\S]+\n---\n\n/);
    expect(content).toMatch(/title:\s+/);
    expect(content).toContain(`source: ${chat.source}`);
    expect(content).toContain(`conversation_id: ${chat.id}`);
    expect(content).toContain("created_at:");
    expect(content).toContain("modified_at:");
    expect(content).toContain('<!-- HAEVN: role="user" -->');
    expect(content).toContain('<!-- HAEVN: role="assistant" -->');
  });

  it("generates export filename with sanitized title and extension", () => {
    const nameJson = generateExportFilename("claude", "A/B<C>?*Title", "json");
    expect(nameJson.endsWith(".json")).toBe(true);
    expect(nameJson).not.toMatch(/[<>:"/\\|?*]/);

    const nameMd = generateExportFilename("gemini", "Hello World", "markdown");
    expect(nameMd.endsWith(".md")).toBe(true);
  });

  it("generates Claude export filename with conversation ID", () => {
    const conversationId = "f75ac9be-f5d9-427e-87c8-6abd82a9ef10";
    const nameJson = generateExportFilename("claude", "Some Title", "json", conversationId);
    expect(nameJson).toBe(`claude_chat_${conversationId}.json`);
    expect(nameJson).not.toContain("Some Title");

    const nameMd = generateExportFilename("claude", "Another Title", "markdown", conversationId);
    expect(nameMd).toBe(`claude_chat_${conversationId}.md`);
  });
});

// A branched chat. Message numbers are positions on the way down from the root.
//
//   q1 ── a1-first            (regenerated reply, abandoned)
//      └─ a1 ── q2-original ── a2-original   (edited user turn, abandoned)
//            └─ q2-edited ── a2              (current)
//
// Creation order: q1, a1-first, a1, q2-original, a2-original, q2-edited, a2.
function makeBranchedChat(overrides: Partial<Chat> = {}): Chat {
  const user = (id: string, parentId: string | undefined, text: string, t: number) =>
    ({
      id,
      parentId,
      childrenIds: [],
      message: [
        {
          kind: "request",
          parts: [
            { part_kind: "user-prompt", content: text, timestamp: new Date(t).toISOString() },
          ],
        } as ModelRequest,
      ],
      model: "user",
      done: true,
      chatId: "c1",
      timestamp: t,
    }) as ChatMessage;
  const assistant = (id: string, parentId: string, text: string, t: number) =>
    ({
      id,
      parentId,
      childrenIds: [],
      message: [
        {
          kind: "response",
          parts: [{ part_kind: "text", content: text }],
          timestamp: new Date(t).toISOString(),
          model_name: "test-model",
        } as ModelResponse,
      ],
      model: "test-model",
      done: true,
      chatId: "c1",
      timestamp: t,
    }) as ChatMessage;

  const t0 = Date.UTC(2024, 0, 1, 10, 0, 0);
  const list = [
    user("q1", undefined, "Question one", t0 + 1000),
    assistant("a1-first", "q1", "Answer one, first try", t0 + 2000),
    assistant("a1", "q1", "Answer one, regenerated", t0 + 3000),
    user("q2-original", "a1", "Question two, as first written", t0 + 4000),
    assistant("a2-original", "q2-original", "Answer to the first wording", t0 + 5000),
    user("q2-edited", "a1", "Question two, edited", t0 + 6000),
    assistant("a2", "q2-edited", "Answer to the edit", t0 + 7000),
  ];
  const messages: Record<string, ChatMessage> = {};
  for (const m of list) messages[m.id] = m;
  for (const m of list) {
    if (m.parentId) messages[m.parentId].childrenIds.push(m.id);
  }
  // Insert in an order that is not creation order, so no test passes by Object.keys luck.
  const shuffled: Record<string, ChatMessage> = {};
  for (const id of ["a2", "q1", "a2-original", "a1", "q2-edited", "a1-first", "q2-original"]) {
    shuffled[id] = messages[id];
  }
  return makeChat({ currentId: "a2", messages: shuffled, ...overrides });
}

const MD_OPTIONS: ExportOptions = {
  format: "markdown",
  includeMetadata: true,
  includeTimestamps: true,
};

function positions(content: string, needles: string[]): number[] {
  return needles.map((n) => content.indexOf(n));
}

describe("Markdown export of a branched chat", () => {
  it("writes the current branch only, in tree order, by default", async () => {
    const content = await generateExportContent(makeBranchedChat(), MD_OPTIONS);

    const kept = [
      "Question one",
      "Answer one, regenerated",
      "Question two, edited",
      "Answer to the edit",
    ];
    const at = positions(content, kept);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    expect(content).not.toContain("first try");
    expect(content).not.toContain("as first written");
    expect(content).not.toContain("Answer to the first wording");
    expect(content.match(/<!-- HAEVN: role=/g)).toHaveLength(4);
  });

  it("says in the frontmatter which branch it holds and how many it left out", async () => {
    const content = await generateExportContent(makeBranchedChat(), MD_OPTIONS);
    expect(content).toMatch(/^branch: current$/m);
    expect(content).toMatch(/^other_branches_omitted: 2$/m);
  });

  it("follows currentId even when it points at an older leaf", async () => {
    const content = await generateExportContent(
      makeBranchedChat({ currentId: "a2-original" }),
      MD_OPTIONS,
    );
    expect(content).toContain("Answer to the first wording");
    expect(content).toContain("Question two, as first written");
    expect(content).not.toContain("Question two, edited");
    expect(content).not.toContain("first try");
  });

  it("without currentId, takes the most recently created leaf", async () => {
    const content = await generateExportContent(makeBranchedChat({ currentId: "" }), MD_OPTIONS);
    expect(content).toContain("Answer to the edit");
    expect(content).not.toContain("Answer to the first wording");
    expect(content).not.toContain("first try");
  });

  it("with allBranches, writes the main path in full and then each alternative once", async () => {
    const content = await generateExportContent(makeBranchedChat(), {
      ...MD_OPTIONS,
      allBranches: true,
    });

    expect(content).toMatch(/^branches: all$/m);
    expect(content).not.toMatch(/^branch: current$/m);

    const mainEnd = content.indexOf("Answer to the edit");
    const branch1 = content.indexOf("## Branch 1: at message 1");
    const branch2 = content.indexOf("## Branch 2: at message 2");
    expect(mainEnd).toBeGreaterThan(-1);
    expect(branch1).toBeGreaterThan(mainEnd);
    expect(branch2).toBeGreaterThan(branch1);

    // Branch 1 forks after "Question one" and holds only the abandoned first reply.
    const branch1Text = content.slice(branch1, branch2);
    expect(branch1Text).toContain("Question one");
    expect(branch1Text).toContain("Answer one, first try");
    expect(branch1Text).not.toContain("as first written");

    // Branch 2 forks after message 2 (the regenerated reply) and holds the original wording.
    const branch2Text = content.slice(branch2);
    expect(branch2Text).toContain("Answer one, regenerated");
    expect(branch2Text).toContain("Question two, as first written");
    expect(branch2Text.indexOf("Question two, as first written")).toBeLessThan(
      branch2Text.indexOf("Answer to the first wording"),
    );

    // Every message exactly once.
    expect(content.match(/<!-- HAEVN: role=/g)).toHaveLength(7);
    for (const text of [
      "Answer one, first try",
      "Answer to the edit",
      "Answer to the first wording",
    ]) {
      expect(content.split(text)).toHaveLength(2);
    }
  });

  it("nests an alternative that forks inside an alternative", async () => {
    const chat = makeBranchedChat();
    // A second reply to the original wording, so branch 2 itself forks.
    const extra = {
      ...chat.messages["a2-original"],
      id: "a2-retry",
      childrenIds: [],
      timestamp: (chat.messages["a2-original"].timestamp ?? 0) + 500,
      message: [
        {
          kind: "response",
          parts: [{ part_kind: "text", content: "A retry of the first wording" }],
          timestamp: new Date().toISOString(),
          model_name: "test-model",
        } as ModelResponse,
      ],
    } as ChatMessage;
    chat.messages["a2-retry"] = extra;
    chat.messages["q2-original"].childrenIds.push("a2-retry");

    const content = await generateExportContent(chat, { ...MD_OPTIONS, allBranches: true });
    expect(content).toContain("## Branch 3: at message 3 of branch 2");
    expect(content.match(/<!-- HAEVN: role=/g)).toHaveLength(8);
  });

  it("keeps explicit messageIds exactly as given, with or without allBranches", async () => {
    const chat = makeBranchedChat();
    const ids = ["a1-first", "q1"];
    for (const allBranches of [false, true]) {
      const content = await generateExportContent(chat, {
        ...MD_OPTIONS,
        messageIds: ids,
        allBranches,
      });
      expect(content).toContain("Answer one, first try");
      expect(content.indexOf("Answer one, first try")).toBeLessThan(
        content.indexOf("Question one"),
      );
      expect(content).not.toContain("## Branch");
      expect(content).not.toMatch(/^branch(es)?:/m);
      expect(content.match(/<!-- HAEVN: role=/g)).toHaveLength(2);
    }
  });

  it("leaves a linear chat alone", async () => {
    const content = await generateExportContent(makeChat(), {
      ...MD_OPTIONS,
      allBranches: true,
    });
    expect(content).not.toContain("## Branch");
    expect(content).toContain("Hello AI");
    expect(content).toContain("Hi! How can I help?");
    expect(content).toMatch(/^branches: all$/m);
  });

  it("falls back to timestamp order for messages that carry no links", async () => {
    const chat = makeBranchedChat();
    for (const m of Object.values(chat.messages)) {
      m.parentId = undefined;
      m.childrenIds = [];
    }
    const content = await generateExportContent(chat, MD_OPTIONS);
    expect(content.match(/<!-- HAEVN: role=/g)).toHaveLength(7);
    expect(content).not.toMatch(/^branch:/m);
  });

  it("writes a default export the Markdown importer reads back as the same messages", async () => {
    const content = await generateExportContent(makeBranchedChat(), MD_OPTIONS);
    const imported = await parseMarkdownContent(content);
    expect(Object.keys(imported.messages)).toHaveLength(4);
  });
});
