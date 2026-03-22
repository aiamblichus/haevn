import type {
  Entry,
  EntryGetDataOptions,
  FileEntry,
  ZipReaderConstructorOptions,
} from "@zip.js/zip.js";
import {
  BlobReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";

export type ZipInput = File | ArrayBuffer;

const DEFAULT_READER_OPTIONS: ZipReaderConstructorOptions = {
  useWebWorkers: false,
};

const DEFAULT_ENTRY_OPTIONS: EntryGetDataOptions = {
  useWebWorkers: false,
};

export function createZipReader(
  input: ZipInput,
  options?: ZipReaderConstructorOptions,
): ZipReader<BlobReader | Uint8ArrayReader> {
  const reader =
    input instanceof File ? new BlobReader(input) : new Uint8ArrayReader(new Uint8Array(input));
  return new ZipReader(reader, { ...DEFAULT_READER_OPTIONS, ...options });
}

export function isFileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory;
}

export async function readEntryText(entry: Entry, options?: EntryGetDataOptions): Promise<string> {
  if (!isFileEntry(entry)) {
    throw new Error(`Cannot read directory entry: ${entry.filename}`);
  }
  return entry.getData(new TextWriter(), { ...DEFAULT_ENTRY_OPTIONS, ...options });
}

export async function readEntryArrayBuffer(
  entry: Entry,
  options?: EntryGetDataOptions,
): Promise<ArrayBuffer> {
  if (!isFileEntry(entry)) {
    throw new Error(`Cannot read directory entry: ${entry.filename}`);
  }
  const data = await entry.getData(new Uint8ArrayWriter(), {
    ...DEFAULT_ENTRY_OPTIONS,
    ...options,
  });
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}
