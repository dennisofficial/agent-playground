import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from '@shared/domain';
import type { SandboxGitIdentity } from '@shared/engine/engine.types';
import { Repository } from 'typeorm';
import { GitIdentityService } from '../git/git-identity.service';
import { parseGithubRepoUrl } from '../git/github-pr.service';
import { LocalGitService, ProjectRepo } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity } from '../persistence/entities';

export const DRIVER_REPO = Symbol('DRIVER_REPO');

export interface ResolvedRepo {
  projectRepo: ProjectRepo;
  owner: string;
  repo: string;
  defaultBranch: string;
  token?: string;
  identity?: SandboxGitIdentity;
}

export interface DriverRepoResolver {
  resolve(thread: Job): Promise<ResolvedRepo>;
}

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
      throw new Error(`No repos row for id=${thread.repoId} (org=${thread.orgId})`);
    }
    const parsed = parseGithubRepoUrl(project.git_url);
    if (!parsed) {
      throw new Error(
        `Repo ${project.slug} git_url is not an HTTPS GitHub URL: ${project.git_url}`,
      );
    }
    const token = await this.creds.hostGithubToken(thread.orgId);
    const identity = await this.identities.resolve(token);
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
