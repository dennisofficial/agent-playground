import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { ConnectRepoDto, type ConnectedRepo, type RepoView } from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { RepoService } from './repo.service';

@Controller('orgs/:orgId/repos')
export class OrgRepoController {
  constructor(private readonly repos: RepoService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<RepoView[]> {
    return this.repos.list(user.id, orgId);
  }

  @Post()
  connect(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: ConnectRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.connect(user.id, orgId, body);
  }
}
