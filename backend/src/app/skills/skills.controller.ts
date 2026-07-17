import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  RepoEntity,
  type McpSurface,
  type SkillProvenance,
  type SkillUpdatePolicy,
} from '../persistence/entities';
import { BUNDLED_CLAUDE_CODE_SKILLS } from './bundled-skills';
import { SkillFileWriter } from './skill-file-writer.service';
import { SkillInstallerService } from './skill-installer.service';
import { SkillUpdaterService } from './skill-updater.service';
import { SystemSkillResolver, type SystemSkillView } from './system-skill-resolver.service';
import {
  ORG_SCOPE,
  WorkspaceSkillStore,
  type SkillInput,
  type SkillView,
} from './workspace-skill.store';

const SURFACES = ['brain', 'build', 'review'] as const;
const PROVENANCES = ['git', 'custom', 'managed'] as const;
const UPDATE_POLICIES = ['pinned', 'track-ref', 'manual'] as const;

class InstallSkillDto {
  @IsString() @MinLength(1) scope!: string;
  @IsUrl({ protocols: ['https'], require_protocol: true }) sourceUrl!: string;
  @IsOptional() @IsString() ref?: string;
  @IsOptional() @IsString() subpath?: string;
  @IsOptional() @IsIn(UPDATE_POLICIES) updatePolicy?: SkillUpdatePolicy;
  @IsOptional()
  @IsArray()
  @IsIn(SURFACES, { each: true })
  surfaces?: McpSurface[];
}

class SetSkillDto implements SkillInput {
  @IsString() @MinLength(1) description!: string;
  @IsOptional() @IsIn(PROVENANCES) provenance?: SkillProvenance;
  @IsOptional() @IsString() source_url?: string | null;
  @IsOptional() @IsString() source_ref?: string | null;
  @IsOptional() @IsString() source_subpath?: string | null;
  @IsOptional() @IsString() installed_sha?: string | null;
  @IsOptional() @IsIn(UPDATE_POLICIES) update_policy?: SkillUpdatePolicy | null;
  @IsOptional() @IsString() forked_from?: string | null;
  @IsOptional()
  @IsArray()
  @IsIn(SURFACES, { each: true })
  surfaces?: McpSurface[];
  @IsOptional() @IsArray() @IsString({ each: true }) reviewForTypes?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) reviewForGlobs?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() body?: string;
}

@Controller('web/orgs/:orgId/skills')
@UseGuards(OrgMembershipGuard)
export class SkillsController {
  constructor(
    private readonly store: WorkspaceSkillStore,
    private readonly installer: SkillInstallerService,
    private readonly updater: SkillUpdaterService,
    private readonly skillFiles: SkillFileWriter,
    private readonly systemSkills: SystemSkillResolver,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<{
    system: SystemSkillView[];
    bundled: string[];
    skills: SkillView[];
  }> {
    return {
      system: this.systemSkills.list(),
      bundled: [...BUNDLED_CLAUDE_CODE_SKILLS],
      skills: await this.store.list(org.id),
    };
  }

  @Post('install')
  @UseGuards(OrgOwnerGuard)
  async install(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: InstallSkillDto,
  ): Promise<{ skills: SkillView[] }> {
    const dbScope = await this.resolveScope(org.id, body.scope);
    const skills = await this.installer.install({
      orgId: org.id,
      scope: dbScope,
      sourceUrl: body.sourceUrl,
      ref: body.ref,
      subpath: body.subpath,
      updatePolicy: body.updatePolicy,
      surfaces: body.surfaces,
    });
    return { skills };
  }

  @Post(':scope/:name/update')
  @UseGuards(OrgOwnerGuard)
  async update(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ ok: boolean }> {
    const dbScope = await this.resolveScope(org.id, scope);
    await this.updater.applyNow(org.id, dbScope, name);
    return { ok: true };
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
    if (body.body !== undefined) {
      this.skillFiles.writeSkillMd(org.id, dbScope, name, body.description, body.body);
    }
    return { ok: true };
  }

  @Get(':scope/:name/files')
  async files(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ files: string[]; skillMd: string | null }> {
    const dbScope = await this.resolveScope(org.id, scope);
    return {
      files: this.skillFiles.listSkillFiles(org.id, dbScope, name),
      skillMd: this.skillFiles.readSkillBody(org.id, dbScope, name) ?? null,
    };
  }

  @Post(':scope/:name/fork')
  @UseGuards(OrgOwnerGuard)
  async fork(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ skill: SkillView }> {
    const dbScope = await this.resolveScope(org.id, scope);
    const source = await this.store.get(org.id, dbScope, name);
    if (!source) throw new BadRequestException(`no such skill '${name}' at scope '${scope}'`);
    let forkName = `${name}-custom`;
    for (let n = 2; await this.store.get(org.id, dbScope, forkName); n++) {
      forkName = `${name}-custom-${n}`;
    }
    this.skillFiles.forkSkillDir(org.id, dbScope, name, forkName);
    await this.store.write(org.id, dbScope, forkName, {
      description: source.description,
      provenance: 'custom',
      forked_from: name,
      surfaces: source.surfaces,
      reviewForTypes: source.reviewForTypes,
      reviewForGlobs: source.reviewForGlobs,
      enabled: true,
    });
    const skill = await this.store.get(org.id, dbScope, forkName);
    if (!skill)
      throw new Error(
        `skill '${forkName}' vanished immediately after write — should be unreachable`,
      );
    return { skill };
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
    this.skillFiles.removeSkillDir(org.id, dbScope, name);
    return { ok: true };
  }

  private async resolveScope(orgId: string, scope: string): Promise<string> {
    if (scope === 'org') return ORG_SCOPE;
    const repo = await this.repos.findOne({
      where: { id: scope, org_id: orgId },
    });
    if (!repo) throw new BadRequestException(`unknown repo scope '${scope}' for this org`);
    return scope;
  }
}
