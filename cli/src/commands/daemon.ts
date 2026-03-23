/**
 * `haevn daemon` – start the local bridge between the CLI and the extension.
 *
 * The daemon runs a single HTTP server on localhost that:
 *   - Accepts CLI commands via POST /api
 *   - Maintains a persistent WebSocket connection to the HAEVN extension
 *   - Routes requests from CLI clients through to the extension and back
 *
 * Usage:
 *   haevn daemon                          # use ~/.haevn/config.json
 *   haevn daemon --api-key <key>          # override config file
 *   haevn daemon --port 5517 --api-key …  # full override
 *
 * The API key must match the one shown in the HAEVN extension's Settings page.
 * The daemon saves its effective config to ~/.haevn/config.json on startup so
 * subsequent CLI commands can connect without extra flags.
 */

import { defineCommand } from "citty";
import { resolveConfig, saveConfig } from "../daemon/config.js";
import { startDaemon } from "../daemon/server.js";
import { consola } from "../utils/output.js";

export default defineCommand({
  meta: {
    name: "daemon",
    description: "Start the HAEVN CLI daemon (WebSocket bridge to the extension)",
  },
  args: {
    port: {
      type: "string",
      alias: "p",
      description: `Daemon port (default: 5517)`,
    },
    "api-key": {
      type: "string",
      alias: "k",
      description: "API key shown in the HAEVN extension Settings page",
    },
  },
  async run({ args }) {
    let config: ReturnType<typeof resolveConfig>;
    try {
      config = resolveConfig({
        port: args.port ? Number.parseInt(args.port, 10) : undefined,
        apiKey: args["api-key"],
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Persist the effective config so CLI commands can connect without flags.
    try {
      saveConfig(config);
    } catch {
      // Non-fatal — in-memory config is still valid
    }

    consola.info(`Starting HAEVN daemon on port ${config.port}…`);
    consola.info("Waiting for the HAEVN extension to connect…");
    consola.info("Press Ctrl+C to stop.\n");

    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    try {
      daemon = await startDaemon(config);
    } catch (err) {
      consola.error(
        `Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`,
      );
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        consola.info(`Port ${config.port} is already in use. Is the daemon already running?`);
      }
      process.exit(1);
    }

    // Graceful shutdown
    const shutdown = async () => {
      consola.info("\nShutting down daemon…");
      await daemon.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});
