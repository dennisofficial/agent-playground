import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasChannel, AtlasProject } from '../persistence/entities';

/** A resolved route: the project a notification belongs to + its 1:1 channel. */
export interface ProjectRoute {
  teamId: string;
  projectId: string;
  /** The 1:1 channel row for the project (where the seeded thread lives). */
  channel: AtlasChannel;
  project: AtlasProject;
}

/**
 * Notification PROJECT ROUTING — the shared step every `NotificationSource` adapter funnels through
 * after it has extracted a gateway-native identifier (a GitHub `owner/repo`, a generic webhook's
 * `projectId`). Maps that identifier → an `atlas_projects` row → its 1:1 `atlas_channels` row, the
 * channel the seeded thread opens in.
 *
 * Tenancy: `team_id` ⊃ `projects` ⊃ one `channel` per project. An MVP single-tenant deploy has one
 * `atlas_team`; the adapter still passes `teamId` so multi-tenant routing needs no rework. A repo that
 * maps to no registered project is `unroutable` (the controller answers 404) — Atlas never works a
 * repo it doesn't own.
 *
 * GitHub repos are matched by their `git_url` (normalized to `owner/repo`, host/scheme/.git-suffix
 * insensitive) so a project registered as `https://github.com/acme/web.git` routes a webhook for
 * `git@github.com:acme/web`. Zero v1 imports.
 */
@Injectable()
export class ProjectRoutingService {
  private readonly logger = new Logger(ProjectRoutingService.name);

  constructor(
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
    @InjectRepository(AtlasChannel, ATLAS_CONNECTION)
    private readonly channels: Repository<AtlasChannel>,
  ) {}

  /**
   * Resolve a GitHub `owner/repo` (case-insensitive) to a project route. A GitHub webhook carries NO
   * Slack team id, so the repo IS the tenant key: we match across ALL registered projects (every team)
   * by normalized `git_url`. This keeps GitHub multi-tenant-ready with no per-payload team — a repo is
   * registered to exactly one project, which carries its `team_id`. Returns null when no project's
   * `git_url` matches (→ `unroutable`). The matched project's `team_id` is the resolved tenant.
   */
  async routeGithubRepo(ownerRepo: string): Promise<ProjectRoute | null> {
    const target = normalizeRepoSlug(ownerRepo);
    if (!target) return null;
    // Repo is the routing key across teams — load candidates and match by normalized slug. (Projects
    // are few; an in-memory match is fine and avoids a non-normalized SQL comparison.)
    const candidates = await this.projects.find();
    const match = candidates.find((p) => normalizeRepoSlug(p.git_url) === target);
    if (!match) {
      this.logger.debug(`No atlas_project matches github repo ${target}`);
      return null;
    }
    return this.attachChannel(match);
  }

  /**
   * Resolve a caller-supplied `projectId` (the generic webhook's routing key) to a project route.
   * Returns null when the project isn't registered for the tenant.
   */
  async routeProjectId(teamId: string, projectId: string): Promise<ProjectRoute | null> {
    const match = await this.projects.findOne({
      where: { team_id: teamId, project_id: projectId },
    });
    if (!match) {
      this.logger.debug(`No atlas_project ${teamId}/${projectId}`);
      return null;
    }
    return this.attachChannel(match);
  }

  private async attachChannel(project: AtlasProject): Promise<ProjectRoute | null> {
    const channel = await this.channels.findOne({
      where: { team_id: project.team_id, project_id: project.project_id },
    });
    if (!channel) {
      // A project with no channel is a misconfiguration — log loudly and treat as unroutable rather
      // than seeding a thread into a channel that doesn't exist.
      this.logger.warn(
        `atlas_project ${project.team_id}/${project.project_id} has no 1:1 atlas_channel — unroutable`,
      );
      return null;
    }
    return {
      teamId: project.team_id,
      projectId: project.project_id,
      project,
      channel,
    };
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
  // Strip scheme + host for https/ssh URLs, leaving the path.
  s = s.replace(/^[a-z]+:\/\//i, ''); // https:// , ssh://
  s = s.replace(/^git@[^:]+:/i, ''); // git@github.com:
  s = s.replace(/^[^/]+\//, (m) => (m.includes('.') ? '' : m)); // drop a leading host segment (github.com/)
  s = s.replace(/\.git$/i, '');
  s = s.replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // Last two path segments are owner/repo (covers enterprise hosts with extra path prefixes).
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return `${owner}/${repo}`.toLowerCase();
}
