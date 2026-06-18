import { Injectable } from '@nestjs/common';

/**
 * The git credential a daemon turn resolves at the moment it touches the network: a GitHub token
 * (rides in `GIT_CONFIG_*` via `gitAuthEnv`, never in argv/url/config) plus the author identity the
 * in-workspace per-worktree git config is set to (so commits are attributed to the agent, not the
 * image's default git identity).
 */
export interface ResolvedGitCredential {
  /** The GitHub token (PAT today, an Atlas GitHub-App token later). */
  token: string;
  /** The git author name set on every per-session worktree (`user.name`). */
  authorName: string;
  /** The git author email set on every per-session worktree (`user.email`). */
  authorEmail: string;
}

/**
 * DI token + port for resolving the daemon's git credential.
 *
 * Deliberately ASYNC and PER-CALL (not a constructor-time value) so a future GitHub-App provider can
 * mint a short-lived installation token on demand — `DaemonGitService` calls `resolve()` immediately
 * before each authenticated git op, so a freshly-minted token is always current. The env impl below
 * is the PAT path; Phase 5 swaps in a Redis-pull impl (`ws:{id}:cred-req`) behind this SAME token,
 * leaving `DaemonGitService` untouched.
 */
export const GIT_CREDENTIAL_PROVIDER = Symbol('GIT_CREDENTIAL_PROVIDER');

export interface GitCredentialProvider {
  /** The current credential for this sandbox's repo. Throws if no token is available. */
  resolve(): Promise<ResolvedGitCredential>;
}

/**
 * The PAT (env-backed) credential provider — the v1 / dev / standalone path. Reads the token + author
 * identity from the daemon's ambient env:
 *  - `GIT_TOKEN` — the GitHub PAT (required for any authenticated op against an HTTPS GitHub remote;
 *    a file:// fixture or an already-public repo needs none, so resolve() only throws when a caller
 *    actually needs the token — see `DaemonGitService`).
 *  - `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` — the commit author identity, defaulted to a generic agent
 *    identity so unattributed commits still have a stable, non-host author.
 *
 * Read straight from `process.env` (not via `EnvService`): the daemon binds the host `EnvService`
 * typed over the host `IEnvConfig`, which doesn't carry the GIT_* keys; they validate through the
 * daemon's `.unknown(true)` schema (declared in IDaemonEnvConfig for documentation) and are read here
 * the same way main.ts reads PORT. Phase 5 binds a Redis-pull impl to `GIT_CREDENTIAL_PROVIDER`
 * instead; this stays as the fallback.
 */
@Injectable()
export class EnvGitCredentialProvider implements GitCredentialProvider {
  async resolve(): Promise<ResolvedGitCredential> {
    return {
      token: process.env.GIT_TOKEN ?? '',
      authorName: process.env.GIT_AUTHOR_NAME ?? 'Agent',
      authorEmail: process.env.GIT_AUTHOR_EMAIL ?? 'agent@agents.noreply',
    };
  }
}
