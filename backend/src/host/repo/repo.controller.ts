import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  UpdateRepoDto,
} from '@workspace/shared';
import { RepoService } from './repo.service';

/**
 * Item-level repo ops, addressed by `repoId` alone. There's no `orgId` in the path because a repo's UUID
 * identifies it, and Repo's `@Rls` policy scopes every query to the caller's orgs — so a repo outside the
 * caller's authority is a 404, not a leak. Reads require membership; writes require org ownership — both
 * decided by the one policy (`read` vs `update`/`delete`), never a URL param.
 */
@Controller('repos')
export class RepoController {
  constructor(private readonly repos: RepoService) {}

  @Patch(':repoId')
  update(
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() body: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.update(repoId, body);
  }

  @Delete(':repoId')
  remove(@Param('repoId', ParseUUIDPipe) repoId: string): Promise<DisconnectRepoResult> {
    return this.repos.remove(repoId);
  }

  @Get(':repoId/branches')
  branches(@Param('repoId', ParseUUIDPipe) repoId: string): Promise<RepoBranches> {
    return this.repos.branches(repoId);
  }

  @Post(':repoId/revalidate')
  revalidate(@Param('repoId', ParseUUIDPipe) repoId: string): Promise<ConnectedRepo> {
    return this.repos.revalidate(repoId);
  }
}
