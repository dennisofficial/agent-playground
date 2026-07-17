import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from '@shared/domain';
import type { SandboxGitIdentity } from '@shared/engine/engine.types';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity } from '../persistence/entities';
import { LocalGitService, ProjectRepo } from '../git/local-git.service';
import { GitIdentityService } from '../git/git-identity.service';
import { parseGithubRepoUrl } from '../git/github-pr.service';

/** The DI token for the repo resolver — a seam so the driver test can bind a fake (no real git/clone). */
export const DRIVER_REPO = Symbol('DRIVER_REPO');

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
  /** The commit identity of the PAT's GitHub account (resolved via GET /user); undefined → fail-open (git defaults). */
  identity?: SandboxGitIdentity;
}

/** The narrow surface the driver consumes — resolve a thread's repo into a ready-to-use clone. */
export interface DriverRepoResolver {
  resolve(thread: Job): Promise<ResolvedRepo>;
}

/**
 * W4 — resolve a job's project (`repos` row) into a ready-to-use repo: clone/locate the repo on
 * disk (host-only, daemon-free), parse the owner/repo, and resolve the GitHub token from env. Behind a
 * DI token so the driver's unit tests bind a fake (no real clone/network). Mirrors how the W1 acceptance
 * gate resolved its repo. Zero v1 imports.
 */
@Injectable()
export class GitDriverRepoResolver implements DriverRepoResolver {
  constructor(
    private readonly creds: CredentialResolver,
    private readonly git: LocalGitService,
    private readonly identities: GitIdentityService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly projects: Repository<RepoEntity>,
  ) {}

  async resolve(thread: Job): Promise<ResolvedRepo> {
    const project = await this.projects.findOne({
      where: { id: thread.repoId },
    });
    if (!project) {
      throw new Error(
        `No repos row for id=${thread.repoId} (org=${thread.orgId})`,
      );
    }
    const parsed = parseGithubRepoUrl(project.git_url);
    if (!parsed) {
      throw new Error(
        `Repo ${project.slug} git_url is not an HTTPS GitHub URL: ${project.git_url}`,
      );
    }
    const token = await this.creds.hostGithubToken(thread.orgId);
    const identity = await this.identities.resolve(token);
    // The repo's SLUG is the on-disk clone/worktree identity (human-readable), NOT the uuid id.
    const projectRepo = await this.git.ensureRepo({
      repoId: project.slug,
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
      ...(identity ? { identity } : {}),
    };
  }
}
