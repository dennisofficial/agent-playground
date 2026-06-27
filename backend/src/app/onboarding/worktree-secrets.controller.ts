import {
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
import { IsString, MinLength } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { WorktreeSecretStore, type WorktreeSecretGrant } from './worktree-secret.store';

class SetSecretDto {
  @IsString() @MinLength(1) value!: string;
}

class GrantDto {
  @IsString() @MinLength(1) repoId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) path!: string;
}

/**
 * `/web/orgs/:orgId/worktree-secrets` — manage the org's encrypted named worktree secrets and the owner
 * GRANTS that authorise rendering them into a repo's sandbox. GET returns NAMES + grants only (never
 * values), readable by any member. All mutations (secret PUT/DELETE, grant PUT/DELETE) are an Administer
 * action — owner only (`OrgOwnerGuard`), mirroring {@link OrgCredentialsController}. A grant is the
 * security control: without one, a repo's committed `.atlas/worktree.json` entry is inert.
 */
@Controller('web/orgs/:orgId/worktree-secrets')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WorktreeSecretsController {
  constructor(private readonly store: WorktreeSecretStore) {}

  @Get()
  async list(
    @CurrentOrg() org: CurrentOrgCtx,
  ): Promise<{ names: string[]; grants: WorktreeSecretGrant[] }> {
    const [names, grants] = await Promise.all([
      this.store.list(org.id),
      this.store.listGrants(org.id),
    ]);
    return { names, grants };
  }

  @Put('secrets/:name')
  @UseGuards(OrgOwnerGuard)
  async setSecret(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('name') name: string,
    @Body() body: SetSecretDto,
  ): Promise<{ ok: boolean }> {
    await this.store.write(org.id, name, body.value);
    return { ok: true };
  }

  @Delete('secrets/:name')
  @UseGuards(OrgOwnerGuard)
  async deleteSecret(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('name') name: string,
  ): Promise<{ ok: boolean }> {
    await this.store.delete(org.id, name);
    return { ok: true };
  }

  @Put('grants')
  @UseGuards(OrgOwnerGuard)
  async grant(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: GrantDto,
  ): Promise<{ ok: boolean }> {
    await this.store.grant(org.id, body.repoId, body.name, body.path);
    return { ok: true };
  }

  @Delete('grants')
  @UseGuards(OrgOwnerGuard)
  async revoke(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: GrantDto,
  ): Promise<{ ok: boolean }> {
    await this.store.revoke(org.id, body.repoId, body.name, body.path);
    return { ok: true };
  }
}
