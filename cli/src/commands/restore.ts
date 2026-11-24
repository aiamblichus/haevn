/**
 * Restore command – put a `haevn backup` directory back into the archive.
 *
 * Usage:
 *   haevn restore ~/backups/haevn --dry-run     # what it would do, and nothing else
 *   haevn restore ~/backups/haevn               # shows that, asks, then restores
 *   haevn restore ~/backups/haevn --chat <id>   # one chat (repeat the flag for more)
 *   haevn restore ~/backups/haevn --yes         # no question: for a terminal-less run
 *
 * Three rules, and nothing else: a chat or media file whose id exists is replaced by the backup's
 * copy; what is missing is added; nothing else is touched (the only other write is the derived
 * chat count of each provider the restore touched). Chats deleted since the backup come back.
 * It needs Chrome open with the HAEVN extension and its CLI bridge on, and the API key in
 * ~/.haevn/config.json (as for `haevn backup`). It starts its own daemon when none is listening.
 *
 * Before anything is written the backup is checked: its manifest says it is a haevn backup of a
 * version this CLI reads, the extension's archive is not older than the backup's, and every file's
 * size and SHA-256 match `index.jsonl`. A damaged backup is refused (1) with nothing written.
 *
 * Exit code:
 *   0   done: every selected chat and file is in the archive (with --dry-run: checked, nothing written)
 *   75  not now, ask again: no extension connected within --wait; the extension is busy (another
 *       operation holds its lock, or a restore is open); the connection was lost and did not
 *       return within --wait
 *   1   failed: anything else (a damaged or unknown backup, a refusal at the prompt or no --yes
 *       with no terminal, a wrong key, an old extension, a chat the extension refused). When the
 *       restore had begun, the line says that running the same command again finishes it.
 */

import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { defineCommand } from "citty";
import { confirmQuestion, formatPlan, type RestorePlan, size } from "../backup/plan.js";
import { runRestore } from "../backup/restoreEngine.js";
import { DEFAULT_DAEMON_PORT, loadConfig } from "../daemon/config.js";
import { flagText, parseWholeNumber, repeatedFlag } from "../utils/args";
import { ExitError, exitLine, failed } from "../utils/exit.js";

/** A runner kills a run with SIGTERM; the run ends and tells the extension to close the restore. */
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

export default defineCommand({
  meta: {
    name: "restore",
    description:
      "Put a backup made by `haevn backup` back into the archive (replaces by id, adds what is missing, deletes nothing)",
  },
  args: {
    dir: {
      type: "positional",
      description: "The backup directory",
      required: true,
    },
    chat: {
      type: "string",
      description: "Restore only this chat id (repeat the flag for more chats)",
    },
    "dry-run": {
      type: "boolean",
      description: "Check the backup and say what would be replaced and added; write nothing",
      default: false,
    },
    yes: {
      type: "boolean",
      description: "Do not ask first (required when there is no terminal)",
      default: false,
    },
    wait: {
      type: "string",
      description: "Seconds to wait for the extension to connect, or to come back (default: 60)",
    },
  },
  async run({ args, rawArgs }) {
    const code = await restoreExitCode({
      dir: args.dir,
      rawArgs,
      dryRun: args["dry-run"],
      yes: args.yes,
      waitText: flagText(args.wait, rawArgs, ["--wait"]),
    });
    if (code !== 0) process.exit(code);
  },
});

export interface RestoreCommand {
  dir: string;
  /** The arguments as typed: `--chat` may be repeated, and the parser keeps only one. */
  rawArgs: readonly string[];
  dryRun: boolean;
  yes: boolean;
  waitText: string | undefined;
}

/** What the command needs from the terminal; tests pass their own. */
export interface Terminal {
  /** A person can be asked. */
  interactive: boolean;
  /** The question, and what was answered. */
  ask(question: string): Promise<string>;
}

/** Run the restore and say how it ended: the exit code, with one line on stderr when it is not 0. */
export async function restoreExitCode(
  command: RestoreCommand,
  terminal: Terminal = processTerminal(),
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    const waitSeconds = parseWholeNumber("wait", command.waitText, 60);
    const chatIds = repeatedFlag(command.rawArgs, ["--chat"]);
    if (!command.dryRun && !command.yes && !terminal.interactive) {
      throw failed(
        "restore changes your archive and there is no terminal to ask on: run it with --dry-run to see what it would do, then with --yes to do it",
      );
    }
    const config = loadConfig();
    if (!config.apiKey) {
      throw failed(
        "no API key in ~/.haevn/config.json: copy the key from the extension's Settings page and run `haevn daemon --api-key <key>` once to save it",
      );
    }
    const result = await runRestore({
      dir: command.dir,
      endpoint: { port: config.port ?? DEFAULT_DAEMON_PORT, apiKey: config.apiKey },
      waitMs: waitSeconds * 1000,
      chatIds,
      dryRun: command.dryRun,
      signal: controller.signal,
      log: (line) => process.stderr.write(`haevn restore: ${line}\n`),
      confirm: async (plan: RestorePlan) => {
        process.stdout.write(`${formatPlan(plan)}\n\n`);
        if (command.yes) return true;
        const answer = await terminal.ask(confirmQuestion(plan));
        return /^\s*y(es)?\s*$/i.test(answer);
      },
    });

    if (result.dryRun) {
      process.stdout.write(`${formatPlan(result.plan)}\n\nDry run: nothing was written.\n`);
    } else if (result.plan.chats === 0) {
      process.stdout.write("The backup holds no chats: nothing to restore.\n");
    } else {
      process.stdout.write(
        `Restored ${result.plan.chats} ${result.plan.chats === 1 ? "chat" : "chats"} (${result.replaced} replaced, ${result.added} added) and ${result.mediaFiles} media ${
          result.mediaFiles === 1 ? "file" : "files"
        } (${size(result.bytes)}) in ${(result.ms / 1000).toFixed(1)} s.\n`,
      );
    }
    return 0;
  } catch (err) {
    const ended =
      err instanceof ExitError ? err : failed(err instanceof Error ? err.message : String(err));
    process.stderr.write(`${exitLine("haevn restore", ended)}\n`);
    return ended.exitCode;
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
}

/** The real terminal: a person is there when both stdin and stdout are one. */
function processTerminal(): Terminal {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: (question) => askLine(question, process.stdin, process.stdout),
  };
}

/** Ask one question and read one line. The end of the input (Ctrl-D) is an empty answer: no. */
export function askLine(question: string, input: Readable, output: Writable): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise<string>((resolve) => {
    // `close` ends the question too: the answer must be settled before the interface is closed
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
    rl.once("close", () => resolve(""));
  });
}
