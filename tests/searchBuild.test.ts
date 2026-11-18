import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchIndex, resetMemorySqliteHost } from "../src/services/searchIndex";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildQueryPlan } from "../src/services/searchWorkerQuery";

const repo = resolve(__dirname, "..");

describe("the search index's build (HVN-87)", () => {
  let scratch: string;
  let dist: string;

  // Run the build's copy step the way `pnpm run build` does, in a folder of its own, so that
  // the test reads what the step writes and leaves the repository's `dist/` alone.
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "haevn-copy-static-"));
    symlinkSync(join(repo, "src"), join(scratch, "src"));
    symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
    execFileSync(process.execPath, [join(repo, "scripts/copy-static.js")], { cwd: scratch });
    dist = join(scratch, "dist");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("puts SQLite's WebAssembly module in dist, where the worker looks for it", () => {
    const file = join(dist, "sqlite3.wasm");

    expect(existsSync(file)).toBe(true);
    expect(WebAssembly.validate(readFileSync(file))).toBe(true);
  });

  it("lets extension pages compile WebAssembly, and nothing else (no eval)", () => {
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
    const policy: string = manifest.content_security_policy.extension_pages;

    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).not.toMatch(/'unsafe-eval'|'unsafe-inline'/);
    expect(policy).toContain("script-src 'self'");
  });

  it("opens SQLite with FTS5 in it, as the worker does at init", async () => {
    resetMemorySqliteHost();
    const index = createSearchIndex();

    expect(await index.open()).toBe(false); // nothing stored yet
    const build = index.beginRebuild();
    build.put({
      id: "c",
      title: "",
      source: "test",
      timestamp: 1,
      messages: [{ id: "m", role: "user", text: "a pineapple" }],
    });
    build.commit();

    expect(index.describe()).toMatch(/^SQLite 3\.\d+\.\d+/);
    expect(index.search(buildQueryPlan(parseSearchQuery("pineapple")))).toHaveLength(1);
    index.close();
  });
});
