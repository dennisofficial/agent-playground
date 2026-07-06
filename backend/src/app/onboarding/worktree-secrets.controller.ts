import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { WorktreeSecretFileStore, type WorktreeSecretFileRef } from './worktree-secret.store';

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
 * `/web/orgs/:orgId/worktree-secrets` — manage the org's encrypted per-repo worktree secret FILES that
 * the hydrator renders into a repo's sandbox. GET returns file refs (repo + path + label) only — never
 * values — readable by any member. All mutations (PUT/DELETE `/files`) are an Administer action — owner
 * only (`OrgOwnerGuard`), mirroring {@link OrgCredentialsController}. A file row IS the authority:
 * without one, a repo's committed `.atlas/worktree.json` entry is inert.
 */
@Controller('web/orgs/:orgId/worktree-secrets')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WorktreeSecretsController {
  constructor(private readonly store: WorktreeSecretFileStore) {}

  @Get()
  async list(
    @CurrentOrg() org: CurrentOrgCtx,
  ): Promise<{ files: WorktreeSecretFileRef[] }> {
    return { files: await this.store.list(org.id) };
  }

  @Put('files')
  @UseGuards(OrgOwnerGuard)
  async setFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetFileDto,
  ): Promise<{ ok: boolean }> {
    await this.store.write(org.id, body.repoId, body.path, body.value, body.label ?? null);
    return { ok: true };
  }

  @Delete('files')
  @UseGuards(OrgOwnerGuard)
  async deleteFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: DeleteFileDto,
  ): Promise<{ ok: boolean }> {
    await this.store.delete(org.id, body.repoId, body.path);
    return { ok: true };
  }
}
