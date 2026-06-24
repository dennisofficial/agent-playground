import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasRepo } from '../persistence/entities';

/** A resolved route: the org + repo a notification belongs to (where its seeded thread lives). */
export interface ProjectRoute {
  orgId: string;
  repoId: string;
  repo: AtlasRepo;
}

/**
 * Notification REPO ROUTING — the shared step every `NotificationSource` adapter funnels through after
 * it has extracted a gateway-native identifier (a GitHub `owner/repo`, a generic webhook's repo id).
 * Maps that identifier → an `atlas_repos` row. A repo that maps to no connected repo is `unroutable`
 * (the controller answers 404) — Atlas never works a repo it doesn't own.
 *
 * GitHub repos are matched by their `git_url` (normalized to `owner/repo`, host/scheme/.git-suffix
 * insensitive) so a repo connected as `https://github.com/acme/web.git` routes a webhook for
 * `git@github.com:acme/web`.
 */
@Injectable()
export class ProjectRoutingService {
  private readonly logger = new Logger(ProjectRoutingService.name);

  constructor(
    @InjectRepository(AtlasRepo, ATLAS_CONNECTION)
    private readonly repos: Repository<AtlasRepo>,
  ) {}

  /**
   * Resolve a GitHub `owner/repo` (case-insensitive) to a repo route. A GitHub webhook carries NO org
   * id, so the repo IS the routing key: match across ALL connected repos by normalized `git_url`. Null
   * when nothing matches (→ `unroutable`).
   */
  async routeGithubRepo(ownerRepo: string): Promise<ProjectRoute | null> {
    const target = normalizeRepoSlug(ownerRepo);
    if (!target) return null;
    const candidates = await this.repos.find();
    const match = candidates.find((r) => normalizeRepoSlug(r.git_url) === target);
    if (!match) {
      this.logger.debug(`No atlas_repo matches github repo ${target}`);
      return null;
    }
    return { orgId: match.org_id, repoId: match.repo_id, repo: match };
  }

  /** Resolve a caller-supplied `(orgId, repoId)` to a repo route. Null when not connected. */
  async routeProjectId(orgId: string, repoId: string): Promise<ProjectRoute | null> {
    const match = await this.repos.findOne({ where: { org_id: orgId, repo_id: repoId } });
    if (!match) {
      this.logger.debug(`No atlas_repo ${orgId}/${repoId}`);
      return null;
    }
    return { orgId: match.org_id, repoId: match.repo_id, repo: match };
  }
}

/**
 * Normalize any GitHub repo reference to a bare lower-cased `owner/repo`:
 *   https://github.com/Acme/Web.git → acme/web
 *   git@github.com:Acme/Web.git     → acme/web
 *   Acme/Web                        → acme/web
 * Returns null when no `owner/repo` pair can be extracted.
 */
export function normalizeRepoSlug(ref: string | null | undefined): string | null {
  if (!ref) return null;
  let s = ref.trim();
  s = s.replace(/^[a-z]+:\/\//i, ''); // https:// , ssh://
  s = s.replace(/^git@[^:]+:/i, ''); // git@github.com:
  s = s.replace(/^[^/]+\//, (m) => (m.includes('.') ? '' : m)); // drop a leading host segment (github.com/)
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return `${owner}/${repo}`.toLowerCase();
}
