import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import type { GithubAppInstallUrl, GithubAppStatus } from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { GithubAppConnectService } from './github-app-connect.service';

@Controller('orgs/:orgId/github-app')
export class GithubAppController {
  constructor(private readonly connect: GithubAppConnectService) {}

  @Post('install-url')
  installUrl(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<GithubAppInstallUrl> {
    return this.connect.installUrl(user.id, orgId);
  }

  @Get('status')
  status(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<GithubAppStatus> {
    return this.connect.status(user.id, orgId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<void> {
    await this.connect.disconnect(user.id, orgId);
  }
}
