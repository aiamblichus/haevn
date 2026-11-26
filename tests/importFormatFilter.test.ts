import { describe, expect, it } from "vitest";
import {
  formatListedUnder,
  providerOfFormat,
} from "../src/options/components/Modals/importFormats";
import { importFormatFor } from "../src/options/components/ProvidersView/importFormat";

// HVN-111: the Import dialog's filter matches the format exactly. A Claude Code dialog must not
// list "Claude Backup (.zip)", though "claudecode_jsonl" starts with "claude". The dialog's own
// formats, as its options list them.
const DIALOG_FORMATS = [
  "chatgpt_zip",
  "claude_zip",
  "claudecode_jsonl",
  "codex_jsonl",
  "pi_jsonl",
  "fragment_md",
  "openrouter_json",
  "openwebui_json",
  "openwebui_zip",
];

function listedUnder(filter: string | null): string[] {
  return DIALOG_FORMATS.filter((format) => formatListedUnder(filter, format));
}

describe("Import dialog format filter (HVN-111)", () => {
  it("lists every format when there is no filter", () => {
    expect(listedUnder(null)).toEqual(DIALOG_FORMATS);
  });

  it("lists only the Claude Code format under the Claude Code filter", () => {
    expect(listedUnder("claudecode_jsonl")).toEqual(["claudecode_jsonl"]);
  });

  it("lists only the fragment format under the fragment filter (HVN-163)", () => {
    expect(listedUnder("fragment_md")).toEqual(["fragment_md"]);
  });

  it("lists only the Claude backup under the Claude filter", () => {
    expect(listedUnder("claude_zip")).toEqual(["claude_zip"]);
  });

  it("lists both Open WebUI formats under either Open WebUI filter", () => {
    expect(listedUnder("openwebui_zip")).toEqual(["openwebui_json", "openwebui_zip"]);
    expect(listedUnder("openwebui_json")).toEqual(["openwebui_json", "openwebui_zip"]);
  });

  it("lists only the ChatGPT backup under the ChatGPT filter", () => {
    expect(listedUnder("chatgpt_zip")).toEqual(["chatgpt_zip"]);
  });

  it("lists, under each provider's Import button, only formats of that provider", () => {
    // importFormatFor is the Providers view's map (HVN-101): each provider's own format
    expect(importFormatFor("claudecode")).toBe("claudecode_jsonl");
    expect(listedUnder(importFormatFor("claudecode") ?? null)).not.toContain("claude_zip");
    expect(listedUnder(importFormatFor("claude") ?? null)).not.toContain("claudecode_jsonl");
  });

  it("reads a format's provider as the part before its first underscore", () => {
    expect(providerOfFormat("claudecode_jsonl")).toBe("claudecode");
    expect(providerOfFormat("claude_zip")).toBe("claude");
    expect(providerOfFormat("openwebui_zip")).toBe("openwebui");
    expect(providerOfFormat("plain")).toBe("plain");
  });
});
