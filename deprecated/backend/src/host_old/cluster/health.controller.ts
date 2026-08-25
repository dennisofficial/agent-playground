import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@dltech/jwt-auth/server';
import { SkipLogger } from '@dltech/nestjs-core';
import type { Response } from 'express';
import { AppVersionService } from './app-version.service';
import { LeaderElectionService } from './leader-election.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly election: LeaderElectionService,
    private readonly version: AppVersionService,
  ) {}

  @Public()
  @Get('live')
  live(): { status: 'ok'; sha: string } {
    return { status: 'ok', sha: this.version.sha };
  }

  @Public()
  @SkipLogger()
  @Get('ready')
  ready(@Res({ passthrough: true }) res: Response): {
    ready: boolean;
    state: string;
  } {
    const ready = this.election.isLeader();
    res.status(ready ? 200 : 503);
    return { ready, state: this.election.getState() };
  }
}
