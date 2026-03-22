import { ensureDirectory } from "../utils/opfs";

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
