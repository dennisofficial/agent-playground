import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Atlas OWNS everything under `~/.atlas` — it does not read, merge with, or respect the user's
 * personal `~/.claude` / `~/.codex`, which is what makes "swap the active account's credential
 * before a turn" safe rather than destructive.
 *
 * One home per ENGINE, never per account: the config dir holds session and transcript storage as
 * well as credentials, so a per-account home would fragment transcripts and break rotation.
 */
export const ATLAS_HOME = join(homedir(), '.atlas');

export const ATLAS_PATHS = {
  home: ATLAS_HOME,
  database: join(ATLAS_HOME, 'atlas.db'),
  /** AES-256-GCM key for `Account.materialEnc`, mode 0600. */
  key: join(ATLAS_HOME, 'key'),
  versionCheck: join(ATLAS_HOME, 'version-check.json'),
  /**
   * Where a harness fault goes to be read later. A file rather than the Nest logger because that
   * logger is `false` unless `ATLAS_DEBUG` is set — stdout corrupts the frame — so the default
   * install has nowhere for a stack to land, and a fault nobody can see is one nobody can fix.
   */
  faults: join(ATLAS_HOME, 'faults.log'),
  /** CLAUDE_CONFIG_DIR points here. */
  claudeHome: join(ATLAS_HOME, 'claude-home'),
  /** CODEX_HOME points here. */
  codexHome: join(ATLAS_HOME, 'codex-home'),
} as const;

/**
 * `~` as the shell would have read it — for the paths the shell never saw.
 *
 * A folder typed into Atlas's own prompt (`n` on the projects page) reaches us verbatim, so
 * `~/Developer/foo` was being handed to `resolve()`, which treats `~` as an ordinary directory name
 * and produced `<cwd>/~/Developer/foo`. `atlas '~/foo'` had the same hole, quoting having stopped
 * the shell from expanding it.
 *
 * Only a leading bare `~` expands. `~user` is left alone rather than guessed at: resolving another
 * account's home is a passwd lookup, and silently reading it as the current user's home would open
 * the wrong folder instead of reporting an honest miss.
 *
 * `home` is a parameter so a test can name a home without inheriting the machine's.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/**
 * Copies of the database taken immediately before a migration is applied.
 *
 * The app migrates itself on every start with no undo and no prompt, so the only moment it can
 * cheaply protect the user is the moment before it changes their data. One dropped column once
 * cascade-deleted every transcript in the database; this is what makes that recoverable rather
 * than merely regrettable.
 */
export function databaseBackupDir(
  databaseFile: string = ATLAS_PATHS.database,
): string {
  // Beside the database it protects, not under a fixed home: the migrator is handed a file path,
  // and a backup written somewhere else is one nobody thinks to look for.
  return join(dirname(databaseFile), 'backups');
}

export function databaseBackupFile(args: {
  databaseFile?: string;
  stamp: string;
}): string {
  return join(databaseBackupDir(args.databaseFile), `atlas-${args.stamp}.db`);
}

/**
 * The file the engine reads its credential from — and writes back to, when it refreshes the token
 * itself. `home` is a parameter only so a test can point at a temp directory: `ATLAS_PATHS` resolves
 * the real home at module load, long before a `beforeAll` could redirect it.
 */
export function claudeCredentialsFile(home: string = ATLAS_PATHS.claudeHome): string {
  return join(home, '.credentials.json');
}

/** Append-only tape of exactly what the SDK emitted. Keyed by session, not thread. */
export function sessionTapeDir(engineSessionId: string): string {
  return join(ATLAS_HOME, 'sessions', engineSessionId);
}

export function sessionTapeFile(engineSessionId: string): string {
  return join(sessionTapeDir(engineSessionId), 'raw.jsonl');
}

/** Everything Atlas keeps for one job. Deleting a job removes this whole tree. */
export function jobDir(jobId: string): string {
  return join(ATLAS_HOME, 'jobs', jobId);
}

/**
 * Where a file pasted into a draft is written: `context/uploads/`, beside the job's other material.
 *
 * Inside the CONTEXT folder rather than off to one side, because the agent already knows that
 * folder and already has a Read tool pointed at it — so a picture that was too big to inline, or a
 * session that rotated past the one that saw it, is still reachable by path instead of lost. This
 * is the arrangement the paused cloud harness used (`context/uploads/`), and it was right.
 *
 * Deliberately NOT one of `CONTEXT_BUCKETS`: those three are a phase hand-off's material, with
 * rules about what belongs in each. This is a person pasting a screenshot.
 *
 * Under the JOB, not in a temp dir: the transcript keeps referring to it long after the turn, and
 * `/tmp` is swept out from under it. Deleting the job takes its uploads with it, which is the
 * promise `jobDir` already makes about everything else in there.
 */
export function jobUploadFile(args: {
  jobId: string;
  /** Unique within the job — a draft's ordinal is not, across two drafts. */
  name: string;
}): string {
  return join(jobContextDir(args.jobId), 'uploads', args.name);
}

/** What the agent is told to call an upload — the same `context/…` shape as everything else. */
export function uploadLabel(name: string): string {
  return `context/uploads/${name}`;
}

/** The job-scoped folder every thread in the job reads and writes. */
export function jobContextDir(jobId: string): string {
  return join(jobDir(jobId), 'context');
}

/**
 * Which terminal is driving this job. A file rather than a database row precisely so it can be
 * WATCHED — `fs.watch` gives every other tile the takeover the instant it happens, where a row
 * would have to be polled.
 */
export function jobClaimFile(jobId: string): string {
  return join(jobDir(jobId), 'claim.json');
}

/**
 * The three buckets, ordered by the phase that writes them: `charting/` holds the job's map and its
 * ticket files, `specs/` is a planning SET rather than a file, `artifacts/` is things to look at.
 * `generated/` is gone — hand-offs are the next session's first message, not files, so it had no
 * writer left.
 */
export const CONTEXT_BUCKETS = ['charting', 'specs', 'artifacts'] as const;
export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];
