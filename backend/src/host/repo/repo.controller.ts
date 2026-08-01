import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '@dltech/jwt-auth/server';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  UpdateRepoDto,
} from '@workspace/shared';
import type { User } from '../../generated/prisma/client';
import { RepoService } from './repo.service';

/**
 * Item-level repo ops, addressed by `repoId` alone. There's no `orgId` in the path because a repo's UUID
 * identifies it, and `RepoService` scopes every query to the caller's orgs — so a repo outside the
 * caller's authority is a 404, not a leak. Reads require membership; writes require org ownership, the
 * latter enforced imperatively in the service (pgbase's Repo policy only carries the read predicate).
 */
@Controller('repos')
export class RepoController {
  constructor(private readonly repoService: RepoService) {}

  @Patch(':repoId')
  update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() body: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repoService.update(user.id, repoId, body);
  }

  @Delete(':repoId')
  remove(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<DisconnectRepoResult> {
    return this.repoService.remove(user.id, repoId);
  }

  @Get(':repoId/branches')
  branches(@Param('repoId', ParseUUIDPipe) repoId: string): Promise<RepoBranches> {
    return this.repoService.branches(repoId);
  }

  @Post(':repoId/revalidate')
  revalidate(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<ConnectedRepo> {
    return this.repoService.revalidate(user.id, repoId);
  }
}
