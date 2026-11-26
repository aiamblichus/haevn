import { describe, expect, it, vi } from "vitest";
import {
  FRAGMENT_IMPORT_MAX_BYTES,
  type FragmentSource,
  gatherFragmentSources,
  overLimit,
  readFragmentFiles,
  sourceFromFolderPick,
  sourcesFromDrop,
} from "../src/options/import/fragmentFiles";

// HVN-163, slice 3: what the archive page reads, and what it counts and leaves. The rules are the
// CLI's (`collectFragmentFiles`): a folder is read flat, `.md` only, dot-files skipped and not
// counted, strict UTF-8 with the byte-order mark kept. tests/fragmentImportFiles.test.ts holds the
// two readers to the same text; this file holds what the page decides before it reads.

const file = (name: string, content: string | Uint8Array = "x") => new File([content], name);

/** A file that says it is this big, without being so */
function sized(name: string, bytes: number): File {
  const f = file(name);
  Object.defineProperty(f, "size", { value: bytes });
  return f;
}

const folder = (name: string, ...entries: (File | string)[]): FragmentSource => ({
  kind: "folder",
  name,
  entries: entries.map((e) => (typeof e === "string" ? { name: e } : { name: e.name, file: e })),
});

const loose = (f: File): FragmentSource => ({ kind: "file", file: f });

describe("every file has a name of its own (HVN-163, slice 3)", () => {
  it("calls the second of two dropped folders of one name by another, so no two rows are alike", () => {
    const gathered = gatherFragmentSources([
      folder("notes", file("1.md"), file("2.md")),
      folder("notes", file("1.md")),
    ]);

    expect(gathered.candidates.map((c) => c.name)).toEqual([
      "notes/1.md",
      "notes/2.md",
      "notes (2)/1.md",
    ]);
    expect(gathered.folders).toEqual(["notes", "notes (2)"]);
    expect(new Set(gathered.candidates.map((c) => c.name)).size).toBe(3);
  });

  it("calls the second of two loose files of one name by another, before its extension", () => {
    const gathered = gatherFragmentSources([
      loose(file("a.md")),
      loose(file("a.md")),
      loose(file("a.md")),
      loose(file("a (2).md")),
    ]);

    expect(gathered.candidates.map((c) => c.name)).toEqual([
      "a.md",
      "a (2).md",
      "a (3).md",
      "a (2) (2).md",
    ]);
  });

  it("leaves a name as it is when it is alone", () => {
    const gathered = gatherFragmentSources([folder("recovered", file("a.md"), file("b.md"))]);

    expect(gathered.candidates.map((c) => c.name)).toEqual(["a.md", "b.md"]);
  });
});

describe("gathering what was given (HVN-163, slice 3)", () => {
  it("reads a folder flat: its .md files in name order, any case, and counts the rest", () => {
    const gathered = gatherFragmentSources([
      folder(
        "recovered",
        file("b.md"),
        file("A.MD"),
        file("notes.txt"),
        file("image.png"),
        file(".hidden.md"),
        file(".DS_Store"),
        "inner",
        ".git",
      ),
    ]);

    expect(gathered.candidates.map((c) => c.name)).toEqual(["A.MD", "b.md"]);
    expect(gathered.notMarkdown).toBe(2); // notes.txt and image.png; dot-files are not counted
    expect(gathered.subfolders).toBe(1); // inner; a dot-folder is not counted either
    expect(gathered.folders).toEqual(["recovered"]);
  });

  it("names the loose files that are not .md, up to five", () => {
    const gathered = gatherFragmentSources([
      loose(file("a.md")),
      ...["1.txt", "2.txt", "3.txt", "4.txt", "5.txt", "6.txt", "7.txt"].map((n) => loose(file(n))),
    ]);

    expect(gathered.candidates.map((c) => c.name)).toEqual(["a.md"]);
    expect(gathered.notMarkdown).toBe(7);
    expect(gathered.notMarkdownNames).toEqual(["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"]);
    expect(gathered.looseFiles).toBe(8);
  });

  it("names a file by itself when everything came from one folder", () => {
    const gathered = gatherFragmentSources([folder("recovered", file("a.md"), file("b.md"))]);

    expect(gathered.candidates.map((c) => c.name)).toEqual(["a.md", "b.md"]);
  });

  it("puts the folder in the name when there are several folders, or a folder and loose files", () => {
    const several = gatherFragmentSources([
      folder("one", file("a.md")),
      folder("two", file("a.md")),
    ]);
    const mixed = gatherFragmentSources([folder("one", file("a.md")), loose(file("a.md"))]);

    expect(several.candidates.map((c) => c.name)).toEqual(["one/a.md", "two/a.md"]);
    expect(mixed.candidates.map((c) => c.name)).toEqual(["one/a.md", "a.md"]);
    expect(mixed.candidates.map((c) => c.folder)).toEqual(["one", undefined]);
  });

  it("finds nothing to read in an empty folder, or one of other files", () => {
    expect(gatherFragmentSources([folder("empty")]).candidates).toEqual([]);
    expect(gatherFragmentSources([folder("texts", file("a.txt"))])).toMatchObject({
      candidates: [],
      notMarkdown: 1,
    });
  });
});

describe("the limit of one import (HVN-163, slice 3)", () => {
  it("is 16 MiB of .md files together, read from their sizes", () => {
    const at = gatherFragmentSources([
      loose(sized("a.md", FRAGMENT_IMPORT_MAX_BYTES - 10)),
      loose(sized("b.md", 10)),
    ]);
    const over = gatherFragmentSources([
      loose(sized("a.md", FRAGMENT_IMPORT_MAX_BYTES - 10)),
      loose(sized("b.md", 11)),
    ]);

    expect(overLimit(at)).toBe(false);
    expect(overLimit(over)).toBe(true);
  });

  it("does not count the files it leaves out", () => {
    const gathered = gatherFragmentSources([
      loose(sized("a.md", 100)),
      loose(sized("huge.zip", FRAGMENT_IMPORT_MAX_BYTES * 4)),
    ]);

    expect(overLimit(gathered)).toBe(false);
    expect(gathered.totalBytes).toBe(100);
  });

  it("gathers without opening a file", () => {
    const f = file("a.md");
    const spy = vi.spyOn(f, "arrayBuffer");

    overLimit(gatherFragmentSources([loose(f)]));

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("reading the text (HVN-163, slice 3)", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("keeps the byte-order mark and every line ending, as the file has them", async () => {
    const text = "﻿---\r\nid: x\r\n---\r\nCafé\r\n";
    const gathered = gatherFragmentSources([loose(file("a.md", bytes(text)))]);

    const read = await readFragmentFiles(gathered);

    expect(read?.files).toEqual([{ name: "a.md", content: text }]);
  });

  it("refuses a file that is not UTF-8 as unreadable, and reads the others", async () => {
    const gathered = gatherFragmentSources([
      loose(file("good.md", bytes("fine"))),
      loose(file("latin1.md", Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))),
    ]);

    const read = await readFragmentFiles(gathered);

    expect(read?.files.map((f) => f.name)).toEqual(["good.md"]);
    expect(read?.refused).toEqual([
      { name: "latin1.md", state: "unreadable", message: "not valid UTF-8", warnings: [] },
    ]);
  });

  it("tells how many it has read, and stops when it is cancelled", async () => {
    const gathered = gatherFragmentSources(["a", "b", "c"].map((n) => loose(file(`${n}.md`))));
    const seen: number[] = [];
    let cancel = false;

    const read = await readFragmentFiles(gathered, {
      onProgress: (n) => {
        seen.push(n);
        if (n === 2) cancel = true;
      },
      isCancelled: () => cancel,
    });

    expect(read).toBeUndefined();
    expect(seen).toEqual([1, 2]);
  });
});

describe("a folder chosen with the picker (HVN-163, slice 3)", () => {
  const picked = (path: string) => {
    const f = file(path.split("/").pop() ?? path);
    Object.defineProperty(f, "webkitRelativePath", { value: path });
    return f;
  };

  it("reads the files directly in the folder, and says there is a folder inside", () => {
    const source = sourceFromFolderPick([
      picked("recovered/b.md"),
      picked("recovered/a.md"),
      picked("recovered/inner/c.md"),
      picked("recovered/inner/d.md"),
      picked("recovered/notes.txt"),
    ]);

    const gathered = gatherFragmentSources(source ? [source] : []);

    expect(gathered.candidates.map((c) => c.name)).toEqual(["a.md", "b.md"]);
    expect(gathered.subfolders).toBe(1); // inner, however many files it holds
    expect(gathered.notMarkdown).toBe(1);
    expect(gathered.folders).toEqual(["recovered"]);
  });

  it("has no source when the browser gave no folder", () => {
    expect(sourceFromFolderPick([])).toBeUndefined();
  });
});

describe("a drop (HVN-163, slice 3)", () => {
  /** A directory entry that answers `readEntries` in batches, ending with an empty one */
  function directory(name: string, children: FileSystemEntry[], batch = 2): FileSystemEntry {
    return {
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => {
        let at = 0;
        return {
          readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
            const slice = children.slice(at, at + batch);
            at += batch;
            ok(slice);
          },
        };
      },
    } as unknown as FileSystemEntry;
  }
  const fileEntry = (f: File): FileSystemEntry =>
    ({
      name: f.name,
      isDirectory: false,
      isFile: true,
      file: (ok: (file: File) => void) => ok(f),
    }) as unknown as FileSystemEntry;

  it("lists a dropped folder through every batch the browser gives, one level deep", async () => {
    const children = [
      fileEntry(file("a.md")),
      fileEntry(file("b.md")),
      fileEntry(file("c.md")),
      fileEntry(file("notes.txt")),
      directory("inner", []),
    ];

    const sources = await sourcesFromDrop([
      { file: null, entry: directory("recovered", children) },
      { file: file("loose.md"), entry: fileEntry(file("loose.md")) },
    ]);
    const gathered = gatherFragmentSources(sources);

    expect(gathered.candidates.map((c) => c.name)).toEqual([
      "recovered/a.md",
      "recovered/b.md",
      "recovered/c.md",
      "loose.md",
    ]);
    expect(gathered.notMarkdown).toBe(1);
    expect(gathered.subfolders).toBe(1);
  });
});
