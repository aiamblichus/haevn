/**
 * `haevn get --include-media`: the media of a branch, fetched from the extension and put where the
 * output can show it.
 *
 * What the archive holds is a path, not bytes. A `get` that asks for media gets each binary item's
 * `data` as the path of its file in the extension's store (`media/<chat>/<name>`); the bytes come by
 * the same pipe `haevn backup` uses (`backupMedia`, which streams one file by chat and name), so a
 * large video is never held in a JSON frame. A link stays a link: nothing is downloaded from the
 * web.
 *
 *   Markdown with `-o FILE`   each file goes to `<FILE without extension>-media/NN.<ext>`, numbered
 *                             in message order, and the Markdown links it where the stand-in was. A
 *                             file that two items share (a tree: one upload in two branches) is
 *                             saved once.
 *   Markdown on stdout        no file is written; the stand-ins stay, with one note.
 *   JSON                      each item is described in the message's `media` array, with its bytes
 *                             as base64 in `data`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type DaemonEndpoint, pipeOut } from "../daemon/client.js";
import type { ChatMessage } from "../types/chat";
import { getMediaItems, type MediaItem } from "./tree";

/** The most one item puts into JSON: base64 is a third larger, and a script reads the whole document. */
export const JSON_ITEM_MAX_BYTES = 32 * 1024 * 1024;
/** The most all of a branch's items put into JSON. */
export const JSON_TOTAL_MAX_BYTES = 128 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
  "video/x-flv": "flv",
  "video/x-ms-wmv": "wmv",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aiff": "aiff",
  "audio/aac": "aac",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
};

/** The file extension for a media type, without the dot: `bin` for one this table does not know. */
export function extensionFor(mediaType: string | undefined): string {
  const bare = (mediaType ?? "").split(";")[0].trim().toLowerCase();
  return EXTENSIONS[bare] ?? "bin";
}

/**
 * Text as the target of a Markdown link: a space, a parenthesis, an angle bracket or a control
 * character would end it early, so each is written as a percent escape.
 */
export function linkTarget(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (ch === "(") out += "%28";
    else if (ch === ")") out += "%29";
    else if (control || /[\s<>]/.test(ch)) out += encodeURIComponent(ch);
    else out += ch;
  }
  return out;
}

/** The folder a Markdown file's media goes in: beside it, named for it. */
export function mediaFolderFor(output: string): { dir: string; name: string } {
  const { dir, name } = path.parse(output);
  const folder = `${name}-media`;
  return { dir: path.join(dir, folder), name: folder };
}

/** What `--include-media` needs from a command: the chat the branch is from and where the daemon is. */
export interface MediaContext {
  chatId: string;
  endpoint: DaemonEndpoint;
}

/** What a run found out, for the command to say. */
export interface MediaReport {
  /** Items that were asked for and did not arrive. The run exits 1 when there are any. */
  problems: string[];
  /** Items that have no file to give (a link not to the web, text where bytes should be). */
  withoutFile: number;
  /** Items with bytes that were left, because the output is the terminal. */
  unsaved: number;
}

/** What a Markdown run gives the formatter: the text for each media item of each message. */
export interface MarkdownMedia extends MediaReport {
  /** Message id to the text that stands for each of its media items, by index. */
  text: Map<string, string[]>;
}

/** One media item as JSON carries it. */
export interface JsonMediaItem {
  kind: string;
  mediaType?: string;
  name?: string;
  url?: string;
  /** The size of the file in bytes, when its bytes were read. */
  bytes?: number;
  /** The file, base64. */
  data?: string;
  /** Why `data` is missing, when the item had a file. */
  error?: string;
}

/** What a JSON run gives the formatter: each message's media items, by message id. */
export interface JsonMedia extends MediaReport {
  items: Map<string, JsonMediaItem[]>;
}

// ─── Where the bytes are ──────────────────────────────────────────────────────

interface Fetched {
  length: number | null;
  stream: Readable;
}

/** How to get an item's bytes, or undefined when it has none to get (a link, or no file). */
type Opener = () => Promise<Fetched>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function openerFor(item: MediaItem, context: MediaContext): Opener | undefined {
  const { source } = item;
  if (source.type === "stored") {
    const name = source.path.slice(source.path.lastIndexOf("/") + 1);
    if (name === "") return undefined;
    return async () => {
      const { length, body } = await pipeOut(context.endpoint, {
        action: "backupMedia",
        chatId: context.chatId,
        name,
      });
      return { length, stream: Readable.fromWeb(body as never) };
    };
  }
  // An inline `data` is bytes only for an image, a video or a sound; for a document a provider may
  // leave the text it extracted there, which is not the file.
  if (source.type === "inline" && item.kind !== "file") {
    if (source.data.length % 4 !== 0 || !BASE64.test(source.data)) return undefined;
    const bytes = Buffer.from(source.data, "base64");
    return async () => ({ length: bytes.length, stream: Readable.from([bytes]) });
  }
  return undefined;
}

function webUrl(item: MediaItem): string | undefined {
  const { source } = item;
  return source.type === "url" && /^https?:\/\//i.test(source.url) ? source.url : undefined;
}

/**
 * What names a file in the archive's store, so that two items with one key are one file: the stored
 * path. A message in two branches of a tree may hold the same upload.
 */
function fileKey(item: MediaItem): string | undefined {
  return item.source.type === "stored" ? item.source.path : undefined;
}

function describe(item: MediaItem): string {
  const { source } = item;
  const name =
    source.type === "stored" ? source.path.slice(source.path.lastIndexOf("/") + 1) : item.name;
  return name ? `${item.kind} ${name}` : item.kind;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function markdownLink(kind: string, target: string): string {
  const link = `[${kind}](${linkTarget(target)})`;
  return kind === "image" ? `!${link}` : link;
}

// ─── Markdown with -o: files beside the output ────────────────────────────────

/**
 * Write each media item of `messages` to the folder beside `output` and say what the Markdown
 * shows in its place. Refuses, before anything is fetched or written, when the folder is already
 * there: its files are some other run's, and `01.png` of this chat would overwrite or hide one of
 * them.
 *
 * A file that two items share (the same stored path) is fetched and written once, under the number
 * of its first item, and every item that holds it links that file.
 */
export async function saveMarkdownMedia(
  messages: ChatMessage[],
  output: string,
  context: MediaContext,
): Promise<MarkdownMedia> {
  const planned = messages.map((message) => ({ id: message.id, items: getMediaItems(message) }));
  const openers = planned.map(({ items }) => items.map((item) => openerFor(item, context)));
  // The files to write: a file two items share counts once
  const keys = planned.flatMap(({ items }) => items.map(fileKey));
  const first = new Set<string>();
  const saving = openers.flat().filter((opener, i) => {
    const key = keys[i];
    if (opener === undefined) return false;
    if (key === undefined) return true;
    if (first.has(key)) return false;
    first.add(key);
    return true;
  }).length;

  const result: MarkdownMedia = { text: new Map(), problems: [], withoutFile: 0, unsaved: 0 };

  const folder = mediaFolderFor(output);
  if (saving > 0) {
    if (fs.existsSync(folder.dir) || isLink(folder.dir)) {
      throw new Error(
        `${folder.dir} already exists. Move it, or write to another file with -o, so that this run's media do not mix with what is there.`,
      );
    }
    fs.mkdirSync(folder.dir);
  }

  const width = Math.max(2, String(saving).length);
  // Each stored file this run has met: where it was saved, or null when it did not arrive
  const saved = new Map<string, string | null>();
  let number = 0;
  for (const [m, { id, items }] of planned.entries()) {
    const texts: string[] = [];
    for (const [i, item] of items.entries()) {
      const standIn = `[${item.kind}]`;
      const open = openers[m][i];
      const url = webUrl(item);
      if (url) {
        texts.push(markdownLink(item.kind, url));
        continue;
      }
      if (!open) {
        result.withoutFile++;
        texts.push(standIn);
        continue;
      }
      const key = fileKey(item);
      if (key !== undefined && saved.has(key)) {
        // An earlier item holds this file: its link, or the stand-in when the file did not arrive
        const earlier = saved.get(key);
        texts.push(earlier ? markdownLink(item.kind, earlier) : standIn);
        continue;
      }
      // A file that does not arrive leaves no gap in the numbers
      const file = `${String(number + 1).padStart(width, "0")}.${extensionFor(item.mediaType)}`;
      const target = path.join(folder.dir, file);
      try {
        await writeFetched(await open(), target);
        number++;
        if (key !== undefined) saved.set(key, `${folder.name}/${file}`);
        texts.push(markdownLink(item.kind, `${folder.name}/${file}`));
      } catch (err) {
        fs.rmSync(target, { force: true });
        if (key !== undefined) saved.set(key, null);
        result.problems.push(`${describe(item)} was not saved: ${reasonOf(err)}`);
        texts.push(standIn);
      }
    }
    result.text.set(id, texts);
  }

  // A folder with nothing in it says there was media when there was not
  if (saving > 0 && fs.readdirSync(folder.dir).length === 0) fs.rmdirSync(folder.dir);
  return result;
}

function isLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

async function writeFetched(fetched: Fetched, target: string): Promise<void> {
  if (fetched.length === null) {
    fetched.stream.destroy();
    throw new Error("the daemon sent bytes without a Content-Length");
  }
  // `wx`: a file that is there is never overwritten
  await pipeline(fetched.stream, fs.createWriteStream(target, { flags: "wx" }));
}

// ─── Markdown on stdout: nothing written ──────────────────────────────────────

/** The text for each media item when no file may be written: a link for a link, the stand-in for the rest. */
export function linkMarkdownMedia(messages: ChatMessage[], context: MediaContext): MarkdownMedia {
  const result: MarkdownMedia = { text: new Map(), problems: [], withoutFile: 0, unsaved: 0 };
  const counted = new Set<string>();
  for (const message of messages) {
    const texts = getMediaItems(message).map((item) => {
      const url = webUrl(item);
      if (url) return markdownLink(item.kind, url);
      const key = fileKey(item);
      // A file that two items share is one file left unsaved
      if (key !== undefined) {
        if (counted.has(key)) return `[${item.kind}]`;
        counted.add(key);
      }
      if (openerFor(item, context)) result.unsaved++;
      else result.withoutFile++;
      return `[${item.kind}]`;
    });
    result.text.set(message.id, texts);
  }
  return result;
}

// ─── JSON: the bytes inline ───────────────────────────────────────────────────

/** Each media item of `messages` as JSON carries it, with the file's bytes as base64. */
export async function inlineJsonMedia(
  messages: ChatMessage[],
  context: MediaContext,
): Promise<JsonMedia> {
  const result: JsonMedia = { items: new Map(), problems: [], withoutFile: 0, unsaved: 0 };
  let total = 0;

  for (const message of messages) {
    const entries: JsonMediaItem[] = [];
    for (const item of getMediaItems(message)) {
      const entry: JsonMediaItem = {
        kind: item.kind,
        ...(item.mediaType ? { mediaType: item.mediaType } : {}),
        ...(item.name ? { name: item.name } : {}),
      };
      const url = item.source.type === "url" ? item.source.url : undefined;
      if (url !== undefined) entry.url = url;
      const open = openerFor(item, context);
      if (open) {
        try {
          const bytes = await readCapped(await open(), total);
          total += bytes.length;
          entry.bytes = bytes.length;
          entry.data = bytes.toString("base64");
        } catch (err) {
          entry.error = reasonOf(err);
          result.problems.push(`${describe(item)} was not included: ${entry.error}`);
        }
      } else if (url === undefined) {
        result.withoutFile++;
      }
      entries.push(entry);
    }
    if (entries.length > 0) result.items.set(message.id, entries);
  }
  return result;
}

/** All of a stream, refused as soon as it is over the item limit, or would take the total over its own. */
async function readCapped(fetched: Fetched, total: number): Promise<Buffer> {
  const { length, stream } = fetched;
  const refuse = (why: string): Error => {
    stream.destroy();
    return new Error(`${why}; save the media with -f markdown -o FILE instead`);
  };
  if (length === null) {
    stream.destroy();
    throw new Error("the daemon sent bytes without a Content-Length");
  }
  if (length > JSON_ITEM_MAX_BYTES) {
    throw refuse(`it is ${length} bytes, and JSON carries at most ${JSON_ITEM_MAX_BYTES} inline`);
  }
  if (total + length > JSON_TOTAL_MAX_BYTES) {
    throw refuse(`JSON carries at most ${JSON_TOTAL_MAX_BYTES} bytes of media in all`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
