import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  UpdateRepoDto,
} from '@workspace/shared';
import type { User } from '../auth/entities/user.entity';
import { RepoService } from './repo.service';

/**
 * Item-level repo ops, addressed by `repoId` alone. There's no `orgId` in the path because a repo's UUID
 * identifies it, and the `repos` realtime guard (RepoRealtimeGuard) scopes every query to the caller's
 * orgs via pg-realtime's `scopedFindWhere` — so a repo outside the caller's authority is a 404, not a
 * leak. Reads require membership; writes require org ownership — both decided by the one guard
 * (`canRead` vs `canUpdate`/`canDelete`), never a URL param.
 */
@Controller('repos')
export class RepoController {
  constructor(private readonly repos: RepoService) {}

  @Patch(':repoId')
  update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() body: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.update(user.id, repoId, body);
  }

  @Delete(':repoId')
  remove(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<DisconnectRepoResult> {
    return this.repos.remove(user.id, repoId);
  }

  @Get(':repoId/branches')
  branches(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<RepoBranches> {
    return this.repos.branches(user.id, repoId);
  }

  @Post(':repoId/revalidate')
  revalidate(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<ConnectedRepo> {
    return this.repos.revalidate(user.id, repoId);
  }
}
