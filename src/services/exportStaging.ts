import {
  deleteDirectory,
  ensureDirectory,
  getFileMetadata,
  listDirectories,
  listFiles,
} from "../utils/opfs";

export function buildExportRootPath(exportId: string): string {
  return `exports/${exportId}`;
}

export function buildExportStagingRoot(exportId: string): string {
  return `${buildExportRootPath(exportId)}/staging`;
}

export function buildExportChatsPath(exportId: string, chatId: string): string {
  return `${buildExportStagingRoot(exportId)}/chats/${chatId}.json`;
}

export function buildExportMediaPath(exportId: string, chatId: string, filename: string): string {
  return `${buildExportStagingRoot(exportId)}/media/${chatId}/${filename}`;
}

export function buildExportManifestDir(exportId: string): string {
  return `${buildExportStagingRoot(exportId)}/manifest`;
}

export function buildExportZipPath(exportId: string): string {
  return `${buildExportRootPath(exportId)}/haevn_export.zip`;
}

export async function ensureExportStagingDirectories(exportId: string): Promise<void> {
  await ensureDirectory(buildExportStagingRoot(exportId));
  await ensureDirectory(buildExportManifestDir(exportId));
  await ensureDirectory(`${buildExportStagingRoot(exportId)}/chats`);
  await ensureDirectory(`${buildExportStagingRoot(exportId)}/media`);
}

/** An export directory nothing has written to for this long, and no job owns, is an orphan. */
export const STALE_EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EXPORTS_ROOT = "exports";

function assertExportId(exportId: string): void {
  // The id becomes a path segment of a recursive delete: an empty or nested one would reach
  // the whole `exports/` tree or beyond.
  if (!exportId || exportId === "." || exportId === ".." || /[\\/]/.test(exportId)) {
    throw new Error(`Invalid export id: "${exportId}"`);
  }
}

/**
 * Deletes `exports/{exportId}`, the staging tree and the ZIP. Resolves false when nothing was
 * deleted: the directory is already gone, or a file in it is still held open by a job that is
 * writing (the sweep takes it later).
 */
export async function deleteExportDirectory(exportId: string): Promise<boolean> {
  assertExportId(exportId);
  return deleteDirectory(buildExportRootPath(exportId));
}

/** True when a file under `dir`, at any depth, was modified after `cutoff`. */
async function hasFileModifiedAfter(dir: string, cutoff: number): Promise<boolean> {
  // The files of a directory are read before its subdirectories, so a finished export (its ZIP
  // beside `staging/`) answers at once, and only an orphan is read through to the end.
  for (const name of await listFiles(dir)) {
    const meta = await getFileMetadata(`${dir}/${name}`);
    if (meta && meta.lastModified > cutoff) return true;
  }
  for (const name of await listDirectories(dir)) {
    if (await hasFileModifiedAfter(`${dir}/${name}`, cutoff)) return true;
  }
  return false;
}

/**
 * Deletes the orphans under `exports/`: every directory that has had no write for maxAgeMs,
 * except keepExportId (the export a job is running now, paused or not). OPFS keeps no time for
 * a directory, so its age is the newest modification of any file in it; a directory with no
 * file at all counts as old. Returns the ids it deleted.
 */
export async function sweepStaleExports(options: {
  keepExportId?: string;
  maxAgeMs?: number;
  now?: number;
}): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? STALE_EXPORT_MAX_AGE_MS);
  const swept: string[] = [];
  for (const exportId of await listDirectories(EXPORTS_ROOT)) {
    if (exportId === options.keepExportId) continue;
    if (await hasFileModifiedAfter(buildExportRootPath(exportId), cutoff)) continue;
    if (await deleteExportDirectory(exportId)) swept.push(exportId);
  }
  return swept;
}
