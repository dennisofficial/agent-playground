import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@workspace/auth/server';
import { AppVersionService } from './app-version.service';
import { LeaderElectionService } from './leader-election.service';
import { SkipLogger } from '@workspace/nestjs-core';

/**
 * Health probes for the reverse proxy + deploy script. `@Public()` so the global auth guard doesn't 401
 * unauthenticated checks.
 *
 *  - `GET /health/live`  — liveness: 200 as soon as the HTTP server is listening.
 *  - `GET /health/ready` — readiness: 200 ONLY on the leader (and not draining). Caddy routes traffic
 *    only to the single leader; a follower or a draining instance returns 503. During a deploy's drain
 *    window no instance is "ready", so new connections briefly 502 while established SSE streams on the
 *    draining leader keep flowing — deploy at idle for ~zero gap.
 */
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
    // passthrough: set the status but still return the body through Nest's normal pipeline (so global
    // interceptors apply, consistent with /live), rather than ending the response ourselves.
    const ready = this.election.isLeader();
    res.status(ready ? 200 : 503);
    return { ready, state: this.election.getState() };
  }
}
