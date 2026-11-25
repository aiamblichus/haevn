#!/usr/bin/env node
/**
 * HAEVN CLI - Access your AI conversation archive from the terminal.
 *
 * Usage:
 *   haevn search "react hooks"           # Search for messages
 *   haevn get chat_abc123                # Get primary branch as markdown
 *   haevn get chat_abc123 -m msg_xyz     # Get specific branch
 *   haevn list                           # List recent chats
 *   haevn branches chat_abc123           # Show tree structure
 *   haevn export chat_abc123 -o out.json --format haevn_json
 *   haevn health                         # does each provider you are signed in to still sync?
 *   haevn logs -n 200 --level warn       # the extension's log, the newest entries (ids and sizes, no chat text)
 *   haevn backup ~/backups/haevn         # the whole archive into a directory (exit 75: not now)
 *   haevn restore ~/backups/haevn       # a backup back into the archive (--dry-run first; exit 75: not now)
 *   haevn install -e <extension-id>      # Install native messaging host
 */

import { defineCommand, runMain } from "citty";
import packageJson from "../package.json";
import backupCommand from "./commands/backup";
import branchesCommand from "./commands/branches";
import daemonCommand from "./commands/daemon";
import exportCommand from "./commands/export";
import getCommand from "./commands/get";
import healthCommand from "./commands/health";
import importCommand from "./commands/import";
import infoCommand from "./commands/info";
import listCommand from "./commands/list";
import logsCommand from "./commands/logs";
import restoreCommand from "./commands/restore";
import searchCommand from "./commands/search";
import { consola } from "./utils/output";

const VERSION = packageJson.version;

const mainCommand = defineCommand({
  meta: {
    name: "haevn",
    version: VERSION,
    description: "CLI tool for searching and accessing HAEVN chat archives",
  },
  args: {
    verbose: {
      type: "boolean",
      alias: "V",
      description: "Enable verbose output",
      default: false,
    },
  },
  subCommands: {
    search: searchCommand,
    get: getCommand,
    list: listCommand,
    branches: branchesCommand,
    export: exportCommand,
    import: importCommand,
    info: infoCommand,
    health: healthCommand,
    logs: logsCommand,
    backup: backupCommand,
    restore: restoreCommand,
    daemon: daemonCommand,
  },
  async setup(ctx) {
    const { args } = ctx;

    // Configure logging
    if (args.verbose) {
      consola.level = 5; // Debug
    }
  },
});

// Run the CLI
runMain(mainCommand);
