import { appendTextFile, writeFile } from "../utils/opfs";

export interface ExportManifestMeta {
  haevn_version: string;
  export_version: string;
  export_id: string;
  export_timestamp: string;
  total_chats: number;
  total_media_items: number;
  total_size_bytes: number;
  provider_stats: Record<string, number>;
}

export interface ExportManifestChatEntry {
  id: string;
  source: string;
  sourceId: string;
  file: string;
  checksum?: string;
}

export interface ExportManifestMediaEntry {
  path: string;
  chatId: string;
  messageId: string;
  partIndex: number;
  mediaType: string;
  size: number;
  checksum?: string;
}

export class ExportManifestWriter {
  private readonly basePath: string;
  private readonly metaPath: string;
  private readonly chatsPath: string;
  private readonly mediaPath: string;

  constructor(exportId: string) {
    this.basePath = `exports/${exportId}/staging/manifest`;
    this.metaPath = `${this.basePath}/meta.json`;
    this.chatsPath = `${this.basePath}/chats.jsonl`;
    this.mediaPath = `${this.basePath}/media.jsonl`;
  }

  async writeMeta(meta: ExportManifestMeta): Promise<void> {
    const content = `${JSON.stringify(meta)}\n`;
    await writeFile(this.metaPath, new TextEncoder().encode(content));
  }

  async appendChat(entry: ExportManifestChatEntry): Promise<void> {
    await appendTextFile(this.chatsPath, `${JSON.stringify(entry)}\n`);
  }

  async appendMedia(entry: ExportManifestMediaEntry): Promise<void> {
    await appendTextFile(this.mediaPath, `${JSON.stringify(entry)}\n`);
  }

  getPaths(): { meta: string; chats: string; media: string } {
    return {
      meta: this.metaPath,
      chats: this.chatsPath,
      media: this.mediaPath,
    };
  }
}
