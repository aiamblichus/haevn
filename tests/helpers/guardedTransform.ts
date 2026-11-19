/**
 * Runs the OpenRouter room transform in a child process with a time limit.
 *
 * A transform that loops forever blocks the thread it runs on, so a vitest timeout cannot stop
 * it: the run would hang. In a child process the limit kills the loop, and the test fails.
 */

import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRouterRoom } from "../../src/providers/openrouter/model";

export interface GuardedResult {
  /** True when the child did not finish within the limit. */
  hung: boolean;
  /** The chat, reduced to what the tree tests read. Absent when the transform threw or hung. */
  chat?: {
    id: string;
    currentId: string;
    messages: Array<{ id: string; parentId?: string; childrenIds: string[] }>;
  };
  /** The error message when the transform threw. */
  error?: string;
}

const RUNNER = `
const fs = require("node:fs");
const { transformOpenRouterRoomToHaevnChat } = require(process.argv[2]);
const room = JSON.parse(fs.readFileSync(0, "utf8"));
try {
  const chat = transformOpenRouterRoomToHaevnChat(room);
  console.log(JSON.stringify({
    id: chat.id,
    currentId: chat.currentId,
    messages: Object.values(chat.messages).map((m) => ({
      id: m.id, parentId: m.parentId, childrenIds: m.childrenIds,
    })),
  }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error && error.message) }));
}
`;

export function createGuardedTransform(limitMs = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), "haevn-openrouter-"));
  const bundle = join(dir, "transformer.cjs");
  const runner = join(dir, "run.cjs");
  buildSync({
    entryPoints: [join(__dirname, "../../src/providers/openrouter/transformer.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
  });
  writeFileSync(runner, RUNNER);

  return {
    run(room: OpenRouterRoom): GuardedResult {
      const child = spawnSync(process.execPath, [runner, bundle], {
        input: JSON.stringify(room),
        timeout: limitMs,
        encoding: "utf8",
      });
      if (child.error || child.signal || child.status !== 0) return { hung: true };
      const parsed = JSON.parse(child.stdout);
      return parsed.error ? { hung: false, error: parsed.error } : { hung: false, chat: parsed };
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
