import {
  Body,
  Controller,
  Get,
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
import { RepoEntity } from '../persistence/entities';
import { OnboardingService, type ConnectedRepo } from './onboarding.service';

class ConnectRepoDto {
  @IsString() repoUrl!: string;
  @IsOptional() @IsString() baseBranch?: string;
  @IsOptional() @IsString() displayName?: string;
}

/** A repo as the web app lists it. */
interface RepoView {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
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
    const rows = await this.repos.find({ where: { org_id: org.id } });
    return rows.map((r) => ({
      id: r.repo_id,
      slug: r.repo_id,
      name: r.name,
      gitUrl: r.git_url,
      defaultBranch: r.default_branch,
      accessOk: r.access_ok,
    }));
  }
}
