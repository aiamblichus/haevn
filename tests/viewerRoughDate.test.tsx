import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, SearchResult } from "../src/model/haevn_model";
import { whenOf } from "../src/model/roughDate";
import { registerAllProviders } from "../src/providers/index";

// HVN-163, special case 2: a chat with a rough date shows it once in the viewer and its messages
// show no time; a search result shows the label, not a time. Both key on `params.roughDate`, so the
// chats here are Gemini chats, not fragments. Their message times are made up (0 + i ms, to keep
// the order), which is what the viewer must not show as "01/01/1970, 00:00".

const UNDATED = { text: "", precision: "unknown", approximate: false, from: 0, to: 0 };
const MARCH_2024 = {
  text: "~2024-03",
  precision: "month",
  approximate: true,
  from: Date.UTC(2024, 2, 1),
  to: Date.UTC(2024, 3, 1),
};

/** A chat of n turns, the i-th one stamped `base + i` ms. */
function geminiChat(roughDate: unknown, base: number, turns = 3): Chat {
  const messages: Record<string, ChatMessage> = {};
  for (let i = 0; i < turns; i++) {
    const at = new Date(base + i).toISOString();
    messages[`t${i}`] = {
      id: `t${i}`,
      parentId: i === 0 ? undefined : `t${i - 1}`,
      childrenIds: i === turns - 1 ? [] : [`t${i + 1}`],
      message: [
        {
          kind: "request",
          parts: [{ part_kind: "user-prompt", content: `question ${i}`, timestamp: at }],
        },
        {
          kind: "response",
          parts: [{ part_kind: "text", content: `answer ${i}` }],
          timestamp: at,
        },
      ],
      model: "gemini",
      done: true,
      timestamp: base + i,
      chatId: "gemini-1",
    };
  }
  return {
    id: "gemini-1",
    source: "gemini",
    sourceId: "1",
    title: "An old Gemini chat",
    models: ["gemini"],
    params: roughDate ? { roughDate } : {},
    currentId: `t${turns - 1}`,
    messages,
    tags: [],
    timestamp: base,
    lastSyncedTimestamp: Date.UTC(2026, 10, 26),
    providerLastModifiedTimestamp: base,
    checksum: "x",
    syncStatus: "synced",
  };
}

// The viewer is a page entry that mounts itself when it finds #app: give it a document with none.
let Header: typeof import("../src/viewer/viewer").Header;
let Thread: typeof import("../src/viewer/viewer").Thread;

const viewer = (chat: Chat, showTimes: boolean) =>
  renderToStaticMarkup(
    <>
      <Header
        chat={chat}
        markdownEnabled={false}
        onMarkdownToggle={() => {}}
        onCopy={async () => {}}
        onOpenExport={() => {}}
      />
      <Thread
        start={chat.messages.t0}
        map={chat.messages}
        visibleIndex={new Map()}
        setVisibleIndex={() => {}}
        markdownEnabled={false}
        showTimes={showTimes}
      />
    </>,
  );

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the viewer and a chat with a rough date (HVN-163)", () => {
  beforeAll(async () => {
    vi.stubGlobal("document", { getElementById: () => null });
    ({ Header, Thread } = await import("../src/viewer/viewer"));
    registerAllProviders();
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it("shows an undated Gemini chat as undated once, and no time on any message", () => {
    const chat = geminiChat(UNDATED, 0);
    const markup = viewer(chat, false);

    expect(count(markup, "undated")).toBe(1);
    expect(markup).not.toContain("1970");
    expect(markup).not.toMatch(/\d\d:\d\d/);
    // the turns are all there
    expect(markup).toContain("question 2");
    expect(markup).toContain("answer 2");
  });

  it("would show the made-up times if the viewer did not leave them out", () => {
    // the control: the same chat with times on shows what the flag keeps from the reader
    expect(viewer(geminiChat(UNDATED, 0), true)).toContain("1970");
  });

  it("shows a Gemini chat dated to a month with that label once, and no message time", () => {
    const chat = geminiChat(MARCH_2024, MARCH_2024.from + 15 * 86_400_000);
    const markup = viewer(chat, false);

    expect(count(markup, "c. Mar 2024")).toBe(1);
    expect(markup).not.toMatch(/\d\d\/\d\d\/\d{4}/);
    expect(markup).not.toMatch(/\d\d:\d\d/);
  });

  it("still shows the time of each message of a chat with no rough date", () => {
    const chat = geminiChat(undefined, Date.UTC(2025, 5, 1, 9, 30));
    const markup = viewer(chat, true);

    expect(markup).toMatch(/06\/01\/2025/);
    expect(markup).not.toContain("undated");
  });
});

describe("a search result for a chat with a rough date (HVN-163)", () => {
  it("gives the label and no message time, for any source", () => {
    expect(whenOf(geminiChat(UNDATED, 0), 2)).toEqual({ dateLabel: "undated" });
    expect(whenOf(geminiChat(MARCH_2024, MARCH_2024.from), 5)).toEqual({
      dateLabel: "c. Mar 2024",
    });
  });

  it("gives the message time of a chat with none", () => {
    const at = Date.UTC(2025, 5, 1);
    expect(whenOf(geminiChat(undefined, at), at + 7)).toEqual({ messageTimestamp: at + 7 });
  });

  it("is a field of the result that readers can rely on", () => {
    const result: SearchResult = {
      chatId: "gemini-1",
      chatTitle: "t",
      source: "gemini",
      messageId: "t1",
      messageSnippet: "s",
      messageContent: "s",
      messageRole: "user",
      ...whenOf(geminiChat(UNDATED, 0), 1),
    };
    expect(result.dateLabel).toBe("undated");
    expect(result.messageTimestamp).toBeUndefined();
  });
});
