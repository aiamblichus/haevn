import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { getProvider } from "../src/providers/provider";
import { mediaWorld, untilSettled, WITH_MEDIA } from "./helpers/mediaSpies";

// `transform(raw, tabId, { media: "skip" })` (HVN-107): a transformer that would download an asset
// and write it to OPFS takes its URL-fallback branch instead. The spies below see every way a
// download or a write could leave; the CONTROL case runs the same payload without the switch and
// shows the same spies do see it, so a silent spy cannot pass for a clean transform.

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const world = mediaWorld();
const touches = () => world.touches();
const fs = {
  files: () => world.fs.files(),
  dirs: () => world.fs.dirs(),
};

describe("a transform with media skipped touches nothing", () => {
  for (const name of Object.keys(WITH_MEDIA)) {
    it(`${name}: no download, no tab message, no OPFS, and the image stays a link`, async () => {
      const provider = getProvider(name);
      const raw = WITH_MEDIA[name]();
      const chats = await provider?.transformer.transform(raw, undefined, { media: "skip" });
      expect(touches()).toBe(0);
      expect(fs.files()).toEqual([]);
      expect(fs.dirs()).toEqual([]);
      // the image is there, as a URL part, which is what the ruler then looks at
      expect(JSON.stringify(chats)).toContain('"kind":"image-url"');
    });

    it(`${name}: CONTROL: the same payload without the switch does reach for the media`, async () => {
      // a download that fails is retried after a pause; the clock is the test's
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const provider = getProvider(name);
      const raw = WITH_MEDIA[name]();
      // a tab id too, so the providers that delegate to a content script do
      await untilSettled(provider?.transformer.transform(raw, 7, {}) as Promise<unknown>);
      expect(
        touches(),
        `${name} never touched media without the switch; the spies are blind`,
      ).toBeGreaterThan(0);
    });
  }

  it("every transformer that downloads is covered by this table", () => {
    const writers = transformerFiles()
      .filter((file) => readFileSync(file, "utf8").includes("processExternalAssets("))
      .map((file) => file.split("/").slice(-2)[0])
      .sort();
    expect(writers).toEqual(Object.keys(WITH_MEDIA).sort());
  });

  it("every call to processExternalAssets in a transformer passes the switch on", () => {
    for (const file of transformerFiles()) {
      const text = readFileSync(file, "utf8");
      const calls = [...text.matchAll(/processExternalAssets\(\s*\w+,\s*\{([\s\S]*?)\n\s*\}\)/g)];
      for (const [, body] of calls) {
        expect(body, `${file} drops options.media`).toMatch(/media:\s*(options|opts)\?\.media/);
      }
    }
  });
});

function transformerFiles(): string[] {
  const root = fileURLToPath(new URL("../src/providers", import.meta.url));
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name, "transformer.ts"))
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    });
}
