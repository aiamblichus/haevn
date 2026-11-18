/**
 * An in-memory Origin Private File System for tests: the directory and file handles the code under
 * test reaches through `navigator.storage.getDirectory()`, with the failures a test needs to make
 * on purpose.
 *
 * The code runs against it unchanged (`src/utils/opfs.ts`, `mediaStorage`, the media sweep), so a
 * test sees the names, the sizes and the modification times that code would see.
 */

import { vi } from "vitest";

interface FileNode {
  kind: "file";
  data: Uint8Array;
  lastModified: number;
}

interface DirNode {
  kind: "directory";
  children: Map<string, FileNode | DirNode>;
}

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  throw new Error("fakeOpfs: cannot write this kind of data");
}

export interface FakeOpfsFailures {
  /** The sync handle's write throws after this many bytes (0 writes nothing). */
  syncWriteThrows?: boolean;
  /** The sync handle's write reports fewer bytes than it was given. */
  syncWriteShort?: boolean;
  /** `createWritable().write()` throws. */
  writableWriteThrows?: boolean;
  /** `removeEntry` of these names (the last path segment) throws a non-NotFound error. */
  removeEntryThrows?: Set<string>;
}

export class FakeOpfs {
  private readonly rootNode: DirNode = { kind: "directory", children: new Map() };
  failures: FakeOpfsFailures = {};
  /** Sync access handles opened and closed, and writables closed and aborted. */
  counts = { syncOpened: 0, syncClosed: 0, writableClosed: 0, writableAborted: 0 };
  /** Names of entries `removeEntry` was asked to remove, in order. */
  removed: string[] = [];

  /**
   * Makes `navigator.storage.getDirectory()` answer with this file system. `extra` adds other
   * members to the stubbed `navigator` (`locks`, for one).
   */
  install(extra: Record<string, unknown> = {}): void {
    vi.stubGlobal("navigator", {
      ...extra,
      storage: { getDirectory: async () => this.dirHandle(this.rootNode, "") },
    });
  }

  // ---- seeding and reading, by path ------------------------------------------------------

  /** Writes a file (and the directories above it) with a modification time. */
  put(path: string, data: string | Uint8Array = "x", lastModified: number = Date.now()): void {
    const segments = path.split("/").filter(Boolean);
    const name = segments.pop() as string;
    this.ensureDir(segments).children.set(name, {
      kind: "file",
      data: toBytes(data),
      lastModified,
    });
  }

  /** Makes an empty directory. */
  mkdir(path: string): void {
    this.ensureDir(path.split("/").filter(Boolean));
  }

  private ensureDir(segments: string[]): DirNode {
    let dir = this.rootNode;
    for (const segment of segments) {
      let next = dir.children.get(segment);
      if (!next) {
        next = { kind: "directory", children: new Map() };
        dir.children.set(segment, next);
      }
      if (next.kind !== "directory") throw new Error(`fakeOpfs: ${segment} is a file`);
      dir = next;
    }
    return dir;
  }

  setLastModified(path: string, lastModified: number): void {
    const node = this.node(path);
    if (!node || node.kind !== "file") throw new Error(`fakeOpfs: no file ${path}`);
    node.lastModified = lastModified;
  }

  has(path: string): boolean {
    return this.node(path) !== null;
  }

  size(path: string): number | null {
    const node = this.node(path);
    return node && node.kind === "file" ? node.data.byteLength : null;
  }

  text(path: string): string | null {
    const node = this.node(path);
    return node && node.kind === "file" ? new TextDecoder().decode(node.data) : null;
  }

  /** Every file path under `prefix` ("" for all), sorted. */
  files(prefix = ""): string[] {
    const out: string[] = [];
    const walk = (dir: DirNode, base: string) => {
      for (const [name, child] of dir.children) {
        const path = base ? `${base}/${name}` : name;
        if (child.kind === "file") out.push(path);
        else walk(child, path);
      }
    };
    walk(this.rootNode, "");
    const wanted = prefix.split("/").filter(Boolean).join("/");
    return out.filter((p) => !wanted || p === wanted || p.startsWith(`${wanted}/`)).sort();
  }

  /** The names of the directories directly under `path`. */
  dirs(path = ""): string[] {
    const node = path ? this.node(path) : this.rootNode;
    if (!node || node.kind !== "directory") return [];
    return [...node.children]
      .filter(([, c]) => c.kind === "directory")
      .map(([n]) => n)
      .sort();
  }

  private node(path: string): FileNode | DirNode | null {
    let current: FileNode | DirNode = this.rootNode;
    for (const segment of path.split("/").filter(Boolean)) {
      if (current.kind !== "directory") return null;
      const next: FileNode | DirNode | undefined = current.children.get(segment);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  // ---- the handles ----------------------------------------------------------------------

  private dirHandle(node: DirNode, name: string): FileSystemDirectoryHandle {
    const self = this;
    const handle = {
      kind: "directory" as const,
      name,
      async getDirectoryHandle(child: string, options?: { create?: boolean }) {
        let next = node.children.get(child);
        if (!next) {
          if (!options?.create) throw domError("NotFoundError", `no directory ${child}`);
          next = { kind: "directory", children: new Map() };
          node.children.set(child, next);
        }
        if (next.kind !== "directory") throw domError("TypeMismatchError");
        return self.dirHandle(next, child);
      },
      async getFileHandle(child: string, options?: { create?: boolean }) {
        let next = node.children.get(child);
        if (!next) {
          if (!options?.create) throw domError("NotFoundError", `no file ${child}`);
          next = { kind: "file", data: new Uint8Array(0), lastModified: Date.now() };
          node.children.set(child, next);
        }
        if (next.kind !== "file") throw domError("TypeMismatchError");
        return self.fileHandle(next, child);
      },
      async removeEntry(child: string, options?: { recursive?: boolean }) {
        if (self.failures.removeEntryThrows?.has(child)) {
          throw domError("NoModificationAllowedError", `locked ${child}`);
        }
        const target = node.children.get(child);
        if (!target) throw domError("NotFoundError", `no entry ${child}`);
        if (target.kind === "directory" && target.children.size > 0 && !options?.recursive) {
          throw domError("InvalidModificationError", `${child} is not empty`);
        }
        node.children.delete(child);
        self.removed.push(child);
      },
      async *entries() {
        for (const [childName, child] of [...node.children]) {
          yield [
            childName,
            child.kind === "file"
              ? self.fileHandle(child, childName)
              : self.dirHandle(child, childName),
          ] as const;
        }
      },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }

  private fileHandle(node: FileNode, name: string): FileSystemFileHandle {
    const self = this;
    let syncOpen = false;
    const handle = {
      kind: "file" as const,
      name,
      async getFile() {
        return new File([node.data.slice()], name, { lastModified: node.lastModified });
      },
      async createWritable() {
        let pending = node.data.slice();
        let done = false;
        return {
          async write(chunk: unknown) {
            if (self.failures.writableWriteThrows) throw domError("QuotaExceededError");
            pending = toBytes(chunk);
          },
          async close() {
            if (done) throw new TypeError("stream is closed");
            done = true;
            node.data = pending;
            node.lastModified = Date.now();
            self.counts.writableClosed += 1;
          },
          async abort() {
            if (done) throw new TypeError("stream is closed");
            done = true;
            self.counts.writableAborted += 1;
          },
        };
      },
      async createSyncAccessHandle() {
        if (syncOpen) throw domError("NoModificationAllowedError", "a sync handle is open");
        syncOpen = true;
        self.counts.syncOpened += 1;
        return {
          truncate(size: number) {
            node.data = node.data.slice(0, size);
          },
          write(buffer: Uint8Array, options?: { at?: number }) {
            if (self.failures.syncWriteThrows) throw domError("QuotaExceededError");
            const bytes = self.failures.syncWriteShort
              ? buffer.slice(0, buffer.byteLength - 1)
              : buffer;
            const at = options?.at ?? 0;
            const next = new Uint8Array(Math.max(node.data.byteLength, at + bytes.byteLength));
            next.set(node.data);
            next.set(bytes, at);
            node.data = next;
            node.lastModified = Date.now();
            return bytes.byteLength;
          },
          flush() {},
          getSize: () => node.data.byteLength,
          close() {
            syncOpen = false;
            self.counts.syncClosed += 1;
          },
        };
      },
    };
    return handle as unknown as FileSystemFileHandle;
  }
}
