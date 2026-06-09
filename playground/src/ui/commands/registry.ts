import { approveCommand, approveTicketCommand, rejectCommand } from './approval.js';
import { standupCommand, ticketsCommand } from './board.js';
import { exitCommand } from './exit.js';
import { asCommand } from './speaker.js';
import { tasksCommand } from './tasks.js';
import type { Command, CommandContext } from './types.js';

/**
 * The slash-command registry. Each command owns its own recognition (a verbatim port of the old `App.tsx`
 * branch's exact-string / regex test) and declines by returning `false`, so the caller can fall through to
 * channel submit exactly as before. Add a command = new module + one entry here; nothing else changes.
 *
 * Order is not correctness-critical — the commands' conditions are mutually exclusive (notably
 * `/^\/approve\s+/i` cannot match `/approve-ticket…`, whose next char is `-`, not whitespace); the
 * approve-ticket entry sits ahead of approve only defensively.
 */
export const COMMANDS: Command[] = [
  exitCommand,
  tasksCommand,
  asCommand,
  approveTicketCommand,
  approveCommand,
  rejectCommand,
  ticketsCommand,
  standupCommand,
];

/** Run the first command that accepts `text`; return `false` if none did (caller falls through to chat). */
export function runCommand(text: string, ctx: CommandContext): boolean {
  for (const cmd of COMMANDS) if (cmd.run(text, ctx)) return true;
  return false;
}
