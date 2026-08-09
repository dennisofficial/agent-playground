import { homedir } from 'node:os';
import { join } from 'node:path';

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
  /** CLAUDE_CONFIG_DIR points here. */
  claudeHome: join(ATLAS_HOME, 'claude-home'),
  /** CODEX_HOME points here. */
  codexHome: join(ATLAS_HOME, 'codex-home'),
} as const;

export function claudeCredentialsFile(): string {
  return join(ATLAS_PATHS.claudeHome, '.credentials.json');
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

/** The job-scoped folder every thread in the job reads and writes. */
export function jobContextDir(jobId: string): string {
  return join(jobDir(jobId), 'context');
}

/** `specs/` is a planning SET, not a file. */
export const CONTEXT_BUCKETS = ['specs', 'generated', 'artifacts'] as const;
export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];
