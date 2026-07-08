import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, type McpSurface } from '../persistence/entities';
import { ORG_SCOPE, WorkspaceSkillStore, type SkillInput, type SkillView } from './workspace-skill.store';

const SURFACES = ['brain', 'build', 'review'] as const;

class SetSkillDto implements SkillInput {
  @IsString() @MinLength(1) description!: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsArray() @IsIn(SURFACES, { each: true }) surfaces?: McpSurface[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/**
 * `/web/orgs/:orgId/skills` — manage the org's user/brain-defined skills, in two writable tiers
 * (org-wide `scope='org'` + repo-scoped `scope=<repoId>`). GET is readable by any member; all mutations
 * are an Administer action — owner only (`OrgOwnerGuard`), mirroring {@link McpServersController}. A skill
 * carries no secret, so GET returns the full body.
 */
@Controller('web/orgs/:orgId/skills')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SkillsController {
  constructor(
    private readonly store: WorkspaceSkillStore,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<{ skills: SkillView[] }> {
    return { skills: await this.store.list(org.id) };
  }

  @Put(':scope/:name')
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
    @Body() body: SetSkillDto,
  ): Promise<{ ok: boolean }> {
    const dbScope = await this.resolveScope(org.id, scope);
    await this.store.write(org.id, dbScope, name, body);
    return { ok: true };
  }

  @Delete(':scope/:name')
  @UseGuards(OrgOwnerGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ ok: boolean }> {
    const dbScope = await this.resolveScope(org.id, scope);
    await this.store.delete(org.id, dbScope, name);
    return { ok: true };
  }

  /** Map `'org'` → the `'*'` sentinel; otherwise require the repo to belong to this org. */
  private async resolveScope(orgId: string, scope: string): Promise<string> {
    if (scope === 'org') return ORG_SCOPE;
    const repo = await this.repos.findOne({ where: { id: scope, org_id: orgId } });
    if (!repo) throw new BadRequestException(`unknown repo scope '${scope}' for this org`);
    return scope;
  }
}
