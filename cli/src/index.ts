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
 *   haevn export chat_abc123 -o out.json # Export full chat
 *   haevn install -e <extension-id>      # Install native messaging host
 */

import { defineCommand, runMain } from "citty";
import packageJson from "../package.json";
import branchesCommand from "./commands/branches";
import daemonCommand from "./commands/daemon";
import exportCommand from "./commands/export";
import getCommand from "./commands/get";
import importCommand from "./commands/import";
import listCommand from "./commands/list";
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
    file: {
      type: "string",
      alias: "F",
      description: "Path to exported HAEVN archive JSON file",
    },
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
    daemon: daemonCommand,
  },
  async setup(ctx) {
    const { args } = ctx;

    // Configure logging
    if (args.verbose) {
      consola.level = 5; // Debug
    }

    // Store file path for subcommands
    if (args.file) {
      ctx.data.dataFile = args.file;
    }
  },
});

// Run the CLI
runMain(mainCommand);
