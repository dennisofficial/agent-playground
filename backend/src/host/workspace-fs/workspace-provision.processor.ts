import { EnvService } from '@core/config/env/env.service';
import { Processor } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { Job as QueueJob, UnrecoverableError } from 'bullmq';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { Job } from '../../_lib/database/entities/job.entity';
import { Repo } from '../../_lib/database/entities/repo.entity';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { GithubTokenService } from '../github/github-token.service';
import { ProvisionStatusService } from '../provision-status/provision-status.service';
import { WorkspaceProfileService } from '../workspace-profile/workspace-profile.service';
import { GitCloneService } from './git-clone.service';
import { SecretFileWriter } from './secret-file-writer';
import { WorkspacePathsService } from './workspace-paths.service';

type ProvisionData = { jobId: string };

@Processor(WorkspaceProvisionProcessor.name)
export class WorkspaceProvisionProcessor extends BaseQueue {
  private readonly atlasData: string;

  constructor(
    private readonly db: Db,
    private readonly profile: WorkspaceProfileService,
    private readonly github: GithubTokenService,
    private readonly gitClone: GitCloneService,
    private readonly status: ProvisionStatusService,
    private readonly secretFileWriter: SecretFileWriter,
    private readonly workspacePathsService: WorkspacePathsService,
    env: EnvService,
  ) {
    super();
    this.atlasData = resolve(env.get('ATLAS_DATA'));
  }

  async process(job: QueueJob<ProvisionData>): Promise<void> {
    try {
      await this.prepare(job.data.jobId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  private async prepare(jobId: string): Promise<void> {
    const job = await this.db.unsafe(Job).findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    const repo = await this.db.unsafe(Repo).findOne({ where: { id: job.repoId } });
    if (!repo) throw new NotFoundException(`Repo ${job.repoId} for job ${jobId} not found`);

    const dir = this.workspacePathsService.workspaceDir(this.atlasData, jobId);
    const sentinel = this.workspacePathsService.clonedSentinel(this.atlasData, jobId);
    // warm resume — the workspace is already materialized
    if (await pathExists(sentinel)) return;

    await this.status.write(job, 'preparing', 'Preparing workspace…');
    try {
      const [secrets, token] = await Promise.all([
        this.profile.materializeSecrets(job.repoId),
        this.github.hostToken(job.orgId),
      ]);

      // Pre-sentinel the workspace is disposable — start clean so a retry can't hit a half-clone.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      await this.gitClone.clone({ url: repo.gitUrl, branch: repo.defaultBranch, token, dest: dir });
      await this.secretFileWriter.write(dir, secrets);

      await fs.mkdir(this.workspacePathsService.stateDir(this.atlasData, jobId), {
        recursive: true,
      });
      await fs.writeFile(sentinel, '');
    } catch (err) {
      await this.status.write(job, 'failed', `Workspace prep failed — ${reason(err)}`);
      throw err;
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
