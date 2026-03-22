/**
 * Helpers for working with the Origin Private File System (OPFS)
 *
 * Used for:
 * - Media storage (images, videos, documents) with high-performance writes
 * - Import staging to avoid chrome.runtime messaging limits
 * - Large file handling without memory exhaustion
 *
 * Key Features:
 * - Synchronous writes in Web Workers via SyncAccessHandle (10-100x faster)
 * - Asynchronous writes in main thread contexts
 * - Automatic directory creation
 * - Comprehensive file/directory management
 */

import { log } from "./logger";

const PATH_SEPARATOR = "/";

function assertOpfsSupport(): void {
  if (typeof navigator === "undefined") {
    throw new Error("Navigator is not available in this context");
  }
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    throw new Error("Origin Private File System not supported in this context");
  }
}

async function getRootDirectory(): Promise<FileSystemDirectoryHandle> {
  assertOpfsSupport();
  return navigator.storage.getDirectory?.();
}

/**
 * Get the root directory handle for OPFS (public API)
 */
export async function getOPFSRoot(): Promise<FileSystemDirectoryHandle> {
  return getRootDirectory();
}

function splitPath(path: string): string[] {
  return path
    .split(PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

async function getDirectoryHandleForPath(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    try {
      current = await current.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (!create) {
        throw error;
      }
      throw error;
    }
  }
  return current;
}

function separateDirAndFile(path: string): {
  dirSegments: string[];
  fileName: string;
} {
  const segments = splitPath(path);
  if (segments.length === 0) {
    throw new Error("Invalid OPFS path");
  }
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error("Invalid OPFS path: no filename");
  }
  return { dirSegments: segments, fileName };
}

export async function writeFileToOpfs(path: string, data: Blob | ArrayBuffer): Promise<void> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);
  const directory = await getDirectoryHandleForPath(root, dirSegments, true);
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  if (data instanceof Blob) {
    await writable.write(data);
  } else {
    await writable.write(data);
  }
  await writable.close();
}

export async function readFileFromOpfs(path: string): Promise<File> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);
  const directory = await getDirectoryHandleForPath(root, dirSegments, false);
  const fileHandle = await directory.getFileHandle(fileName, { create: false });
  return fileHandle.getFile();
}

export async function deleteFileFromOpfs(path: string): Promise<void> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);
  const directory = await getDirectoryHandleForPath(root, dirSegments, false);
  await directory.removeEntry(fileName, { recursive: false }).catch((error) => {
    // Ignore missing file errors
    if ((error as DOMException).name !== "NotFoundError") {
      throw error;
    }
  });
}

// =============================================================================
// Enhanced OPFS Utilities for Media Storage
// =============================================================================

/**
 * Write data to a file in OPFS with optional high-performance sync writes
 *
 * Uses SyncAccessHandle in Web Workers for maximum performance (10-100x faster).
 * Falls back to async write in main thread contexts.
 *
 * @param path - Full file path (e.g., "media/chat123/msg456_0.jpg")
 * @param data - Data to write (Blob, ArrayBuffer, or Uint8Array)
 * @param useSyncHandle - Force sync handle usage (only in Workers, will throw in main thread)
 * @returns The file path that was written
 */
export async function writeFile(
  path: string,
  data: Blob | ArrayBuffer | Uint8Array,
  useSyncHandle = false,
): Promise<string> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);

  // Ensure directory exists
  const directory = await getDirectoryHandleForPath(root, dirSegments, true);

  // Get file handle
  const fileHandle = await directory.getFileHandle(fileName, { create: true });

  // Convert data to appropriate format
  let buffer: ArrayBuffer;
  if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof ArrayBuffer) {
    buffer = data;
  } else {
    // Uint8Array.buffer is ArrayBufferLike (could be SharedArrayBuffer)
    // Convert to ArrayBuffer by creating a new view
    const uint8Array = new Uint8Array(data);
    buffer = uint8Array.buffer.slice(0);
  }

  // Try sync handle (Web Worker context only)
  // Check if we're in a Web Worker by checking if self is defined and not a Window
  const isWorkerContext =
    typeof self !== "undefined" &&
    typeof Window === "undefined" &&
    !("window" in self) &&
    "importScripts" in self;

  if (useSyncHandle || isWorkerContext) {
    try {
      // @ts-expect-error - createSyncAccessHandle is not in all TS libs yet
      const accessHandle = await fileHandle.createSyncAccessHandle();
      const writeBuffer = new Uint8Array(buffer);

      // Synchronous write (blazing fast!)
      accessHandle.truncate(0); // Clear file first
      accessHandle.write(writeBuffer, { at: 0 });
      accessHandle.flush();
      accessHandle.close();

      return path;
    } catch (error) {
      // Fall back to async if sync fails
      log.warn("[OPFS] Sync write failed, falling back to async:", error);
    }
  }

  // Async write (main thread or fallback)
  const writable = await fileHandle.createWritable();
  await writable.write(buffer);
  await writable.close();

  return path;
}

/**
 * Read a file from OPFS and return as ArrayBuffer
 *
 * @param path - Full file path
 * @returns ArrayBuffer containing file data
 * @throws Error if file doesn't exist
 */
export async function readFile(path: string): Promise<ArrayBuffer> {
  const file = await readFileFromOpfs(path);
  return await file.arrayBuffer();
}

/**
 * Get a file handle from OPFS
 *
 * This is lightweight - it doesn't load the file content into memory.
 * Use this when you need to stream data or get metadata.
 *
 * @param path - Full file path
 * @returns FileSystemFileHandle or null if file doesn't exist
 */
export async function getFileHandle(path: string): Promise<FileSystemFileHandle | null> {
  try {
    const root = await getRootDirectory();
    const { dirSegments, fileName } = separateDirAndFile(path);
    const directory = await getDirectoryHandleForPath(root, dirSegments, false);
    return await directory.getFileHandle(fileName);
  } catch (_error) {
    // File doesn't exist
    return null;
  }
}

/**
 * Create or open a writable file stream in OPFS, ensuring directories exist.
 */
export async function createWritableStream(path: string): Promise<FileSystemWritableFileStream> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);
  const directory = await getDirectoryHandleForPath(root, dirSegments, true);
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  return fileHandle.createWritable();
}

/**
 * Get a File object from OPFS (for creating blob URLs)
 *
 * @param path - Full file path
 * @returns File object or null if file doesn't exist
 */
export async function getFile(path: string): Promise<File | null> {
  const handle = await getFileHandle(path);
  if (!handle) return null;

  return await handle.getFile();
}

/**
 * Append UTF-8 text to a file in OPFS, creating it if missing.
 */
export async function appendTextFile(path: string, text: string): Promise<void> {
  const root = await getRootDirectory();
  const { dirSegments, fileName } = separateDirAndFile(path);
  const directory = await getDirectoryHandleForPath(root, dirSegments, true);
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const file = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.seek(file.size);
  await writable.write(text);
  await writable.close();
}

/**
 * Delete a file from OPFS
 *
 * @param path - Full file path
 * @returns true if deleted, false if file didn't exist
 */
export async function deleteFile(path: string): Promise<boolean> {
  try {
    await deleteFileFromOpfs(path);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Recursively delete a directory and all its contents
 *
 * @param path - Directory path to delete
 * @returns true if deleted, false if directory didn't exist
 */
export async function deleteDirectory(path: string): Promise<boolean> {
  try {
    const segments = splitPath(path);

    if (segments.length === 0) {
      throw new Error("Cannot delete root directory");
    }

    const root = await getRootDirectory();

    // Navigate to parent directory
    const parentSegments = segments.slice(0, -1);
    const targetDirName = segments[segments.length - 1];

    const parentDir =
      parentSegments.length > 0
        ? await getDirectoryHandleForPath(root, parentSegments, false)
        : root;

    // Delete the target directory recursively
    await parentDir.removeEntry(targetDirName, { recursive: true });

    return true;
  } catch (_error) {
    // Directory doesn't exist or other error
    return false;
  }
}

/**
 * Ensure a directory path exists, creating intermediate directories as needed
 *
 * @param path - Directory path (e.g., "media/chat123")
 * @returns The directory handle for the final directory
 */
export async function ensureDirectory(path: string): Promise<FileSystemDirectoryHandle> {
  const root = await getRootDirectory();
  const segments = splitPath(path);

  if (segments.length === 0) {
    return root;
  }

  return await getDirectoryHandleForPath(root, segments, true);
}

/**
 * List all files in a directory
 *
 * @param dirPath - Directory path (empty string for root)
 * @returns Array of filenames (not full paths)
 */
export async function listFiles(dirPath: string = ""): Promise<string[]> {
  try {
    const root = await getRootDirectory();
    const segments = splitPath(dirPath);
    const dir = segments.length > 0 ? await getDirectoryHandleForPath(root, segments, false) : root;

    const files: string[] = [];

    // @ts-expect-error - AsyncIterator types
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") {
        files.push(name);
      }
    }

    return files;
  } catch (_error) {
    // Directory doesn't exist
    return [];
  }
}

/**
 * List all subdirectories in a directory
 *
 * @param dirPath - Directory path (empty string for root)
 * @returns Array of directory names (not full paths)
 */
export async function listDirectories(dirPath: string = ""): Promise<string[]> {
  try {
    const root = await getRootDirectory();
    const segments = splitPath(dirPath);
    const dir = segments.length > 0 ? await getDirectoryHandleForPath(root, segments, false) : root;

    const directories: string[] = [];

    // @ts-expect-error - AsyncIterator types
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        directories.push(name);
      }
    }

    return directories;
  } catch (_error) {
    // Directory doesn't exist
    return [];
  }
}

/**
 * Check if a file exists in OPFS
 *
 * @param path - Full file path
 * @returns true if file exists, false otherwise
 */
export async function fileExists(path: string): Promise<boolean> {
  const handle = await getFileHandle(path);
  return handle !== null;
}

/**
 * Get file metadata (size, last modified)
 *
 * @param path - Full file path
 * @returns Metadata object or null if file doesn't exist
 */
export async function getFileMetadata(
  path: string,
): Promise<{ size: number; lastModified: number } | null> {
  const file = await getFile(path);
  if (!file) return null;

  return {
    size: file.size,
    lastModified: file.lastModified,
  };
}

// =============================================================================
// Import Staging (Existing Functionality)
// =============================================================================

export function buildImportStagingPath(originalName: string): string {
  const safeName = originalName.replace(/[\\/:*?"<>|]/g, "_");
  const uniqueSuffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `import-staging/${Date.now()}-${uniqueSuffix}-${safeName}`;
}
