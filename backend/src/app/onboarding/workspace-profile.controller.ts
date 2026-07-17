import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity } from '../persistence/entities';
import { normalizeMounts, type MountMode, type MountSpec } from '../sandbox/container-paths';
import { WorkspaceConfigStore } from './workspace-config.store';
import { WorkspaceSecretFileStore } from './workspace-secret.store';

class SetMountDto {
  @IsString() @MinLength(1) path!: string;
  @IsOptional()
  @IsIn(['per-thread', 'shared-ro', 'shared-rw'])
  mode?: MountMode;
}

class RemoveMountDto {
  @IsString() @MinLength(1) path!: string;
}

class SetSetupScriptDto {
  @IsOptional() @IsString() script?: string | null;
}

class SetPreviewRecipeDto {
  @IsOptional() @IsString() instructions?: string | null;
}

/**
 * `/web/orgs/:orgId/repos/:repoId/workspace-profile` — the Atlas-managed per-repo provisioning
 * surface (mounts, setup script, preview recipe, acknowledged manifests, secret-file refs) that the
 * console reads/edits directly, reusing the same `WorkspaceConfigStore`/`WorkspaceSecretFileStore`
 * the agent tools already write through — so a console edit and a brain `write_workspace_config`
 * call converge on the same DB rows. GET is member-readable; every write is owner-only
 * (`OrgOwnerGuard`), mirroring {@link WorkspaceSecretsController}. Secret file VALUES are never
 * re-exposed here — that store stays write-only; this controller only surfaces refs.
 */
@Controller('web/orgs/:orgId/repos/:repoId/workspace-profile')
@UseGuards(OrgMembershipGuard)
export class WorkspaceProfileController {
  constructor(
    private readonly workspaceConfig: WorkspaceConfigStore,
    private readonly secretFiles: WorkspaceSecretFileStore,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  /** Guards against a member poking another org's repo id — the repo must belong to THIS org. */
  private async assertRepo(orgId: string, repoId: string): Promise<void> {
    const row = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!row) throw new NotFoundException('repo not found');
  }

  @Get()
  async get(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<{
    mounts: MountSpec[];
    setupScript: string | null;
    previewRecipe: string | null;
    secretFiles: { path: string; label?: string | null }[];
    seenManifests: string[] | null;
  }> {
    await this.assertRepo(org.id, repoId);
    const [mounts, setupScript, previewRecipe, seenManifests, secretFiles] = await Promise.all([
      this.workspaceConfig.listMounts(org.id, repoId),
      this.workspaceConfig.getSetupScript(org.id, repoId),
      this.workspaceConfig.getPreviewInstructions(org.id, repoId),
      this.workspaceConfig.getSeenManifests(org.id, repoId),
      this.secretFiles.list(org.id, repoId),
    ]);
    return {
      mounts,
      setupScript,
      previewRecipe,
      secretFiles: secretFiles.map((f) => ({
        path: f.path,
        label: f.label ?? null,
      })),
      seenManifests,
    };
  }

  @Put('mounts')
  @UseGuards(OrgOwnerGuard)
  async setMount(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: SetMountDto,
  ): Promise<{ ok: true; restartsSandbox: true }> {
    await this.assertRepo(org.id, repoId);
    const { mounts, warnings } = normalizeMounts([{ path: body.path, mode: body.mode }]);
    if (mounts.length === 0) {
      throw new BadRequestException(warnings[0] ?? 'invalid mount path');
    }
    const [spec] = mounts;
    await this.workspaceConfig.upsertMount(org.id, repoId, spec.path, spec.mode);
    return { ok: true, restartsSandbox: true };
  }

  @Delete('mounts')
  @UseGuards(OrgOwnerGuard)
  async removeMount(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: RemoveMountDto,
  ): Promise<{ ok: true; restartsSandbox: true }> {
    await this.assertRepo(org.id, repoId);
    await this.workspaceConfig.removeMount(org.id, repoId, body.path);
    return { ok: true, restartsSandbox: true };
  }

  @Put('setup-script')
  @UseGuards(OrgOwnerGuard)
  async setSetupScript(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: SetSetupScriptDto,
  ): Promise<{ ok: true }> {
    await this.assertRepo(org.id, repoId);
    await this.workspaceConfig.setSetupScript(org.id, repoId, body.script ?? null);
    // `seenManifests` is intentionally left untouched here: the brain tool refreshes it because it has
    // the live worktree to re-detect manifests against; this HTTP context has no sandbox/checkout to
    // detect anything from, so the acknowledged set stays whatever onboarding last recorded.
    return { ok: true };
  }

  @Put('preview-recipe')
  @UseGuards(OrgOwnerGuard)
  async setPreviewRecipe(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: SetPreviewRecipeDto,
  ): Promise<{ ok: true }> {
    await this.assertRepo(org.id, repoId);
    await this.workspaceConfig.setPreviewInstructions(org.id, repoId, body.instructions ?? null);
    return { ok: true };
  }
}
