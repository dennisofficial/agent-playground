/**
 * `atlas <subcommand>` — the READ half of the agent surface. Reads are cheap, numerous and safe to
 * compose in a shell pipeline, so they are subcommands an agent runs with its Bash tool; writes
 * cross a seam that has to be recorded, tiered and rendered in the transcript, which a shell command
 * cannot do. There is deliberately NO write subcommand here, and adding one would collapse that
 * distinction.
 *
 * Parsing is pure and lives apart from the command handlers so the argv grammar is testable without
 * a database.
 */

export enum ECliCommand {
  threads = 'threads',
  transcript = 'transcript',
  map = 'map',
  ticket = 'ticket',
  help = 'help',
}

export type CliCommand =
  | { name: ECliCommand.threads; jobId: string }
  | { name: ECliCommand.map; jobId: string }
  | { name: ECliCommand.ticket; jobId: string; ticketNumber: number }
  /** `--full` keeps whole tool results; the default trims them, which is most of a transcript's bulk. */
  | { name: ECliCommand.transcript; threadId: string; full: boolean }
  | { name: ECliCommand.help };

export type ParsedInvocation = { ok: true; command: CliCommand } | { ok: false; message: string };

/** Set by the turn's environment so the common case needs no id — `--job` reaches across jobs. */
export const JOB_ID_ENV = 'ATLAS_JOB_ID';

export const USAGE = `atlas — read Atlas's own state. Reads are subcommands; every WRITE is a tool.

  atlas threads [--job <jobId>]         phases -> threads -> sessions for one job
  atlas transcript <threadId> [--full]  one thread's transcript, from the normalised store
  atlas map [--job <jobId>]             the job's map (context/intake/map.md)
  atlas ticket <n> [--job <jobId>]      one numbered ticket from context/intake/
  atlas help

--job defaults to $${JOB_ID_ENV}, which the turn's environment carries. Reading another job is
allowed and is read-only.
`;

const COMMAND_NAMES: ReadonlySet<string> = new Set(Object.values(ECliCommand));

/**
 * Whether argv belongs to the CLI at all. `atlas` and `atlas <path>` open the TUI on a folder, so
 * only an exact subcommand name may steal the process — a project directory called `map` is a
 * stretch, but a bare path must never be misread as a broken subcommand.
 */
export function isCliInvocation(args: readonly string[]): boolean {
  const first = args[0];
  return first !== undefined && COMMAND_NAMES.has(first);
}

export function parseInvocation(args: {
  args: readonly string[];
  env: Record<string, string | undefined>;
}): ParsedInvocation {
  const [name, ...rest] = args.args;
  if (name === undefined || !COMMAND_NAMES.has(name)) {
    return { ok: false, message: `unknown command: ${name ?? '(none)'}\n\n${USAGE}` };
  }

  const flags = readFlags(rest);
  if (!flags.ok) return flags;

  if (name === ECliCommand.help) return { ok: true, command: { name: ECliCommand.help } };

  if (name === ECliCommand.transcript) {
    const threadId = flags.positionals[0];
    if (threadId === undefined) {
      return { ok: false, message: 'atlas transcript needs a thread id: atlas transcript <threadId>' };
    }
    return { ok: true, command: { name: ECliCommand.transcript, threadId, full: flags.full } };
  }

  const jobId = flags.jobId ?? args.env[JOB_ID_ENV];
  if (jobId === undefined || jobId.length === 0) {
    return {
      ok: false,
      message: `no job to read: pass --job <jobId> or run inside a turn, where $${JOB_ID_ENV} is set`,
    };
  }

  if (name === ECliCommand.threads) return { ok: true, command: { name: ECliCommand.threads, jobId } };
  if (name === ECliCommand.map) return { ok: true, command: { name: ECliCommand.map, jobId } };

  const ticketNumber = readTicketNumber(flags.positionals[0]);
  if (ticketNumber === null) {
    return {
      ok: false,
      message: `atlas ticket needs a ticket number: atlas ticket 3 (files are NN-<slug>.md)`,
    };
  }
  return { ok: true, command: { name: ECliCommand.ticket, jobId, ticketNumber } };
}

type Flags =
  | { ok: true; positionals: string[]; jobId: string | undefined; full: boolean }
  | { ok: false; message: string };

/**
 * A hand-rolled scan rather than a parser dependency: four commands, two flags. Unknown flags are
 * rejected instead of ignored, because a silently dropped `--job` reads the WRONG job and looks like
 * a correct answer.
 */
function readFlags(rest: readonly string[]): Flags {
  const positionals: string[] = [];
  let jobId: string | undefined;
  let full = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;

    if (token === '--full') {
      full = true;
      continue;
    }
    if (token === '--job') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, message: '--job needs a job id' };
      }
      jobId = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--job=')) {
      jobId = token.slice('--job='.length);
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, message: `unknown flag: ${token}\n\n${USAGE}` };
    }
    positionals.push(token);
  }

  return { ok: true, positionals, jobId, full };
}

/** `3` and `03` are the same ticket — the number is the identity, the padding is a filename detail. */
function readTicketNumber(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}
