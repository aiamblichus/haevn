/**
 * Browser API type extensions for APIs that may not be in all environments
 */

/**
 * Window interface extension for requestIdleCallback API
 */
export interface WindowWithIdleCallback extends Window {
  requestIdleCallback(
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout?: number },
  ): number;
  cancelIdleCallback(handle: number): void;
}

/**
 * Window interface extension for File System Access API
 */
export interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker(options?: {
    mode?: "read" | "readwrite";
    startIn?:
      | FileSystemHandle
      | "desktop"
      | "documents"
      | "downloads"
      | "music"
      | "pictures"
      | "videos";
    id?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

/**
 * File System Directory Handle interface
 * This is a minimal type definition for the File System Access API
 */
export interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: "directory";
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
}

/**
 * File System File Handle interface
 */
export interface FileSystemFileHandle extends FileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

/**
 * Base File System Handle interface
 */
export interface FileSystemHandle {
  kind: "file" | "directory";
  name: string;
  isSameEntry(other: FileSystemHandle): Promise<boolean>;
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  remove(options?: { recursive?: boolean }): Promise<void>;
}

/**
 * Permission descriptor for File System Handle
 */
export interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

/**
 * Writable file stream for File System Access API
 */
export interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
}
