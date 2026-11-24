import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  type DaemonOptions,
  type DaemonServer,
  HEALTH_REQUEST_TIMEOUT_MS,
  PIPE_FIRST_BYTE_TIMEOUT_MS,
  PIPE_IDLE_TIMEOUT_MS,
  PIPE_PROTOCOL,
  PIPE_REQUEST_HEADER,
  startDaemon,
  timeoutFor,
} from "./server.js";

const API_KEY = "test-key";

type Frame = { id?: string; type?: string; [key: string]: unknown };

const servers: DaemonServer[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  // The daemon logs its lifecycle to stderr; keep the test output readable.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) await server.stop();
  vi.restoreAllMocks();
});

async function start(options?: DaemonOptions): Promise<DaemonServer> {
  const server = await startDaemon({ port: 0, apiKey: API_KEY }, options);
  servers.push(server);
  return server;
}

function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextFrame(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Frame));
  });
}

async function connectExtension(port: number): Promise<WebSocket> {
  const ws = await open(port);
  const authOk = nextFrame(ws);
  ws.send(JSON.stringify({ type: "auth", apiKey: API_KEY }));
  expect(await authOk).toEqual({ type: "authOk" });
  return ws;
}

function askCli(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("how long the daemon waits for the extension", () => {
  it("gives `health` minutes, which opens a tab on each site, and the rest 30 s", () => {
    expect(timeoutFor({ action: "list" })).toBe(30_000);
    expect(timeoutFor({ action: "import", format: "pi", files: [] })).toBe(30_000);
    expect(timeoutFor({ action: "health" })).toBe(HEALTH_REQUEST_TIMEOUT_MS);
    // a body of `null` (valid JSON) does not throw
    expect(timeoutFor(null)).toBe(30_000);
    // longer than the extension's own 240 s limit on a run, so a slow run is answered, not cut
    expect(HEALTH_REQUEST_TIMEOUT_MS).toBeGreaterThan(240_000);
  });
});

describe("daemon WebSocket connections", () => {
  it("keeps the extension's pending request when an unauthenticated socket opens and closes", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);

    const forwarded = nextFrame(extension);
    const cliReply = askCli(daemon.port, { action: "list" });
    const request = await forwarded;

    const stranger = await open(daemon.port);
    const strangerClosed = new Promise<void>((resolve) => stranger.once("close", () => resolve()));
    stranger.close();
    await strangerClosed;
    // Let the server finish handling the stranger's close before the extension answers.
    await new Promise((resolve) => setTimeout(resolve, 50));

    extension.send(JSON.stringify({ id: request.id, success: true, data: [] }));
    const reply = await cliReply;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ id: request.id, success: true, data: [] });
  });

  it("fails the requests of a replaced extension socket once, and serves the new one", async () => {
    const daemon = await start();
    const first = await connectExtension(daemon.port);

    const forwarded = nextFrame(first);
    const stranded = askCli(daemon.port, { action: "list" });
    await forwarded;

    const firstClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      first.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const second = await connectExtension(daemon.port);

    const failed = await stranded;
    expect(failed.status).toBe(504);
    expect(await failed.json()).toMatchObject({ ok: false });
    expect(await firstClosed).toEqual({
      code: 4002,
      reason: "Replaced by a newer extension connection",
    });

    const secondForwarded = nextFrame(second);
    const served = askCli(daemon.port, { action: "list" });
    const request = await secondForwarded;
    second.send(JSON.stringify({ id: request.id, success: true, data: [] }));
    expect((await served).status).toBe(200);
  });
});

// ─── The pipe (HVN-133) ───────────────────────────────────────────────────────

const MB = 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read a response body chunk by chunk, so a 64 MB body never has to sit in the test at once. */
async function hashBody(res: Response): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

const bearer = { Authorization: `Bearer ${API_KEY}` };
const NO_OR_WRONG_KEY: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }];

/** The CLI opens `/pipe/out`; resolves with the frame the extension was sent and the CLI's pending answer. */
async function openOut(
  port: number,
  extension: WebSocket,
  body: Record<string, unknown> = { action: "backupChat", chatId: "c1" },
): Promise<{ frame: Frame; pipeId: string; cli: Promise<Response> }> {
  const forwarded = nextFrame(extension);
  const cli = fetch(url(port, "/pipe/out"), {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const frame = await forwarded;
  return { frame, pipeId: frame.pipeId as string, cli };
}

/** The CLI opens `/pipe/in` with `body` as the file. */
async function openIn(
  port: number,
  extension: WebSocket,
  body: Buffer,
  action: Record<string, unknown> = { action: "restoreMedia", chatId: "c1" },
): Promise<{ frame: Frame; pipeId: string; cli: Promise<Response> }> {
  const forwarded = nextFrame(extension);
  const cli = fetch(url(port, "/pipe/in"), {
    method: "POST",
    headers: { ...bearer, [PIPE_REQUEST_HEADER]: JSON.stringify(action) },
    body,
  });
  const frame = await forwarded;
  return { frame, pipeId: frame.pipeId as string, cli };
}

/** The extension's `fetch(POST /pipe/<pipeId>)`. */
function extensionPost(port: number, pipeId: string, body: Buffer): Promise<Response> {
  return fetch(url(port, `/pipe/${pipeId}`), { method: "POST", headers: bearer, body });
}

/** A raw request, for the cases `fetch` will not produce: a body that is cut, or has no length. */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders,
): http.ClientRequest {
  const req = http.request({ host: "127.0.0.1", port, method, path, headers });
  req.on("error", () => {}); // a request the test cuts reports the cut here
  return req;
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>, afterMs = 150): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await tick(afterMs);
  return done;
}

describe("the pipe: /health and its limits", () => {
  it("reports the pipe protocol on /health, with no key", async () => {
    const daemon = await start();
    const res = await fetch(url(daemon.port, "/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, extensionConnected: false, pipe: 1 });
    expect(PIPE_PROTOCOL).toBe(1);
  });

  it("waits 120 s for a pipe action to start, then 30 s without a byte", () => {
    expect(PIPE_FIRST_BYTE_TIMEOUT_MS).toBe(120_000);
    expect(PIPE_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("the pipe: a body from the extension to the CLI (/pipe/out)", () => {
  it("forwards the action with a fresh 128-bit pipeId, and returns 64 MB byte for byte", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(64 * MB);

    const { frame, pipeId, cli } = await openOut(daemon.port, extension, {
      action: "backupMedia",
      chatId: "c1",
      name: "a.png",
    });
    expect(frame).toMatchObject({ action: "backupMedia", chatId: "c1", name: "a.png" });
    expect(typeof frame.id).toBe("string");
    expect(pipeId).toMatch(/^[0-9a-f]{32}$/);

    const sent = extensionPost(daemon.port, pipeId, payload);
    const res = await cli;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(payload.length));
    const got = await hashBody(res);
    expect(got).toEqual({ sha256: sha256(payload), bytes: payload.length });

    const ack = await sent;
    expect(ack.status).toBe(200);
  }, 30_000);

  it("gives each call its own pipeId", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const a = await openOut(daemon.port, extension);
    const b = await openOut(daemon.port, extension);
    expect(a.pipeId).not.toBe(b.pipeId);
    await extensionPost(daemon.port, a.pipeId, Buffer.from("a"));
    await extensionPost(daemon.port, b.pipeId, Buffer.from("b"));
    expect(await (await a.cli).text()).toBe("a");
    expect(await (await b.cli).text()).toBe("b");
  });

  it("returns an empty body", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);
    expect((await extensionPost(daemon.port, pipeId, Buffer.alloc(0))).status).toBe(200);
    const res = await cli;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("holds the extension back while the CLI does not read (backpressure, nothing buffered)", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(64 * MB);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const sent = extensionPost(daemon.port, pipeId, payload);
    const res = await cli; // the head is here, the body is not being read
    // 64 MB cannot fit in the sockets and buffers between the two: if the daemon took it all
    // in (to hold in memory), the extension's upload would be done by now.
    expect(await settled(sent, 600)).toBe(false);

    const got = await hashBody(res);
    expect(got).toEqual({ sha256: sha256(payload), bytes: payload.length });
    expect((await sent).status).toBe(200);
  }, 30_000);

  it("gives the CLI an error, not a short success, when the body is cut midway", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const post = rawRequest(daemon.port, "POST", `/pipe/${pipeId}`, {
      ...bearer,
      "Content-Length": 8 * MB,
    });
    post.write(randomBytes(1 * MB)); // the first byte is out: the head goes to the CLI
    const res = await cli;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(8 * MB));
    post.destroy(); // and the extension dies

    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("answers 502 when the extension cuts the body before the first byte", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const post = rawRequest(daemon.port, "POST", `/pipe/${pipeId}`, {
      ...bearer,
      "Content-Length": 8 * MB,
    });
    post.flushHeaders();
    await tick(50);
    post.destroy();

    const res = await cli;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("returns the extension's own error frame as 422 when it fails before the first byte", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, pipeId, cli } = await openOut(daemon.port, extension);

    const error = { id: frame.id, success: false, error: "Chat not found", code: "NOT_FOUND" };
    extension.send(JSON.stringify(error));
    const res = await cli;
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(error);

    // and the pipe is closed behind it
    const late = await extensionPost(daemon.port, pipeId, Buffer.from("too late"));
    expect(late.status).toBe(404);
  });

  it("destroys the response when the extension fails after the first byte", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, pipeId, cli } = await openOut(daemon.port, extension);

    const post = rawRequest(daemon.port, "POST", `/pipe/${pipeId}`, {
      ...bearer,
      "Content-Length": 8 * MB,
    });
    post.write(randomBytes(1 * MB));
    const res = await cli;
    expect(res.status).toBe(200);

    extension.send(JSON.stringify({ id: frame.id, success: false, error: "boom", code: "X" }));
    await expect(res.arrayBuffer()).rejects.toThrow();
    post.destroy();
  });

  it("fails an answer that never used the pipe, rather than leave the CLI waiting", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, cli } = await openOut(daemon.port, extension);

    extension.send(JSON.stringify({ id: frame.id, success: true, data: { bytes: 3 } }));
    const res = await cli;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("stops the transfer when the extension stalls after a byte", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 5_000, pipeIdleTimeoutMs: 150 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const post = rawRequest(daemon.port, "POST", `/pipe/${pipeId}`, {
      ...bearer,
      "Content-Length": 8 * MB,
    });
    post.write(randomBytes(64 * 1024)); // then nothing
    const res = await cli;
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    post.destroy();
  });

  it("answers 504 when no first byte comes within the limit, and the pipe is gone", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 150, pipeIdleTimeoutMs: 5_000 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const res = await cli;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false });
    expect((await extensionPost(daemon.port, pipeId, Buffer.from("late"))).status).toBe(404);
  });

  it("answers 504 when the extension disconnects before it answers", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { cli } = await openOut(daemon.port, extension);

    extension.close();
    const res = await cli;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("closes the pipe when the CLI hangs up", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const abort = new AbortController();
    const forwarded = nextFrame(extension);
    const cli = fetch(url(daemon.port, "/pipe/out"), {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "backupChat", chatId: "c1" }),
      signal: abort.signal,
    });
    const pipeId = (await forwarded).pipeId as string;

    abort.abort();
    await expect(cli).rejects.toThrow();
    await tick(50);
    expect((await extensionPost(daemon.port, pipeId, Buffer.from("x"))).status).toBe(404);
  });

  it("answers 503 when no extension is connected, and 400 for a body that is not an action", async () => {
    const daemon = await start();
    const noExtension = await fetch(url(daemon.port, "/pipe/out"), {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ action: "backupChat" }),
    });
    expect(noExtension.status).toBe(503);

    await connectExtension(daemon.port);
    for (const body of ["not json", "null", JSON.stringify({ chatId: "c1" })]) {
      const res = await fetch(url(daemon.port, "/pipe/out"), {
        method: "POST",
        headers: bearer,
        body,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("the pipe: a body from the CLI to the extension (/pipe/in)", () => {
  it("hands the extension 64 MB byte for byte and returns the extension's frame", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(64 * MB);

    const { frame, pipeId, cli } = await openIn(daemon.port, extension, payload, {
      action: "restoreMedia",
      chatId: "c1",
      name: "a.png",
      bytes: payload.length,
    });
    expect(frame).toMatchObject({ action: "restoreMedia", chatId: "c1", name: "a.png" });
    expect(pipeId).toMatch(/^[0-9a-f]{32}$/);

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-length")).toBe(String(payload.length));
    const read = await hashBody(got);
    expect(read).toEqual({ sha256: sha256(payload), bytes: payload.length });

    extension.send(JSON.stringify({ id: frame.id, success: true, data: { bytes: read.bytes } }));
    const answer = await cli;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      id: frame.id,
      success: true,
      data: { bytes: payload.length },
    });
  }, 30_000);

  it("accepts an action whose non-ASCII characters are escaped in the header", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const forwarded = nextFrame(extension);
    const cli = fetch(url(daemon.port, "/pipe/in"), {
      method: "POST",
      headers: {
        ...bearer,
        [PIPE_REQUEST_HEADER]: '{"action":"restoreMedia","name":"caf\\u00e9.png"}',
      },
      body: Buffer.from("x"),
    });
    const frame = await forwarded;
    expect(frame.name).toBe("café.png");
    const got = await fetch(url(daemon.port, `/pipe/${frame.pipeId}`), { headers: bearer });
    await got.arrayBuffer();
    extension.send(JSON.stringify({ id: frame.id, success: true, data: {} }));
    expect((await cli).status).toBe(200);
  });

  it("holds the CLI's body back while the extension does not read", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(64 * MB);
    const { frame, pipeId, cli } = await openIn(daemon.port, extension, payload);

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    // the extension has the head and has not read: the CLI cannot be done with 64 MB
    extension.send(JSON.stringify({ id: frame.id, success: true, data: {} }));
    expect(await settled(cli, 600)).toBe(false);

    const read = await hashBody(got);
    expect(read).toEqual({ sha256: sha256(payload), bytes: payload.length });
    expect((await cli).status).toBe(200);
  }, 30_000);

  it("answers only when the extension has read the whole body", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(8 * MB);
    const { frame, pipeId, cli } = await openIn(daemon.port, extension, payload);

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    extension.send(JSON.stringify({ id: frame.id, success: true, data: { early: true } }));
    expect(await settled(cli, 200)).toBe(false);

    await hashBody(got);
    const answer = await cli;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ success: true, data: { early: true } });
  });

  it("returns the extension's error frame as 422, even before the extension reads", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, pipeId, cli } = await openIn(daemon.port, extension, randomBytes(2 * MB));

    const error = { id: frame.id, success: false, error: "BUSY", code: "BUSY" };
    extension.send(JSON.stringify(error));
    const answer = await cli;
    expect(answer.status).toBe(422);
    expect(await answer.json()).toEqual(error);
    expect((await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer })).status).toBe(
      404,
    );
  });

  it("cuts the extension's read when the extension fails midway", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, pipeId, cli } = await openIn(daemon.port, extension, randomBytes(8 * MB));

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    extension.send(JSON.stringify({ id: frame.id, success: false, error: "disk", code: "X" }));
    await expect(got.arrayBuffer()).rejects.toThrow();
    expect((await cli).status).toBe(422);
  });

  it("gives the extension an error, not a short body, when the CLI's upload is cut", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);

    const forwarded = nextFrame(extension);
    const upload = rawRequest(daemon.port, "POST", "/pipe/in", {
      ...bearer,
      [PIPE_REQUEST_HEADER]: JSON.stringify({ action: "restoreMedia" }),
      "Content-Length": 8 * MB,
    });
    upload.write(randomBytes(1 * MB));
    const frame = await forwarded;

    const got = await fetch(url(daemon.port, `/pipe/${frame.pipeId}`), { headers: bearer });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-length")).toBe(String(8 * MB));
    await tick(50);
    upload.destroy();
    await expect(got.arrayBuffer()).rejects.toThrow();
  });

  it("fails an answer that never used the pipe", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { frame, cli } = await openIn(daemon.port, extension, Buffer.from("data"));

    extension.send(JSON.stringify({ id: frame.id, success: true, data: {} }));
    const answer = await cli;
    expect(answer.status).toBe(502);
  });

  it("answers 504 when the extension never reads, and the pipe is gone", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 150, pipeIdleTimeoutMs: 5_000 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openIn(daemon.port, extension, randomBytes(1 * MB));

    const answer = await cli;
    expect(answer.status).toBe(504);
    expect((await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer })).status).toBe(
      404,
    );
  });

  it("answers 504 when the extension reads the body and never answers", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 200, pipeIdleTimeoutMs: 5_000 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openIn(daemon.port, extension, Buffer.from("small"));

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    expect(await got.text()).toBe("small");
    expect((await cli).status).toBe(504);
  });

  it("refuses a body without a length (411), a missing or bad header (400), and no extension (503)", async () => {
    const daemon = await start();

    const noExtension = await fetch(url(daemon.port, "/pipe/in"), {
      method: "POST",
      headers: { ...bearer, [PIPE_REQUEST_HEADER]: JSON.stringify({ action: "restoreMedia" }) },
      body: "x",
    });
    expect(noExtension.status).toBe(503);

    await connectExtension(daemon.port);
    for (const header of [undefined, "not json", "null", JSON.stringify({ chatId: "c1" })]) {
      const res = await fetch(url(daemon.port, "/pipe/in"), {
        method: "POST",
        headers: header === undefined ? bearer : { ...bearer, [PIPE_REQUEST_HEADER]: header },
        body: "x",
      });
      expect(res.status).toBe(400);
    }

    const chunked = rawRequest(daemon.port, "POST", "/pipe/in", {
      ...bearer,
      [PIPE_REQUEST_HEADER]: JSON.stringify({ action: "restoreMedia" }),
      "Transfer-Encoding": "chunked",
    });
    const status = new Promise<number>((resolve) =>
      chunked.once("response", (res) => resolve(res.statusCode ?? 0)),
    );
    chunked.write("some bytes");
    expect(await status).toBe(411);
    chunked.destroy();
  });
});

describe("the pipe: the key, and a pipeId that works once", () => {
  it("needs the Bearer key on all three endpoints, and a refused call opens no pipe", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);

    const forwardedAny = vi.fn();
    extension.on("message", forwardedAny);

    for (const headers of NO_OR_WRONG_KEY) {
      const out = await fetch(url(daemon.port, "/pipe/out"), {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "backupChat" }),
      });
      expect(out.status).toBe(401);
      const into = await fetch(url(daemon.port, "/pipe/in"), {
        method: "POST",
        headers: { ...headers, [PIPE_REQUEST_HEADER]: JSON.stringify({ action: "restoreChat" }) },
        body: "x",
      });
      expect(into.status).toBe(401);
    }
    expect(forwardedAny).not.toHaveBeenCalled();

    // a real pipeId, used without the key: refused, and the pipe is still open for the right call
    const { pipeId, cli } = await openOut(daemon.port, extension);
    for (const headers of NO_OR_WRONG_KEY) {
      const res = await fetch(url(daemon.port, `/pipe/${pipeId}`), {
        method: "POST",
        headers,
        body: Buffer.from("stolen"),
      });
      expect(res.status).toBe(401);
    }
    expect((await extensionPost(daemon.port, pipeId, Buffer.from("mine"))).status).toBe(200);
    expect(await (await cli).text()).toBe("mine");
  });

  it("answers 404 to a pipeId nobody was given", async () => {
    const daemon = await start();
    await connectExtension(daemon.port);
    const res = await extensionPost(daemon.port, "0".repeat(32), Buffer.from("x"));
    expect(res.status).toBe(404);
  });

  it("works once: a second use of an out pipeId is refused, while the first is still in flight and after", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(16 * MB);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const first = extensionPost(daemon.port, pipeId, payload);
    const res = await cli; // the first use is under way (the CLI is not reading yet)
    const second = await extensionPost(daemon.port, pipeId, randomBytes(1 * MB));
    expect(second.status).toBe(404);

    const got = await hashBody(res);
    expect(got).toEqual({ sha256: sha256(payload), bytes: payload.length });
    expect((await first).status).toBe(200);

    const third = await extensionPost(daemon.port, pipeId, Buffer.from("again"));
    expect(third.status).toBe(404);
  });

  it("works once: a second read of an in pipeId is refused", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const payload = randomBytes(2 * MB);
    const { frame, pipeId, cli } = await openIn(daemon.port, extension, payload);

    const first = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    const second = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    expect(second.status).toBe(404);

    expect((await hashBody(first)).sha256).toBe(sha256(payload));
    extension.send(JSON.stringify({ id: frame.id, success: true, data: {} }));
    expect((await cli).status).toBe(200);
    expect((await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer })).status).toBe(
      404,
    );
  });

  it("is the right verb for its direction: a wrong one is refused and does not use the pipeId up", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const out = await openOut(daemon.port, extension);

    const wrong = await fetch(url(daemon.port, `/pipe/${out.pipeId}`), { headers: bearer }); // GET
    expect(wrong.status).toBe(404);
    expect((await extensionPost(daemon.port, out.pipeId, Buffer.from("ok"))).status).toBe(200);
    expect(await (await out.cli).text()).toBe("ok");

    const into = await openIn(daemon.port, extension, Buffer.from("in"));
    const wrongToo = await extensionPost(daemon.port, into.pipeId, Buffer.from("x")); // POST
    expect(wrongToo.status).toBe(404);
    const right = await fetch(url(daemon.port, `/pipe/${into.pipeId}`), { headers: bearer });
    expect(await right.text()).toBe("in");
    extension.send(JSON.stringify({ id: into.frame.id, success: true, data: {} }));
    expect((await into.cli).status).toBe(200);
  });
});

describe("the pipe: the service worker's cross-origin fetch", () => {
  it("answers the preflight for an Authorization header on both of the extension's verbs", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId } = await openOut(daemon.port, extension);

    for (const method of ["POST", "GET"]) {
      const preflight = await fetch(url(daemon.port, `/pipe/${pipeId}`), {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      expect(allowed).toContain("authorization");
      expect(allowed).toContain("content-type");
    }
    // the preflight did not use the pipeId up
    expect((await extensionPost(daemon.port, pipeId, Buffer.from("x"))).status).toBe(200);
  });

  it("lets the page read the answers to the extension's real requests", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId } = await openOut(daemon.port, extension);
    const res = await extensionPost(daemon.port, pipeId, Buffer.from("x"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const refused = await extensionPost(daemon.port, pipeId, Buffer.from("x"));
    expect(refused.status).toBe(404);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("the pipe: a peer that is alive but does not read, and an extension that leaves mid-stream", () => {
  it("cuts an out transfer when the CLI stops reading its response", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 5_000, pipeIdleTimeoutMs: 150 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openOut(daemon.port, extension);

    const sent = extensionPost(daemon.port, pipeId, randomBytes(64 * MB));
    const res = await cli; // the head is here, and nobody reads the body
    expect(res.status).toBe(200);

    // 64 MB cannot sit in the sockets between the two: the daemon waits for the reader to
    // drain, the reader does not, and the clock ends the transfer.
    await expect(sent).rejects.toThrow();
    await expect(res.arrayBuffer()).rejects.toThrow();
  }, 15_000);

  it("answers 504 for an in transfer when the extension stops reading the body, and names it", async () => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 5_000, pipeIdleTimeoutMs: 150 });
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openIn(daemon.port, extension, randomBytes(64 * MB));

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    expect(got.status).toBe(200); // the extension holds the response and does not read it

    const answer = await cli;
    expect(answer.status).toBe(504);
    const body = (await answer.json()) as { error: string };
    expect(body.error).toContain("the extension stopped reading");
    await expect(got.arrayBuffer()).rejects.toThrow();
  }, 15_000);

  it.each([
    1024,
    64 * 1024,
  ])("answers 504 for an in transfer when the CLI stops sending after %i bytes, and names the CLI", async (firstBytes) => {
    const daemon = await start({ pipeFirstByteTimeoutMs: 5_000, pipeIdleTimeoutMs: 150 });
    const extension = await connectExtension(daemon.port);

    const forwarded = nextFrame(extension);
    const upload = rawRequest(daemon.port, "POST", "/pipe/in", {
      ...bearer,
      [PIPE_REQUEST_HEADER]: JSON.stringify({ action: "restoreMedia" }),
      "Content-Length": 8 * MB,
    });
    const answered = new Promise<{ status: number; body: string }>((resolve) => {
      upload.once("response", (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
    });
    upload.write(randomBytes(firstBytes)); // then silence
    const frame = await forwarded;
    const got = await fetch(url(daemon.port, `/pipe/${frame.pipeId}`), { headers: bearer });
    expect(got.status).toBe(200);

    const { status, body } = await answered;
    expect(status).toBe(504);
    expect(body).toContain("the CLI stopped sending");
    upload.destroy();
  });

  it("fails an in transfer when the extension disconnects mid-stream", async () => {
    const daemon = await start();
    const extension = await connectExtension(daemon.port);
    const { pipeId, cli } = await openIn(daemon.port, extension, randomBytes(8 * MB));

    const got = await fetch(url(daemon.port, `/pipe/${pipeId}`), { headers: bearer });
    expect(got.status).toBe(200); // the body is under way, and held back by the unread response
    extension.close();

    const answer = await cli;
    expect(answer.status).toBe(504);
    expect(await answer.json()).toMatchObject({ ok: false });
    await expect(got.arrayBuffer()).rejects.toThrow();
  });
});
