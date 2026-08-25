import { Controller, Get, Query, Res } from '@nestjs/common';
import { Public } from '@dltech/jwt-auth/server';
import type { Response } from 'express';
import { GithubAppConnectService } from './github-app-connect.service';

@Public()
@Controller('github-app')
export class GithubAppCallbackController {
  constructor(private readonly connect: GithubAppConnectService) {}

  @Get('callback')
  async callback(
    @Query('installation_id') installationId: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { redirectUrl } = await this.connect.completeCallback({ installationId, state });
    res.redirect(302, redirectUrl);
  }
}
