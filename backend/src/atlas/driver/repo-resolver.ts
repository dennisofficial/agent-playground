import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from '../domain';
import { LocalGitService, parseGithubRepoUrl, type ProjectRepo } from '../git';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasProject } from '../persistence/entities';

/** The DI token for the repo resolver — a seam so the driver test can bind a fake (no real git/clone). */
export const ATLAS_DRIVER_REPO = Symbol('ATLAS_DRIVER_REPO');

/** Everything the driver needs to clone, cut a worktree, push, and open a PR for a job's project. */
export interface ResolvedRepo {
  /** The cloned/located project repo handle (passed to `createFeatureSandbox`). */
  projectRepo: ProjectRepo;
  /** PR owner (parsed from the git url). */
  owner: string;
  /** PR repo name (parsed from the git url). */
  repo: string;
  /** The PR base / default branch. */
  defaultBranch: string;
  /** The GitHub token for push + PR (env-resolved); undefined → public-only / no PR. */
  token?: string;
}

/** The narrow surface the driver consumes — resolve a job into a ready-to-use repo. */
export interface DriverRepoResolver {
  resolve(job: Job): Promise<ResolvedRepo>;
}

/**
 * W4 — resolve a job's project (`atlas_projects` row) into a ready-to-use repo: clone/locate the repo on
 * disk (host-only, daemon-free), parse the owner/repo, and resolve the GitHub token from env. Behind a
 * DI token so the driver's unit tests bind a fake (no real clone/network). Mirrors how the W1 acceptance
 * gate resolved its repo. Zero v1 imports.
 */
@Injectable()
export class GitDriverRepoResolver implements DriverRepoResolver {
  constructor(
    private readonly env: EnvService,
    private readonly git: LocalGitService,
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
  ) {}

  async resolve(job: Job): Promise<ResolvedRepo> {
    const project = await this.projects.findOne({
      where: { team_id: job.teamId, project_id: job.projectId },
    });
    if (!project) {
      throw new Error(`No atlas_projects row for team=${job.teamId} project=${job.projectId}`);
    }
    const parsed = parseGithubRepoUrl(project.git_url);
    if (!parsed) {
      throw new Error(`Project ${job.projectId} git_url is not an HTTPS GitHub URL: ${project.git_url}`);
    }
    const token = this.token();
    const projectRepo = await this.git.ensureRepo({
      projectId: job.projectId,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });
    return {
      projectRepo,
      owner: parsed.owner,
      repo: parsed.repo,
      defaultBranch: projectRepo.defaultBranch,
      ...(token ? { token } : {}),
    };
  }

  /** The GitHub token Atlas uses for push + PR — ATLAS_GITHUB_TOKEN, else GITHUB_TOKEN, else none. */
  private token(): string | undefined {
    return this.env.get('ATLAS_GITHUB_TOKEN') ?? this.env.get('GITHUB_TOKEN');
  }
}
