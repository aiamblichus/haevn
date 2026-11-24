/**
 * Backup command – write the whole archive into a directory, for a scheduled job.
 *
 * Usage:
 *   haevn backup ~/backups/haevn            # the archive, into that directory
 *   haevn backup ~/backups/haevn --wait 120 # give Chrome two minutes to connect
 *
 * Every live chat becomes one JSON-lines file and every media file is copied as it is stored, with
 * an `index.jsonl` (sizes and SHA-256 of each file) and a `manifest.json` written last. The run goes
 * into `<dir>.partial` and replaces `<dir>` only when it is complete, so the previous backup stays
 * until a new one is whole. It starts its own daemon when none is listening, and stops it at the end.
 * It needs Chrome open with the HAEVN extension and its CLI bridge on, and the API key in
 * ~/.haevn/config.json (as for `haevn daemon`).
 *
 * Exit code, for a runner that reads it:
 *   0   done: `<dir>` is complete and every file's size was checked against what the extension said
 *   75  not now, ask again: no extension connected within --wait; the connection was lost and did not
 *       return within --wait; the extension is busy (a restore is running); a restore began while
 *       the run was reading, so the run was discarded and `<dir>` is as it was; another `haevn backup` holds `<dir>.partial`
 *   1   failed: anything else (a wrong key, an extension or daemon that is too old, a disk error, a
 *       chat or file that could not be read). One line on stderr says which.
 * On 75 and on 1 `<dir>` is as it was and no `.partial` is left.
 */

import { defineCommand } from "citty";
import { runBackup } from "../backup/engine.js";
import { DEFAULT_DAEMON_PORT, loadConfig } from "../daemon/config.js";
import { flagText, parseWholeNumber } from "../utils/args";
import { ExitError, exitLine, failed } from "../utils/exit.js";

/** A runner kills a run with SIGTERM; the run ends and removes its `.partial` before it exits. */
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

export default defineCommand({
  meta: {
    name: "backup",
    description: "Back up the whole archive into a directory (exit 75 means: not now, try later)",
  },
  args: {
    dir: {
      type: "positional",
      description: "The directory to write the backup to; the previous backup there is replaced",
      required: true,
    },
    wait: {
      type: "string",
      description: "Seconds to wait for the extension to connect, or to come back (default: 60)",
    },
  },
  async run({ args, rawArgs }) {
    const code = await backupExitCode(args.dir, flagText(args.wait, rawArgs, ["--wait"]));
    if (code !== 0) process.exit(code);
  },
});

/** Run the backup and say how it ended: the exit code, with one line on stderr when it is not 0. */
export async function backupExitCode(dir: string, waitText: string | undefined): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    const waitSeconds = parseWholeNumber("wait", waitText, 60);
    const config = loadConfig();
    if (!config.apiKey) {
      throw failed(
        "no API key in ~/.haevn/config.json: copy the key from the extension's Settings page and run `haevn daemon --api-key <key>` once to save it",
      );
    }
    const result = await runBackup({
      dir,
      endpoint: { port: config.port ?? DEFAULT_DAEMON_PORT, apiKey: config.apiKey },
      waitMs: waitSeconds * 1000,
      signal: controller.signal,
      log: (line) => process.stderr.write(`haevn backup: ${line}\n`),
    });
    const vanished =
      result.vanished.length > 0 ? `, ${result.vanished.length} deleted while it ran` : "";
    process.stdout.write(
      `Backed up ${result.chats} chats and ${result.mediaFiles} media files (${megabytes(result.bytes)}) to ${result.dir} in ${(result.ms / 1000).toFixed(1)} s${vanished}.\n`,
    );
    return 0;
  } catch (err) {
    const ended =
      err instanceof ExitError ? err : failed(err instanceof Error ? err.message : String(err));
    process.stderr.write(`${exitLine("haevn backup", ended)}\n`);
    return ended.exitCode;
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
