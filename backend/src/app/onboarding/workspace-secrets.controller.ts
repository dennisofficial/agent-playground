import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity } from '../persistence/entities';
import { WorkspaceSecretFileStore, type WorkspaceSecretFileRef } from './workspace-secret.store';

class SetFileDto {
  @IsString() @MinLength(1) repoId!: string;
  @IsString() @MinLength(1) path!: string;
  @IsString() @MinLength(1) value!: string;
  @IsOptional() @IsString() label?: string;
}

class DeleteFileDto {
  @IsString() @MinLength(1) repoId!: string;
  @IsString() @MinLength(1) path!: string;
}

/**
 * `/web/orgs/:orgId/workspace-secrets` — manage the org's encrypted per-repo workspace secret FILES that
 * the hydrator renders into a repo's sandbox. GET returns file refs (repo + path + label) only — never
 * values — readable by any member. All mutations (PUT/DELETE `/files`) are an Administer action — owner
 * only (`OrgOwnerGuard`), mirroring {@link OrgCredentialsController}. A file row IS the authority:
 * without one, a repo's committed `.atlas/worktree.json` entry is inert.
 */
@Controller('web/orgs/:orgId/workspace-secrets')
@UseGuards(OrgMembershipGuard)
export class WorkspaceSecretsController {
  constructor(
    private readonly store: WorkspaceSecretFileStore,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  private async assertRepo(orgId: string, repoId: string): Promise<void> {
    const row = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!row) throw new NotFoundException('repo not found');
  }

  private normalizeSecretPath(path: string): string {
    const trimmed = path.trim();
    const segments = trimmed.split(/[\\/]+/);
    if (
      !trimmed ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\') ||
      segments.some((s) => !s || s === '.' || s === '..')
    ) {
      throw new BadRequestException(
        'path must be a worktree-relative file path (e.g. .env), no leading / or ..',
      );
    }
    return trimmed;
  }

  @Get()
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<{ files: WorkspaceSecretFileRef[] }> {
    return { files: await this.store.list(org.id) };
  }

  @Put('files')
  @UseGuards(OrgOwnerGuard)
  async setFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetFileDto,
  ): Promise<{ ok: boolean }> {
    await this.assertRepo(org.id, body.repoId);
    const path = this.normalizeSecretPath(body.path);
    await this.store.write(org.id, body.repoId, path, body.value, body.label ?? null);
    return { ok: true };
  }

  @Delete('files')
  @UseGuards(OrgOwnerGuard)
  async deleteFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: DeleteFileDto,
  ): Promise<{ ok: boolean }> {
    await this.assertRepo(org.id, body.repoId);
    await this.store.delete(org.id, body.repoId, body.path);
    return { ok: true };
  }
}
