import { type ArgsDef, type CommandContext, type CommandDef, parseArgs } from "citty";

/**
 * Run a command on the words the user typed. citty parses them with the command's own argument
 * definitions and the command gets the raw words too, as it does in the CLI, so a value citty
 * mis-reads (`--offset -1`) reaches the command exactly as citty leaves it. A test mocks
 * `process.exit` (a refusal exits 1) and the daemon, and reads what the command printed.
 */
export async function runAsTyped<T extends ArgsDef>(
  command: CommandDef<T>,
  rawArgs: string[],
): Promise<void> {
  const args = parseArgs(rawArgs, (command.args ?? {}) as ArgsDef);
  const context = { rawArgs, args, cmd: command } as unknown as CommandContext<T>;
  if (!command.run) throw new Error("the command has no run function");
  await command.run(context);
}
