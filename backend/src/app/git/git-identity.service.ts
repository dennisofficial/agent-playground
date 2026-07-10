import { Injectable } from '@nestjs/common';
import type { SandboxGitIdentity } from '../engine/engine.types';
import { GithubPrService } from './github-pr.service';

/**
 * Resolves the GitHub account that owns an org's push PAT (GET /user) into a commit identity —
 * name + the account's GitHub noreply email (<id>+<login>@users.noreply.github.com), which attributes
 * commits to the account without exposing a personal email. Memoized per token (identity is stable per
 * PAT; a backend restart simply re-resolves). Fail-open: any API error → undefined, so commits still
 * succeed with git's default behavior.
 */
@Injectable()
export class GitIdentityService {
  private readonly cache = new Map<string, SandboxGitIdentity | null>();
  constructor(private readonly github: GithubPrService) {}

  async resolve(token: string | undefined): Promise<SandboxGitIdentity | undefined> {
    if (!token) return undefined;
    if (this.cache.has(token)) return this.cache.get(token) ?? undefined;
    let u: Awaited<ReturnType<GithubPrService['getAuthenticatedUser']>>;
    try {
      u = await this.github.getAuthenticatedUser(token);
    } catch {
      // Transient failure (network blip / 5xx / timeout): fail-open for THIS commit but do NOT
      // cache — a permanent miss would leave every later commit unattributed until a restart.
      return undefined;
    }
    // Definitive outcome (resolved user, or explicit null from a permanent 401/non-OK): cache it.
    const identity: SandboxGitIdentity | null = u
      ? { name: u.name?.trim() || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` }
      : null;
    this.cache.set(token, identity);
    return identity ?? undefined;
  }
}
