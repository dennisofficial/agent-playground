import { Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { AgentSessionManager } from './agent-session-manager.service';

@Injectable()
export class DrainService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DrainService.name);

  constructor(
    private readonly election: LeaderElectionService,
    private readonly sessions: AgentSessionManager,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (signal !== 'SIGTERM' && signal !== 'SIGINT') return;
    this.logger.log(`drain start (signal ${signal})`);
    this.election.beginDrain();
    const graceMs = 120_000; // SIGTERM drain budget; must stay < the container stop_grace_period.
    const drained = await this.sessions.drainInFlight(graceMs);
    if (drained) {
      this.logger.log('drained cleanly — releasing leadership');
      await this.election.releaseLeadership();
    } else {
      this.logger.warn(
        'drain grace exceeded — exiting; lock releases on disconnect, turns cold-resume',
      );
    }
  }
}
