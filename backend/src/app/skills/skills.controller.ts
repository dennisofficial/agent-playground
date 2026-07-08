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
  UsePipes,
  ValidationPipe,
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
import { SkillFileWriter } from './skill-file-writer.service';
import { SkillInstallerService } from './skill-installer.service';
import { SkillUpdaterService } from './skill-updater.service';
import { ORG_SCOPE, WorkspaceSkillStore, type SkillInput, type SkillView } from './workspace-skill.store';

const SURFACES = ['brain', 'build', 'review'] as const;
const PROVENANCES = ['git', 'custom', 'managed'] as const;
const UPDATE_POLICIES = ['pinned', 'track-ref', 'manual'] as const;

/** `POST /skills/install` body — `scope` is the URL-facing sentinel (`'org'` | repo id), same as `:scope`
 *  route params elsewhere in this controller. */
class InstallSkillDto {
  @IsString() @MinLength(1) scope!: string;
  @IsUrl({ protocols: ['https'], require_protocol: true }) sourceUrl!: string;
  @IsOptional() @IsString() ref?: string;
  @IsOptional() @IsString() subpath?: string;
  @IsOptional() @IsIn(UPDATE_POLICIES) updatePolicy?: SkillUpdatePolicy;
  @IsOptional() @IsArray() @IsIn(SURFACES, { each: true }) surfaces?: McpSurface[];
}

/**
 * Registry-metadata upsert, PLUS (when `body` is present) the on-disk `SKILL.md` write for a `custom`
 * skill — mirrors how `WebSurfaceController.approveSkillProposal` pairs `store.write` with
 * `skillFiles.writeSkillMd` for a brain-authored skill. `provenance`/`source_*`/`installed_sha`/
 * `forked_from` are normally installer/authoring-owned; exposed here so a row can also be registered
 * against files placed on the store out of band.
 */
class SetSkillDto implements SkillInput {
  @IsString() @MinLength(1) description!: string;
  @IsOptional() @IsIn(PROVENANCES) provenance?: SkillProvenance;
  @IsOptional() @IsString() source_url?: string | null;
  @IsOptional() @IsString() source_ref?: string | null;
  @IsOptional() @IsString() source_subpath?: string | null;
  @IsOptional() @IsString() installed_sha?: string | null;
  @IsOptional() @IsIn(UPDATE_POLICIES) update_policy?: SkillUpdatePolicy | null;
  @IsOptional() @IsString() forked_from?: string | null;
  @IsOptional() @IsArray() @IsIn(SURFACES, { each: true }) surfaces?: McpSurface[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** A custom skill's `SKILL.md` body (frontmatter-stripped) — console create/edit only; a git skill's
   *  content comes from the installer, never this endpoint. */
  @IsOptional() @IsString() body?: string;
}

/**
 * `/web/orgs/:orgId/skills` — manage the org's user/brain-defined skills REGISTRY, in two writable tiers
 * (org-wide `scope='org'` + repo-scoped `scope=<repoId>`). GET (list + the `:scope/:name/files` read-only
 * viewer) is readable by any member; all mutations are an Administer action — owner only (`OrgOwnerGuard`),
 * mirroring {@link McpServersController}. A skill carries no secret, so GET returns the full row + (via
 * `files`) its on-disk tree and `SKILL.md` content.
 */
@Controller('web/orgs/:orgId/skills')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SkillsController {
  constructor(
    private readonly store: WorkspaceSkillStore,
    private readonly installer: SkillInstallerService,
    private readonly updater: SkillUpdaterService,
    private readonly skillFiles: SkillFileWriter,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<{ skills: SkillView[] }> {
    return { skills: await this.store.list(org.id) };
  }

  /** Install (or re-install) a skill — or every skill a marketplace manifest lists — from a git repo. */
  @Post('install')
  @UseGuards(OrgOwnerGuard)
  async install(@CurrentOrg() org: CurrentOrgCtx, @Body() body: InstallSkillDto): Promise<{ skills: SkillView[] }> {
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

  /** Apply-now: re-vendor a `git` skill from its recorded source, regardless of `update_policy`. */
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
    // A create/edit from the console carries the SKILL.md body directly — the row alone would leave a
    // custom skill with no file on the host store to symlink into a turn (see SkillFileWriter's header).
    if (body.body !== undefined) {
      this.skillFiles.writeSkillMd(org.id, dbScope, name, body.description, body.body);
    }
    return { ok: true };
  }

  /** Read-only file-tree + `SKILL.md` viewer (not an editor — see the module doc). Member-readable, like GET. */
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

  /** Fork a `git`-provenance skill to a fresh, freely-editable `custom` copy in the same scope — the
   *  console counterpart of `WebSurfaceController.forkSkillToCustom` (the `request_skill_edit_access`
   *  approval path); same `<name>-custom`(`-2`/`-3`…) naming so the two paths never collide. */
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
      enabled: true,
    });
    const skill = await this.store.get(org.id, dbScope, forkName);
    if (!skill) throw new Error(`skill '${forkName}' vanished immediately after write — should be unreachable`);
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
    // Mirror WebSurfaceController's skill-proposal 'remove' mode — a registry-only delete would orphan the
    // dir on the host store (and a later re-registration under the same name would resurrect stale files).
    this.skillFiles.removeSkillDir(org.id, dbScope, name);
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
