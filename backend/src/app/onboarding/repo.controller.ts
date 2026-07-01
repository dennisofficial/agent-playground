import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsOptional, IsString } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, JobEntity } from '../persistence/entities';
import { OnboardingService, type ConnectedRepo } from './onboarding.service';

class ConnectRepoDto {
  @IsString() repoUrl!: string;
  @IsOptional() @IsString() baseBranch?: string;
  @IsOptional() @IsString() displayName?: string;
}

class UpdateRepoDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() defaultBranch?: string;
}

/** A repo as the web app lists it. */
interface RepoView {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
  /** When access was last validated (ISO), or null if never checked. */
  accessCheckedAt: string | null;
  /** How many threads live on this repo — gates whether it can be disconnected. */
  threadCount: number;
  /** The id of the repo's current onboarding thread (`kind='onboarding'`), or null if never started. */
  onboardingThreadId: string | null;
  /** When onboarding completed (worktree config live), ISO; null until then — drives "Set up" vs "Re-run". */
  onboardedAt: string | null;
}

/**
 * `/web/orgs/:orgId/repos` — connect + list the org's GitHub repos. POST validates reachability with the
 * org's token (persisting `access_ok`) and tries to activate the org. Membership-gated; connecting (POST)
 * is an Administer action — owner only (`OrgOwnerGuard`) since it consumes the org's GitHub token.
 */
@Controller('web/orgs/:orgId/repos')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class RepoController {
  constructor(
    private readonly onboarding: OnboardingService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly threads: Repository<JobEntity>,
  ) {}

  @Post()
  @UseGuards(OrgOwnerGuard)
  async connect(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: ConnectRepoDto,
  ): Promise<ConnectedRepo> {
    const result = await this.onboarding.connectRepo({
      orgId: org.id,
      repoUrl: body.repoUrl,
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      ...(body.displayName ? { displayName: body.displayName } : {}),
    });
    await this.onboarding.tryActivate(org.id);
    return result;
  }

  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<RepoView[]> {
    const rows = await this.repos.find({
      where: { org_id: org.id },
      order: { created_at: 'ASC' },
    });
    // One grouped count for the whole org's repos (drives the disconnect gate + UI badge).
    const counts = await this.threads
      .createQueryBuilder('t')
      .select('t.repo_id', 'repoId')
      .addSelect('COUNT(*)', 'count')
      .where('t.org_id = :orgId', { orgId: org.id })
      .groupBy('t.repo_id')
      .getRawMany<{ repoId: string; count: string }>();
    const countByRepo = new Map(counts.map((c) => [c.repoId, Number(c.count)]));
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      gitUrl: r.git_url,
      defaultBranch: r.default_branch,
      accessOk: r.access_ok,
      accessCheckedAt: r.access_checked_at ? r.access_checked_at.toISOString() : null,
      threadCount: countByRepo.get(r.id) ?? 0,
      onboardingThreadId: r.onboarding_thread_id,
      onboardedAt: r.onboarded_at ? r.onboarded_at.toISOString() : null,
    }));
  }

  /**
   * `GET …/repos/:repoId/branches` — the repo's branches (default first) for the create-thread
   * base-branch picker. Any member can read (creating threads is a member action).
   */
  @Get(':repoId/branches')
  async branches(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ branches: string[]; defaultBranch: string }> {
    return this.onboarding.listRepoBranches(org.id, repoId);
  }

  /** `POST …/repos/:repoId/revalidate` — re-probe GitHub access with the org's token. Owner only. */
  @Post(':repoId/revalidate')
  @UseGuards(OrgOwnerGuard)
  async revalidate(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<ConnectedRepo> {
    return this.onboarding.revalidateRepo(org.id, repoId);
  }

  /**
   * `POST …/repos/:repoId/onboard` — (re-)run the Atlas onboarding thread for this repo (the operator-
   * initiated counterpart to the automatic spawn on connect). Spawns a fresh onboarding thread even if the
   * repo was onboarded before. Owner only. Returns the new thread id so the UI can deep-link into it.
   */
  @Post(':repoId/onboard')
  @UseGuards(OrgOwnerGuard)
  async onboard(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ threadId: string }> {
    return this.onboarding.reonboardRepo(org.id, repoId);
  }

  /** `PATCH …/repos/:repoId` — update display name / base branch (metadata only). Owner only. */
  @Patch(':repoId')
  @UseGuards(OrgOwnerGuard)
  async update(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    return this.onboarding.updateRepo(org.id, repoId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
    });
  }

  /**
   * `DELETE …/repos/:repoId` — disconnect the repo, CASCADE-deleting its threads (container/worktree
   * teardown + full child-row sweep). The web UI warns before calling. Owner only. Returns the count of
   * threads torn down.
   */
  @Delete(':repoId')
  @UseGuards(OrgOwnerGuard)
  async disconnect(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ ok: true; threadsDeleted: number }> {
    return this.onboarding.disconnectRepo(org.id, repoId);
  }
}
