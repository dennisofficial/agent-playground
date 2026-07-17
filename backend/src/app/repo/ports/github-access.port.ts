import { Injectable } from '@nestjs/common';

/** Result of probing whether an org's GitHub auth can reach a repo. */
export interface RepoProbe {
  accessOk: boolean;
  /** Human reason when `accessOk === false`. */
  reason?: string;
  /** Set when `accessOk === true`. */
  defaultBranch?: string;
}

/**
 * Everything the repos slice needs from GitHub. Implemented by the (future) GitHub module and bound
 * to {@link GITHUB_ACCESS_PORT}. The repos slice never imports GitHub code — it only depends on this
 * port, so wiring the real module in is a drop-in provider swap (see `app/github/HANDOFF.md`).
 */
export interface GithubAccessPort {
  /** Does the org have a usable GitHub credential? Drives the connect gate + `hasGithub`. */
  hasGithub(orgId: string): Promise<boolean>;

  /** Probe whether the org's GitHub auth can reach owner/repo; returns default branch on success. */
  probeRepo(orgId: string, owner: string, repo: string): Promise<RepoProbe>;

  /**
   * Live branch list (default branch first). `null` when unavailable (no token / API error) — the
   * caller falls back to `[repo.defaultBranch]`.
   */
  listBranches(
    orgId: string,
    owner: string,
    repo: string,
  ): Promise<{ branches: string[]; defaultBranch: string } | null>;

  /**
   * Best-effort webhook registration for real-time PR sync. Returns a warning string to surface on
   * the repo, or `null` when healthy / not applicable.
   */
  ensureWebhook(orgId: string, owner: string, repo: string): Promise<string | null>;
}

/** DI token for the {@link GithubAccessPort}. */
export const GITHUB_ACCESS_PORT = Symbol('GITHUB_ACCESS_PORT');

/**
 * Default binding until the GitHub module exists: repos connect as unvalidated (`accessOk:false`),
 * branch listing falls back to the stored default branch, and `hasGithub` is false. Repos are still
 * fully functional and realtime — they just aren't GitHub-validated yet.
 */
@Injectable()
export class NoopGithubAccess implements GithubAccessPort {
  async hasGithub(): Promise<boolean> {
    return false;
  }

  async probeRepo(): Promise<RepoProbe> {
    return { accessOk: false, reason: 'GitHub is not configured yet.' };
  }

  async listBranches(): Promise<{ branches: string[]; defaultBranch: string } | null> {
    return null;
  }

  async ensureWebhook(): Promise<string | null> {
    return null;
  }
}
