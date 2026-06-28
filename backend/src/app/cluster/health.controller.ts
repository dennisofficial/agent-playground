import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@workspace/auth/server';
import { LeaderElectionService } from './leader-election.service';

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
  constructor(private readonly election: LeaderElectionService) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  ready(@Res() res: Response): void {
    const ready = this.election.isLeader();
    res.status(ready ? 200 : 503).json({ ready, state: this.election.getState() });
  }
}
