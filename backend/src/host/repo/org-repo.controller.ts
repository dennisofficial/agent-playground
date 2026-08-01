import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '@dltech/jwt-auth/server';
import { ConnectRepoDto, type ConnectedRepo } from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { RepoService } from './repo.service';

@Controller('orgs/:orgId/repos')
export class OrgRepoController {
  constructor(private readonly repos: RepoService) {}

  @Post()
  connect(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: ConnectRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.connect(user.id, orgId, body);
  }
}
