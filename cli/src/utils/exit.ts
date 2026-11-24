/**
 * Exit codes for a command that an unattended runner reads (`haevn backup`).
 *
 * 0 is done. 75 (`EX_TEMPFAIL`) is "not now, ask again later": Chrome is closed, the bridge is off,
 * the extension is busy, another run holds the directory. Anything else is a failure the runner
 * reports. The split matters to the runner, so a command throws one of these and says which in one
 * line, and the command's `run` turns it into the exit code.
 */

export const EXIT_FAILED = 1;
export const EXIT_DEFER = 75;

export type ExitCode = typeof EXIT_FAILED | typeof EXIT_DEFER;

/** A run that ended without finishing. `exitCode` is what the process exits with. */
export class ExitError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = "ExitError";
    this.exitCode = exitCode;
  }
}

/** Not now (75): nothing is wrong that waiting will not mend. */
export function deferred(message: string): ExitError {
  return new ExitError(EXIT_DEFER, message);
}

/** Failed (1). */
export function failed(message: string): ExitError {
  return new ExitError(EXIT_FAILED, message);
}

/** The one stderr line for an ended run: the command, which case it was, and why. */
export function exitLine(command: string, err: ExitError): string {
  const kind = err.exitCode === EXIT_DEFER ? "not now (exit 75)" : "failed (exit 1)";
  return `${command}: ${kind}: ${err.message}`;
}
