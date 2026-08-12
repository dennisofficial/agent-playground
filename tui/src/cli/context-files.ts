import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { found, missing, type CliResult } from './result.js';
import { MAP_FILE, matchTicket, ticketIndex } from './tickets.js';

/**
 * The two cheapest reads there are: the job's map and one numbered ticket. They exist as
 * subcommands so the common case needs no path at all — `Read`/`Write` take a literal absolute path
 * with no shell expansion, so `$ATLAS_JOB_DIR/context/intake/map.md` would be read as a filename
 * containing a `$`.
 *
 * Takes the directory rather than a job id: the fs half is then testable against a temp folder, and
 * resolving a job to its folder stays in one place.
 */

export function readMap(intakeDir: string): CliResult {
  const path = join(intakeDir, MAP_FILE);
  const text = read(path);
  if (text === null) return missing(`no map yet — intake writes it to ${path}`);
  return found(withPath({ path, text }));
}

export function readTicket(args: { intakeDir: string; ticketNumber: number }): CliResult {
  const fileNames = list(args.intakeDir);
  const matches = matchTicket({ fileNames, ticketNumber: args.ticketNumber });

  if (matches.length === 0) {
    const index = ticketIndex(fileNames);
    const known =
      index.length === 0
        ? `no ticket files in ${args.intakeDir}`
        : ['tickets in this job:', ...index].join('\n');
    return missing(`no ticket ${args.ticketNumber} — ${known}`);
  }

  // Every claimant, never the first: `03-foo.md` and `3-bar.md` are one ticket by identity, and
  // silently picking one hands the agent a document the map does not link.
  const [ticket] = matches;
  if (matches.length > 1 || ticket === undefined) {
    const names = matches.map((match) => `  ${match.fileName}`).join('\n');
    return missing(`ticket ${args.ticketNumber} is ambiguous — more than one file claims it:\n${names}`);
  }

  const path = join(args.intakeDir, ticket.fileName);
  const text = read(path);
  if (text === null) return missing(`cannot read ${path}`);
  return found(withPath({ path, text }));
}

/** The absolute path leads, because the follow-up move is usually `Edit` on that exact file. */
function withPath(args: { path: string; text: string }): string {
  return `${args.path}\n\n${args.text.trimEnd()}`;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
