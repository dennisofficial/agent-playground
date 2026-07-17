import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AUTO_MERGE_METHODS, type AutoMergeMethod } from '@workspace/shared';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { OnboardingService, type ConnectedRepo } from './onboarding.service';

class ConnectRepoDto {
  @IsString() repoUrl!: string;
  @IsOptional() @IsString() baseBranch?: string;
  @IsOptional() @IsString() displayName?: string;
}

class UpdateRepoDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() defaultBranch?: string;
  @IsOptional() @IsString() branchPrefix?: string;
  @IsOptional()
  @IsIn(AUTO_MERGE_METHODS)
  defaultAutoMergeMethod?: AutoMergeMethod;
  @IsOptional() @IsBoolean() defaultAutoMergeDeleteBranch?: boolean;
}

interface RepoView {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
  accessCheckedAt: string | null;
  threadCount: number;
  onboardingThreadId: string | null;
  onboardedAt: string | null;
  webhookWarning: string | null;
  branchPrefix: string | null;
  defaultAutoMergeMethod: AutoMergeMethod;
  defaultAutoMergeDeleteBranch: boolean;
}

@Controller('web/orgs/:orgId/repos')
@UseGuards(OrgMembershipGuard)
export class RepoController {
  constructor(
    private readonly onboarding: OnboardingService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
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
    const counts = await this.jobs
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
      onboardingThreadId: r.onboarding_job_id,
      onboardedAt: r.onboarded_at ? r.onboarded_at.toISOString() : null,
      webhookWarning: r.webhook_warning ?? null,
      branchPrefix: r.branch_prefix ?? null,
      defaultAutoMergeMethod: r.default_auto_merge_method,
      defaultAutoMergeDeleteBranch: r.default_auto_merge_delete_branch,
    }));
  }

  @Get(':repoId/branches')
  async branches(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ branches: string[]; defaultBranch: string }> {
    return this.onboarding.listRepoBranches(org.id, repoId);
  }

  @Post(':repoId/revalidate')
  @UseGuards(OrgOwnerGuard)
  async revalidate(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<ConnectedRepo> {
    return this.onboarding.revalidateRepo(org.id, repoId);
  }

  @Post(':repoId/onboard')
  @UseGuards(OrgOwnerGuard)
  async onboard(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ jobId: string }> {
    return this.onboarding.reonboardRepo(org.id, repoId);
  }

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
      ...(body.branchPrefix !== undefined ? { branchPrefix: body.branchPrefix } : {}),
      ...(body.defaultAutoMergeMethod !== undefined
        ? { defaultAutoMergeMethod: body.defaultAutoMergeMethod }
        : {}),
      ...(body.defaultAutoMergeDeleteBranch !== undefined
        ? { defaultAutoMergeDeleteBranch: body.defaultAutoMergeDeleteBranch }
        : {}),
    });
  }

  @Delete(':repoId')
  @UseGuards(OrgOwnerGuard)
  async disconnect(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{ ok: true; threadsDeleted: number }> {
    return this.onboarding.disconnectRepo(org.id, repoId);
  }
}
