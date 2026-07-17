import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity } from '../persistence/entities';

export interface ProjectRoute {
  orgId: string;
  repoId: string;
  repo: RepoEntity;
}

@Injectable()
export class ProjectRoutingService {
  private readonly logger = new Logger(ProjectRoutingService.name);

  constructor(
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  async routeGithubRepo(ownerRepo: string): Promise<ProjectRoute | null> {
    const target = normalizeRepoSlug(ownerRepo);
    if (!target) return null;
    const candidates = await this.repos.find();
    const match = candidates.find((r) => normalizeRepoSlug(r.git_url) === target);
    if (!match) {
      this.logger.debug(`No repo matches github repo ${target}`);
      return null;
    }
    return { orgId: match.org_id, repoId: match.id, repo: match };
  }

  async routeProjectId(orgId: string, repoId: string): Promise<ProjectRoute | null> {
    const match = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!match) {
      this.logger.debug(`No repo ${orgId}/${repoId}`);
      return null;
    }
    return { orgId: match.org_id, repoId: match.id, repo: match };
  }
}

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
