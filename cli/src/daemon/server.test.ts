import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type DaemonServer, startDaemon } from "./server.js";

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

async function start(): Promise<DaemonServer> {
  const server = await startDaemon({ port: 0, apiKey: API_KEY });
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
