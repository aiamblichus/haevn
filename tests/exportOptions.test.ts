import { describe, expect, it } from "vitest";
import { getExporter, normalizeExportOptions } from "../src/background/export/exporters";
import { buildTextExportArtifact } from "../src/background/export/textExportArtifact";
import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../src/model/haevn_model";

function message(
  id: string,
  parentId: string | undefined,
  role: "user" | "assistant",
  text: string,
  t: number,
): ChatMessage {
  const part =
    role === "user"
      ? ({
          kind: "request",
          parts: [
            { part_kind: "user-prompt", content: text, timestamp: new Date(t).toISOString() },
          ],
        } as ModelRequest)
      : ({
          kind: "response",
          parts: [{ part_kind: "text", content: text }],
          timestamp: new Date(t).toISOString(),
          model_name: "m",
        } as ModelResponse);
  return {
    id,
    parentId,
    childrenIds: [],
    message: [part],
    model: "m",
    done: true,
    chatId: "c",
    timestamp: t,
  };
}

// root ── kept (current)
//      └─ regenerated (abandoned)
function branchedChat(): Chat {
  const root = message("root", undefined, "user", "Opening question", 1);
  const kept = message("kept", "root", "assistant", "The reply that was kept", 4);
  const spare = message("spare", "root", "assistant", "A reply nobody kept", 2);
  root.childrenIds = ["spare", "kept"];
  return {
    id: "c",
    source: "claude",
    sourceId: "c",
    title: "Branched",
    models: ["m"],
    params: {},
    currentId: "kept",
    messages: { root, spare, kept },
    tags: [],
    timestamp: 0,
    lastSyncedTimestamp: 0,
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
  };
}

describe("export options: allBranches", () => {
  it("is kept for the Markdown exporter and dropped for the others", () => {
    expect(getExporter("haevn_markdown").supportsAllBranches).toBe(true);

    const md = normalizeExportOptions({
      exporterId: "haevn_markdown",
      format: "markdown",
      allBranches: true,
    });
    expect(md.allBranches).toBe(true);

    for (const exporterId of ["haevn_json", "haevn_zip", "pi_session_jsonl"] as const) {
      expect(getExporter(exporterId).supportsAllBranches).toBe(false);
      const other = normalizeExportOptions({ exporterId, format: "json", allBranches: true });
      expect(other.allBranches).toBeUndefined();
    }
  });

  it("reaches the Markdown artifact: current branch by default, every branch when asked", async () => {
    const chat = branchedChat();
    const base = { exporterId: "haevn_markdown", format: "markdown" } as const;

    const current = await buildTextExportArtifact(chat, base);
    expect(current.content).toContain("The reply that was kept");
    expect(current.content).not.toContain("A reply nobody kept");

    const all = await buildTextExportArtifact(chat, { ...base, allBranches: true });
    expect(all.content).toContain("The reply that was kept");
    expect(all.content).toContain("## Branch 1: at message 1");
    expect(all.content.indexOf("A reply nobody kept")).toBeGreaterThan(
      all.content.indexOf("The reply that was kept"),
    );
  });

  it("does not change the JSON export, which keeps the whole tree", async () => {
    const chat = branchedChat();
    const artifact = await buildTextExportArtifact(chat, {
      exporterId: "haevn_json",
      format: "json",
      allBranches: true,
    });
    expect(Object.keys(JSON.parse(artifact.content).messages).sort()).toEqual([
      "kept",
      "root",
      "spare",
    ]);
  });
});
