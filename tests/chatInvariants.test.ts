import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage, ModelMessage } from "../src/model/haevn_model";
import {
  type CheckOptions,
  checkChat,
  describeChat,
  FINDING_LEVELS,
  type FindingCode,
} from "../src/providers/shared/chatInvariants";

// checkChat is the ruler: one definition of "works". Each rule below is shown to FAIL on a chat
// broken in exactly that one way, and a healthy chat is shown to pass, so a rule that never fires
// (or fires on everything) is caught here.

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const T0 = Date.UTC(2026, 10, 19, 11, 0, 0);
const OPTIONS: CheckOptions = { now: NOW };

function request(text: string, at = T0): ModelMessage {
  return {
    kind: "request",
    parts: [{ part_kind: "user-prompt", content: text, timestamp: new Date(at).toISOString() }],
  };
}

function response(text: string, at = T0): ModelMessage {
  return {
    kind: "response",
    parts: [{ part_kind: "text", content: text }],
    timestamp: new Date(at).toISOString(),
    model_name: "m",
  };
}

function node(
  id: string,
  parentId: string | undefined,
  childrenIds: string[],
  message: ModelMessage[],
  timestamp = T0,
): ChatMessage {
  return { id, parentId, childrenIds, message, model: "m", done: true, timestamp, chatId: "c1" };
}

/** u1 -> a1 -> u2 -> a2, all different instants, everything in order. */
function healthy(): Chat {
  return {
    id: "c1",
    source: "claude",
    sourceId: "c1",
    title: "A real title",
    models: ["m"],
    params: {},
    currentId: "a2",
    messages: {
      u1: node("u1", undefined, ["a1"], [request("hello", T0)], T0),
      a1: node("a1", "u1", ["u2"], [response("hi", T0 + 1000)], T0 + 1000),
      u2: node("u2", "a1", ["a2"], [request("more", T0 + 2000)], T0 + 2000),
      a2: node("a2", "u2", [], [response("sure", T0 + 3000)], T0 + 3000),
    },
    tags: [],
    timestamp: T0,
    lastSyncedTimestamp: T0,
    checksum: "",
    syncStatus: "new",
    deleted: 0,
  };
}

const codes = (chat: Chat | Chat[]) => checkChat(chat, OPTIONS).map((f) => f.code);

/** A broken chat per rule, built from the healthy one by breaking one thing. */
const BROKEN: Record<FindingCode, (chat: Chat) => Chat | Chat[]> = {
  "chat.id-missing": (c) => ({ ...c, id: "" }),
  "chat.source-missing": (c) => ({ ...c, source: "" }),
  "chat.source-id-missing": (c) => ({ ...c, sourceId: "" }),
  "title.empty": (c) => ({ ...c, title: "  " }),
  "title.fallback": (c) => ({ ...c, title: "Untitled AI Studio Conversation" }),
  "messages.none": (c) => ({ ...c, messages: {}, currentId: "" }),
  "message.no-parts": (c) => {
    c.messages.a2.message = [];
    return c;
  },
  "message.empty-parts": (c) => {
    c.messages.a2.message = [
      { kind: "response", parts: [], timestamp: new Date(T0).toISOString(), model_name: "m" },
    ];
    return c;
  },
  "tree.current-missing": (c) => ({ ...c, currentId: "gone" }),
  "tree.current-unreachable": (c) => {
    // a1's parent names a message that does not exist; the walk from a2 cannot reach a root
    c.messages.a1.parentId = "lost";
    return c;
  },
  "tree.parent-dangling": (c) => {
    c.messages.a1.parentId = "lost";
    return c;
  },
  "tree.child-dangling": (c) => {
    c.messages.a2.childrenIds = ["nowhere"];
    return c;
  },
  "tree.link-mismatch": (c) => {
    // a1 forgets to list u2 as a child, though u2 names a1 as its parent
    c.messages.a1.childrenIds = [];
    return c;
  },
  "tree.cycle": (c) => {
    c.messages.u1.parentId = "a2";
    c.messages.a2.childrenIds = ["u1"];
    return c;
  },
  "tree.multiple-roots": (c) => {
    c.messages.u2.parentId = undefined;
    c.messages.a1.childrenIds = [];
    return c;
  },
  "turns.no-user": (c) => {
    c.messages.u1.message = [response("greeting")];
    c.messages.u2.message = [response("again")];
    return c;
  },
  "turns.no-model": (c) => {
    c.messages.a1.message = [request("one")];
    c.messages.a2.message = [request("two")];
    return c;
  },
  "roles.model-first": (c) => {
    c.messages.u1.message = [response("hello from the bot")];
    return c;
  },
  "roles.not-alternating": (c) => {
    c.messages.a1.message = [request("and again")];
    return c;
  },
  "text.empty": (c) => {
    c.messages.a2.message = [response("")];
    return c;
  },
  "time.invalid": (c) => {
    c.messages.a1.timestamp = Number.NaN;
    return c;
  },
  "time.out-of-range": (c) => {
    // seconds taken for milliseconds: January 1970
    c.timestamp = Math.floor(T0 / 1000);
    return c;
  },
  "time.all-equal": (c) => {
    for (const m of Object.values(c.messages)) m.timestamp = T0;
    return c;
  },
  "models.none": (c) => ({ ...c, models: [] }),
};

describe("checkChat: the healthy chat", () => {
  it("passes with no findings", () => {
    expect(checkChat(healthy(), OPTIONS)).toEqual([]);
  });

  it("passes a chat of one user turn and one model turn", () => {
    const chat = healthy();
    delete chat.messages.u2;
    delete chat.messages.a2;
    chat.messages.a1.childrenIds = [];
    chat.currentId = "a1";
    expect(checkChat(chat, OPTIONS)).toEqual([]);
  });

  it("does not count an empty tool argument or a system prompt as a fault", () => {
    const chat = healthy();
    chat.messages.u1.message = [
      {
        kind: "request",
        parts: [
          {
            part_kind: "system-prompt",
            content: "be brief",
            timestamp: new Date(T0).toISOString(),
          },
          { part_kind: "user-prompt", content: "hello", timestamp: new Date(T0).toISOString() },
        ],
      },
    ];
    chat.messages.a1.message = [
      {
        kind: "response",
        parts: [
          { part_kind: "tool-call", tool_name: "ls", args: "", tool_call_id: "t1" },
          { part_kind: "text", content: "done" },
        ],
        timestamp: new Date(T0 + 1000).toISOString(),
      },
    ];
    expect(checkChat(chat, OPTIONS)).toEqual([]);
  });

  it("accepts a user prompt made of an image alone", () => {
    const chat = healthy();
    chat.messages.u1.message = [
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            content: [{ kind: "image-url", url: "https://example.test/a.png" }],
            timestamp: new Date(T0).toISOString(),
          },
        ],
      },
    ];
    expect(codes(chat)).toEqual([]);
  });
});

describe("checkChat: each rule fails on a chat broken in that one way", () => {
  for (const code of Object.keys(FINDING_LEVELS) as FindingCode[]) {
    it(`${code} (${FINDING_LEVELS[code]})`, () => {
      const result = checkChat(BROKEN[code](healthy()), OPTIONS);
      const finding = result.find((f) => f.code === code);
      expect(
        finding,
        `${code} not reported; got ${result.map((f) => f.code).join(", ")}`,
      ).toBeDefined();
      expect(finding?.level).toBe(FINDING_LEVELS[code]);
      expect(finding?.count).toBeGreaterThanOrEqual(1);
    });
  }

  it("every rule has a broken case (the table above is complete)", () => {
    expect(Object.keys(BROKEN).sort()).toEqual(Object.keys(FINDING_LEVELS).sort());
  });

  it("each broken chat breaks only its own rule, apart from the ones that go together", () => {
    // A rule that fires on a chat broken another way is a rule that is too wide. These pairs
    // really are one fault seen by two rules, so they are named, not waved through.
    const together: Partial<Record<FindingCode, FindingCode[]>> = {
      "messages.none": ["tree.current-missing", "turns.no-user", "turns.no-model"],
      "message.no-parts": [],
      // a1 loses its parent: u1 still lists a1 (a link mismatch) and the walk from a2 ends there
      "tree.current-unreachable": ["tree.parent-dangling", "tree.link-mismatch"],
      "tree.parent-dangling": ["tree.current-unreachable", "tree.link-mismatch"],
      "tree.child-dangling": [],
      "tree.cycle": ["tree.link-mismatch", "tree.multiple-roots"],
      "tree.multiple-roots": [],
      "tree.link-mismatch": [],
      "turns.no-user": ["roles.model-first", "roles.not-alternating"],
      "turns.no-model": ["roles.not-alternating"],
      "roles.model-first": ["turns.no-user", "roles.not-alternating"],
      "roles.not-alternating": [],
      "time.all-equal": [],
    };
    for (const code of Object.keys(FINDING_LEVELS) as FindingCode[]) {
      const reported = codes(BROKEN[code](healthy()));
      const allowed = new Set<string>([code, ...(together[code] ?? [])]);
      const extra = reported.filter((c) => !allowed.has(c));
      expect(extra, `${code} also reported ${extra.join(", ")}`).toEqual([]);
    }
  });
});

describe("checkChat: details the rules depend on", () => {
  it("says where, by position, and never by id", () => {
    const chat = healthy();
    chat.messages.a1.message = [response("")];
    chat.messages.a2.message = [response("  ")];
    const finding = checkChat(chat, OPTIONS).find((f) => f.code === "text.empty");
    expect(finding?.count).toBe(2);
    expect(finding?.at).toEqual([2, 4]);
  });

  it("caps the positions it lists", () => {
    const chat = healthy();
    for (let i = 0; i < 12; i++) {
      chat.messages[`x${i}`] = node(`x${i}`, "a2", [], [response("")], T0 + 5000 + i);
      chat.messages.a2.childrenIds.push(`x${i}`);
    }
    const finding = checkChat(chat, OPTIONS).find((f) => f.code === "text.empty");
    expect(finding?.count).toBe(12);
    expect(finding?.at).toHaveLength(5);
  });

  it("catches a thinking part with no text, and a prompt with blank strings only", () => {
    const chat = healthy();
    chat.messages.a1.message = [
      {
        kind: "response",
        parts: [
          { part_kind: "thinking", content: "" },
          { part_kind: "text", content: "ok" },
        ],
        timestamp: new Date(T0 + 1000).toISOString(),
      },
    ];
    chat.messages.u1.message = [
      {
        kind: "request",
        parts: [
          { part_kind: "user-prompt", content: ["", " "], timestamp: new Date(T0).toISOString() },
        ],
      },
    ];
    expect(checkChat(chat, OPTIONS).find((f) => f.code === "text.empty")?.count).toBe(2);
  });

  it("counts a prompt of spaces and newlines as empty, as it does a response of them", () => {
    const chat = healthy();
    chat.messages.u1.message = [request(" \n ")];
    expect(checkChat(chat, OPTIONS).find((f) => f.code === "text.empty")?.count).toBe(1);
  });

  it("catches milliseconds taken for seconds, as well as seconds for milliseconds", () => {
    const tooBig = healthy();
    tooBig.messages.a1.timestamp = T0 * 1000;
    expect(codes(tooBig)).toContain("time.out-of-range");
    const tooSmall = healthy();
    tooSmall.messages.a1.timestamp = Math.floor(T0 / 1000);
    expect(codes(tooSmall)).toContain("time.out-of-range");
  });

  it("allows up to tomorrow and nothing past it, and nothing before 2015", () => {
    const ok = healthy();
    ok.messages.a2.timestamp = NOW + 23 * 60 * 60 * 1000;
    expect(codes(ok)).toEqual([]);
    const late = healthy();
    late.messages.a2.timestamp = NOW + 25 * 60 * 60 * 1000;
    expect(codes(late)).toContain("time.out-of-range");
    const early = healthy();
    early.messages.a2.timestamp = Date.UTC(2014, 11, 31);
    expect(codes(early)).toContain("time.out-of-range");
  });

  it("reads the ISO timestamps on the parts as well as the message's own", () => {
    const chat = healthy();
    chat.messages.a1.message = [{ ...response("hi"), timestamp: "not a date" }];
    expect(codes(chat)).toContain("time.invalid");
    const old = healthy();
    old.messages.u1.message = [request("hello", Date.UTC(1999, 0, 1))];
    expect(codes(old)).toContain("time.out-of-range");
  });

  it("tells a cycle from a break in the path", () => {
    const cyclic = BROKEN["tree.cycle"](healthy()) as Chat;
    expect(codes(cyclic)).toContain("tree.cycle");
    expect(codes(cyclic)).not.toContain("tree.current-unreachable");
    const broken = BROKEN["tree.current-unreachable"](healthy()) as Chat;
    expect(codes(broken)).toContain("tree.current-unreachable");
    expect(codes(broken)).not.toContain("tree.cycle");
  });

  it("is not fooled by a branch: only the current path is held to alternate", () => {
    const chat = healthy();
    // a second answer to u1, a sibling of a1, on a branch that is not current
    chat.messages.a1b = node("a1b", "u1", [], [response("another take", T0 + 1500)], T0 + 1500);
    chat.messages.u1.childrenIds = ["a1", "a1b"];
    expect(checkChat(chat, OPTIONS)).toEqual([]);
  });

  it("checks every chat a transform returned, and sums the counts", () => {
    const a = healthy();
    const b = healthy();
    a.title = "";
    b.title = "";
    const finding = checkChat([a, b], OPTIONS).find((f) => f.code === "title.empty");
    expect(finding?.count).toBe(2);
  });

  it("does not throw on junk where a chat should be", () => {
    const junk = {
      source: "x",
      messages: { m: { message: "not an array", childrenIds: null } },
      currentId: "m",
    } as unknown as Chat;
    expect(() => checkChat(junk, OPTIONS)).not.toThrow();
    expect(codes(junk)).toContain("message.no-parts");
    expect(() => checkChat(undefined as unknown as Chat, OPTIONS)).not.toThrow();
    expect(codes(undefined as unknown as Chat)).toContain("messages.none");
  });

  it("carries no chat text, title or id in anything it returns", () => {
    const chat = healthy();
    chat.id = "ID-SENTINEL-1";
    chat.sourceId = "";
    chat.title = "";
    chat.messages.a1.message = [response("")];
    // put a sentinel in text that is NOT empty, on a message that breaks another rule
    chat.messages.a2.message = [response("TEXT-SENTINEL-2")];
    chat.messages.a2.timestamp = Number.NaN;
    const json = JSON.stringify(checkChat(chat, OPTIONS));
    expect(json).not.toContain("SENTINEL");
    for (const id of Object.keys(chat.messages)) expect(json).not.toContain(`"${id}"`);
  });
});

describe("describeChat", () => {
  it("counts messages, turns and part kinds, and nothing else", () => {
    const shape = describeChat(healthy());
    expect(shape).toEqual({
      messages: 4,
      userTurns: 2,
      modelTurns: 2,
      parts: { "user-prompt": 2, text: 2 },
    });
  });

  it("does not throw on junk", () => {
    expect(describeChat({ messages: null } as unknown as Chat).messages).toBe(0);
  });
});
