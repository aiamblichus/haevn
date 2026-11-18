import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A listener that returns a Promise answers every message on the channel, with null, before the
// service worker can answer (HVN-67). A listener answers by calling sendResponse and returning
// true. This guard reads the return type the checker infers for each listener, so it sees an
// `async` arrow, a named async function and a `.then` chain alike.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADD_LISTENER = "chrome.runtime.onMessage.addListener";
// The service-worker router is the one listener that may answer asynchronously through the channel.
const ROUTER = join(ROOT, "src/background/background.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The files under src/ that add a listener, except the router. */
function listenerSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    if (file === ROUTER) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(ADD_LISTENER)) sources.set(file, text);
  }
  return sources;
}

function returnsPromise(checker: ts.TypeChecker, listener: ts.Expression): boolean {
  const isPromise = (type: ts.Type): boolean =>
    type.isUnion() ? type.types.some(isPromise) : type.getSymbol()?.getName() === "Promise";
  return checker
    .getTypeAtLocation(listener)
    .getCallSignatures()
    .some((signature) => isPromise(checker.getReturnTypeOfSignature(signature)));
}

/**
 * The `file:line` of each `chrome.runtime.onMessage.addListener` in `sources` whose listener
 * returns a Promise. `sources` maps absolute paths to their text; everything they import, and
 * Chrome's types, is read from disk.
 */
function promiseListeners(sources: Map<string, string>): string[] {
  const configPath = join(ROOT, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    typeRoots: [join(ROOT, "node_modules/@types")],
  };

  const host = ts.createCompilerHost(options);
  const readFromDisk = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = sources.get(fileName);
    return text === undefined
      ? readFromDisk(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };

  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();

  const found: string[] = [];
  for (const fileName of sources.keys()) {
    const file = program.getSourceFile(fileName);
    if (!file) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file) === ADD_LISTENER &&
        node.arguments[0] &&
        returnsPromise(checker, node.arguments[0])
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        found.push(`${relative(ROOT, fileName)}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

const FIXTURE = join(ROOT, "tests/fixtures/listener.ts");
const fixture = (text: string) => new Map([[FIXTURE, text]]);

describe("message channel guard", () => {
  it("no onMessage listener outside the service-worker router returns a Promise", () => {
    const sources = listenerSources();
    // The counter first: a guard that read no listener would pass without checking any.
    expect(sources.size, "files that add a listener").toBeGreaterThan(0);
    expect(promiseListeners(sources), "listeners that return a Promise").toEqual([]);
  }, 120_000);

  it("flags an async listener", () => {
    expect(
      promiseListeners(
        fixture(
          [
            "chrome.runtime.onMessage.addListener(async (message) => {",
            "  return { ok: message !== undefined };",
            "});",
          ].join("\n"),
        ),
      ),
    ).toEqual(["tests/fixtures/listener.ts:1"]);
  }, 120_000);

  it("flags a listener that returns a Promise from a named function", () => {
    expect(
      promiseListeners(
        fixture(
          [
            "async function reply(message: unknown): Promise<void> {",
            "  void message;",
            "}",
            "chrome.runtime.onMessage.addListener((message) => reply(message));",
          ].join("\n"),
        ),
      ),
    ).toEqual(["tests/fixtures/listener.ts:4"]);
  }, 120_000);

  it("passes a listener that answers through sendResponse and returns true", () => {
    expect(
      promiseListeners(
        fixture(
          [
            "async function reply(message: unknown): Promise<unknown> {",
            "  return message;",
            "}",
            "chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {",
            "  void reply(message).then(sendResponse);",
            "  return true;",
            "});",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  }, 120_000);

  it("passes a listener that returns nothing", () => {
    expect(
      promiseListeners(
        fixture(
          ["chrome.runtime.onMessage.addListener((message) => {", "  void message;", "});"].join(
            "\n",
          ),
        ),
      ),
    ).toEqual([]);
  }, 120_000);
});
