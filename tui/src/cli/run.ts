import { NestFactory } from '@nestjs/core';
import { AtlasReadService } from './atlas-read.service.js';
import { CliModule } from './cli.module.js';
import { ECliCommand, USAGE, parseInvocation } from './invocation.js';

/** Usage errors are told apart from misses, so a pipeline can distinguish "you typed it wrong" from
 *  "there is no such job". */
export enum ECliExit {
  ok = 0,
  miss = 1,
  usage = 2,
}

/**
 * Runs one read subcommand and returns the process exit code. Nothing here writes: the CLI is the
 * read half of the agent surface and `advance_phase`, `complete_thread` and friends are tools
 * precisely because they must not be firable from a shell.
 */
export async function runCli(args: readonly string[]): Promise<ECliExit> {
  const parsed = parseInvocation({ args, env: process.env });
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return ECliExit.usage;
  }
  if (parsed.command.name === ECliCommand.help) {
    process.stdout.write(USAGE);
    return ECliExit.ok;
  }

  // Logging off for the same reason the TUI keeps it off: stdout is the command's OUTPUT, and a
  // Nest banner in the middle of a transcript is something the reading model has to explain away.
  const context = await NestFactory.createApplicationContext(CliModule, {
    logger: process.env.ATLAS_DEBUG ? ['log', 'warn', 'error'] : false,
  });
  try {
    const result = await context.get(AtlasReadService).run(parsed.command);
    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      return ECliExit.miss;
    }
    process.stdout.write(`${result.text}\n`);
    return ECliExit.ok;
  } catch (error: unknown) {
    // An agent reads this. A stack trace tells it nothing it can act on, so the message stands
    // alone unless the operator asked for debug output.
    process.stderr.write(`${describe(error)}\n`);
    if (process.env.ATLAS_DEBUG && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    return ECliExit.miss;
  } finally {
    await context.close();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
