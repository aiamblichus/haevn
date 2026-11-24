/**
 * A stand-in for the extension, for the tests of `haevn backup` and `haevn restore`: it connects to a
 * real daemon over a real WebSocket, answers the backup actions from an in-memory archive, and sends
 * each record or file to the daemon's pipe with a real HTTP request, as the extension's `sendToPipe`
 * does. The restore actions read the CLI's upload from the pipe, as `readFromPipe` does, and keep
 * what they received. A test can make it fail in the ways the real one can.
 */

import { randomBytes } from "node:crypto";
import * as http from "node:http";
import WebSocket from "ws";

export interface FakeMedia {
  name: string;
  data: Buffer;
  /** What the listing says the size is, when it is not the data's (the file changed after listing). */
  listedBytes?: number;
}

export interface FakeChat {
  id: string;
  source?: string;
  /** The chat's record, as the extension would send it. */
  record?: Buffer;
  media?: FakeMedia[];
  /** Listed, but gone when it is read. */
  vanished?: boolean;
  /** What `backupList` says of when the chat was last synced; left out of the listing when absent. */
  lastSyncedTimestamp?: number;
}

/** What the restore actions saw, in order. */
export type RestoreEvent =
  | { kind: "begin"; chats: number }
  | { kind: "media"; chatId: string; name: string; bytes: number }
  | { kind: "chat"; chatId: string; index: boolean }
  | { kind: "finish"; rebuildIndex: boolean };

/** What goes wrong on one request: `n` is how many times this very request has been asked. */
export type Fault =
  | { error: string; message?: string }
  | "cut" // the pipe body ends early, as a service worker that dies mid-send
  | "spent" // the pipe id is refused, as when Chrome re-sends the POST and the id is spent
  | { drop: true; returnAfterMs?: number }; // the WebSocket dies, and perhaps comes back

export interface FakeExtensionOptions {
  /** The API key it offers. */
  key?: string;
  info?: { protocol?: number; haevnVersion?: string; dbSchema?: number } | "unknown-action";
  fault?: (frame: Frame, n: number) => Fault | undefined;
  /** How long before the first connection attempt. */
  connectAfterMs?: number;
  restore?: {
    /** What `restoreBegin` answers; default: true up to 20 chats, as the extension does. */
    indexPerChat?: boolean;
    /** The whole of `restoreBegin`'s answer, in place of the usual one (an extension that is not ours). */
    beginAnswer?: Record<string, unknown>;
    /** What `restoreFinish` answers as `indexError`. */
    indexError?: string;
    /** `restoreChat` answers `replaced: true` for every chat, as for one whose row is only soft-deleted. */
    replacedAlways?: boolean;
    /** The session is gone when the next restore action comes (the extension was idle too long). */
    sessionLost?: boolean;
  };
}

export type Frame = { id: string; action: string; [field: string]: unknown };

export class FakeExtension {
  /** Every action asked, in order, as `action chatId name`. */
  readonly asked: string[] = [];
  private ws: WebSocket | null = null;
  private stopped = false;
  private refused = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly counts = new Map<string, number>();
  private readonly key: string;
  /** Every restore action, in order, as the extension saw it. */
  readonly restoreEvents: RestoreEvent[] = [];
  /** The records and media files received, by chat id and by `chatId/name`. */
  readonly receivedRecords = new Map<string, Buffer>();
  readonly receivedMedia = new Map<string, Buffer>();
  private session = false;

  constructor(
    private readonly port: number,
    private readonly chats: FakeChat[],
    private readonly options: FakeExtensionOptions = {},
  ) {
    this.key = options.key ?? "test-key";
  }

  /** Keep trying to connect, as the extension's alarm does. */
  start(): void {
    this.timer = setTimeout(() => this.connect(), this.options.connectAfterMs ?? 0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.terminate();
  }

  /** Drop the connection and, with `returnAfterMs`, come back. */
  drop(returnAfterMs?: number): void {
    this.ws?.terminate();
    this.ws = null;
    if (returnAfterMs !== undefined) {
      this.timer = setTimeout(() => this.connect(), returnAfterMs);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    let authed = false;
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", apiKey: this.key })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string } & Partial<Frame>;
      if (msg.type === "authOk") {
        authed = true;
        this.ws = ws;
      } else if (msg.type === "authError") {
        this.refused = true; // the real extension stops retrying too
      } else if (msg.action) {
        void this.handle(ws, msg as Frame);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      // Never got in (the daemon is not up yet): try again, as the extension's alarm does.
      if (!authed && !this.stopped && !this.refused) {
        this.timer = setTimeout(() => this.connect(), 30);
      }
    });
  }

  private reply(ws: WebSocket, frame: Frame, body: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: frame.id, ...body }));
  }

  private fail(ws: WebSocket, frame: Frame, code: string, message = code): void {
    this.reply(ws, frame, { success: false, error: message, code });
  }

  private async handle(ws: WebSocket, frame: Frame): Promise<void> {
    const label = [frame.action, frame.chatId ?? "", frame.name ?? "", frame.after ?? ""].join(" ");
    this.asked.push(label.trim());
    const n = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, n);

    const fault = this.options.fault?.(frame, n);
    if (typeof fault === "object" && "drop" in fault) {
      this.drop(fault.returnAfterMs);
      return;
    }
    if (typeof fault === "object") {
      this.fail(ws, frame, fault.error, fault.message);
      return;
    }

    switch (frame.action) {
      case "backupInfo": {
        const info = this.options.info;
        if (info === "unknown-action") {
          this.fail(ws, frame, "UNKNOWN_ACTION", "Unknown action");
          return;
        }
        this.reply(ws, frame, {
          success: true,
          data: {
            protocol: info?.protocol ?? 1,
            haevnVersion: info?.haevnVersion ?? "9.9.9-test",
            dbSchema: info?.dbSchema ?? 21,
            liveChats: this.chats.length,
          },
        });
        return;
      }
      case "backupList": {
        const sorted = [...this.chats].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const after = frame.after as string | undefined;
        const rest = after === undefined ? sorted : sorted.filter((c) => c.id > after);
        const limit = frame.limit as number;
        const page = rest.slice(0, limit);
        this.reply(ws, frame, {
          success: true,
          data: {
            chats: page.map((c) => ({
              id: c.id,
              source: c.source ?? "test",
              ...(c.lastSyncedTimestamp === undefined
                ? {}
                : { lastSyncedTimestamp: c.lastSyncedTimestamp }),
              media: (c.media ?? []).map((m) => ({
                name: m.name,
                bytes: m.listedBytes ?? m.data.length,
              })),
            })),
            ...(rest.length > limit ? { next: page[page.length - 1].id } : {}),
          },
        });
        return;
      }
      case "backupChat": {
        const chat = this.chats.find((c) => c.id === frame.chatId);
        if (!chat || chat.vanished) {
          this.fail(ws, frame, "NOT_FOUND", `chat ${String(frame.chatId)} is not in the archive`);
          return;
        }
        await this.send(ws, frame, chat.record ?? defaultRecord(chat.id), fault);
        return;
      }
      case "backupMedia": {
        const file = this.chats
          .find((c) => c.id === frame.chatId)
          ?.media?.find((m) => m.name === frame.name);
        if (!file) {
          this.fail(ws, frame, "NOT_FOUND", `no media file ${String(frame.name)}`);
          return;
        }
        await this.send(ws, frame, file.data, fault);
        return;
      }
      case "restoreBegin":
        if (this.session) {
          this.fail(ws, frame, "BUSY", "A restore is already running.");
          return;
        }
        this.session = true;
        this.restoreEvents.push({ kind: "begin", chats: frame.chats as number });
        this.reply(ws, frame, {
          success: true,
          data: this.options.restore?.beginAnswer ?? {
            indexPerChat: this.options.restore?.indexPerChat ?? (frame.chats as number) <= 20,
            idleTimeoutMs: 120_000,
          },
        });
        return;
      case "restoreMedia":
      case "restoreChat":
        await this.receive(ws, frame, fault);
        return;
      case "restoreFinish":
        if (!this.session || this.options.restore?.sessionLost) {
          this.session = false;
          this.fail(ws, frame, "NO_SESSION", "No restore is open.");
          return;
        }
        this.session = false;
        this.restoreEvents.push({ kind: "finish", rebuildIndex: frame.rebuildIndex as boolean });
        this.reply(ws, frame, {
          success: true,
          data: this.options.restore?.indexError
            ? { indexError: this.options.restore.indexError }
            : {},
        });
        return;
      default:
        this.fail(ws, frame, "UNKNOWN_ACTION", "Unknown action");
    }
  }

  /**
   * The extension's `readFromPipe`: read the CLI's upload from the daemon's pipe, check it is as
   * long as the request said, keep it, and answer the frame.
   */
  private async receive(ws: WebSocket, frame: Frame, fault: Fault | undefined): Promise<void> {
    if (!this.session || this.options.restore?.sessionLost) {
      this.fail(ws, frame, "NO_SESSION", "No restore is open.");
      return;
    }
    const pipeId = fault === "spent" ? randomBytes(16).toString("hex") : String(frame.pipeId);
    const res = await fetch(`http://127.0.0.1:${this.port}/pipe/${pipeId}`, {
      headers: { Authorization: `Bearer ${this.key}` },
    }).catch(() => null);
    if (!res?.ok) {
      this.fail(ws, frame, "PIPE_FAILED", `the daemon's pipe answered ${res?.status ?? "nothing"}`);
      return;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const chatId = String(frame.chatId);
    if (frame.action === "restoreMedia") {
      const name = String(frame.name);
      if (body.length !== frame.bytes) {
        this.fail(ws, frame, "PIPE_FAILED", `the pipe carries ${body.length} bytes`);
        return;
      }
      this.restoreEvents.push({ kind: "media", chatId, name, bytes: body.length });
      this.receivedMedia.set(`${chatId}/${name}`, body);
      this.reply(ws, frame, { success: true, data: { bytes: body.length } });
      return;
    }
    this.restoreEvents.push({ kind: "chat", chatId, index: frame.index as boolean });
    this.receivedRecords.set(chatId, body);
    this.reply(ws, frame, {
      success: true,
      data: {
        replaced:
          this.options.restore?.replacedAlways === true ||
          this.chats.some((chat) => chat.id === chatId),
      },
    });
  }

  /** The extension's `sendToPipe`: POST the bytes to the daemon, then answer the frame. */
  private async send(
    ws: WebSocket,
    frame: Frame,
    body: Buffer,
    fault: Fault | undefined,
  ): Promise<void> {
    const pipeId = fault === "spent" ? randomBytes(16).toString("hex") : String(frame.pipeId);
    if (fault === "cut") {
      await cutPost(this.port, pipeId, this.key, body);
      return;
    }
    const res = await fetch(`http://127.0.0.1:${this.port}/pipe/${pipeId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}` },
      body,
    }).catch(() => null);
    if (!res?.ok) {
      this.fail(ws, frame, "PIPE_FAILED", `the daemon's pipe answered ${res?.status ?? "nothing"}`);
      return;
    }
    this.reply(ws, frame, { success: true, data: { bytes: body.length } });
  }
}

export function defaultRecord(id: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({ v: 1, chat: { id }, metadata: null, embedding: null })}\n` +
      `${JSON.stringify({ chatId: id, id: "m1", text: `hello from ${id}` })}\n`,
  );
}

/** A POST that promises more bytes than it sends and then dies. */
function cutPost(port: number, pipeId: string, key: string, body: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/pipe/${pipeId}`,
      headers: { Authorization: `Bearer ${key}`, "Content-Length": body.length + 1_000_000 },
    });
    req.on("error", () => resolve());
    req.on("close", () => resolve());
    req.write(body);
    setTimeout(() => req.destroy(), 30);
  });
}
