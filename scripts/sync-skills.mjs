// Regenerates skills/ from the knowledge base. The KB note is the source and the
// file under skills/ is a copy: edit the note, then run `pnpm run skills:sync`.
// `--check` writes nothing and exits 1 when a file would change.
//
// The manifest is skills/sync.json. Notes are read with the gnomon CLI in the
// caller's environment, so the caller's GNOMON_PROFILE decides what can be read.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "skills", "sync.json");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  throw new Error(message);
}

// gnomon answers --json with one document; an error is {"ok":false,"error":{...}}
// on stdout, and a missing binary is ENOENT.
function readNote(note) {
  let stdout;
  try {
    stdout = execFileSync("gnomon", ["note", "read", note, "--json"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("gnomon is not on PATH; the skills are generated from the KB and need it");
    }
    fail(`cannot read ${note}: ${explain(error.stdout, error.stderr)}`);
  }
  const doc = JSON.parse(stdout);
  if (!doc.ok) fail(`cannot read ${note}: ${explain(stdout)}`);
  return doc.data;
}

function explain(stdout, stderr) {
  try {
    const doc = JSON.parse(stdout);
    if (doc.error) return [doc.error.message, doc.error.hint].filter(Boolean).join(" ");
  } catch {
    // not a JSON document: fall through to the raw text
  }
  return String(stderr || stdout || "no output").trim();
}

function loadManifest() {
  const entries = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of entries) {
    if (!entry.note || !entry.file || typeof entry.frontmatter !== "boolean") {
      fail(`bad entry in skills/sync.json: ${JSON.stringify(entry)}`);
    }
    if (entry.frontmatter && !entry.name) {
      fail(`entry for ${entry.note} has frontmatter but no name`);
    }
  }
  return entries;
}

// A plain YAML scalar would be misread with a colon, a comment, a line break,
// or a leading backtick; a JSON string is a valid double-quoted YAML scalar.
function yamlValue(text) {
  const plain = !text.includes(":") && !text.includes("\n") && !text.includes(" #");
  return plain && !text.startsWith("`") ? text : JSON.stringify(text);
}

function render(entry, note) {
  const header = entry.frontmatter
    ? `---\nname: ${entry.name}\ndescription: ${yamlValue(note.summary)}\n---\n\n`
    : "";
  const generated = `<!-- generated from ${entry.note} by pnpm run skills:sync; edit the KB note, not this file -->`;
  const body = note.body.endsWith("\n") ? note.body : `${note.body}\n`;
  return `${header}${generated}\n${body}`;
}

function main() {
  // Read every note before writing anything, so a missing note leaves skills/ as it was.
  const outputs = loadManifest().map((entry) => {
    const note = readNote(entry.note);
    if (typeof note.body !== "string") fail(`${entry.note} has no body`);
    if (entry.frontmatter && !note.summary) {
      fail(`${entry.note} has no summary; the frontmatter description comes from it`);
    }
    return { entry, path: join(root, "skills", entry.file), text: render(entry, note) };
  });

  if (checkOnly) {
    const stale = outputs.filter(
      ({ path, text }) => !existsSync(path) || readFileSync(path, "utf8") !== text,
    );
    if (stale.length === 0) {
      process.stdout.write(`skills are up to date (${outputs.length} files)\n`);
      return 0;
    }
    for (const { path } of stale) {
      process.stdout.write(`out of date: ${relative(root, path)}\n`);
    }
    process.stdout.write("run pnpm run skills:sync and commit the result\n");
    return 1;
  }

  for (const { entry, path, text } of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    process.stdout.write(`wrote ${relative(root, path)} from ${entry.note}\n`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`sync-skills: ${error.message}\n`);
  process.exitCode = 1;
}
