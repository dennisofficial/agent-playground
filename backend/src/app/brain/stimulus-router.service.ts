import { Injectable, Logger } from '@nestjs/common';
import type { ChatStimulus, Stimulus } from '../domain';
import type { StimulusConsumer } from '../stimulus';
import { AgentSessionManager } from './agent-session-manager.service';
import { EventTriageService } from './event-triage.service';

/**
 * STIMULUS ROUTER — the `STIMULUS_CONSUMER` binding.
 *
 * Routes by kind:
 *   - 'chat'  → AgentSessionManager (the thread's continuous in-sandbox Claude Code session — the brain)
 *   - 'event' → EventTriageService (the untrusted-notification triage lane)
 *
 * No logic lives here: it is purely a demux.
 *
 * NOTE — slated for rework: that this router exists to immediately un-merge a `Stimulus` union by `kind`
 * is the tell that the union earns nothing. The intended direction is to drop the union + this router and
 * make an event the *opening message* to a spawned thread's brain. See `../ARCHITECTURE.md` §7.
 */
@Injectable()
export class StimulusRouter implements StimulusConsumer {
  private readonly logger = new Logger(StimulusRouter.name);

  constructor(
    private readonly brain: AgentSessionManager,
    private readonly events: EventTriageService,
  ) {}

  async consume(stimulus: Stimulus): Promise<void> {
    if (stimulus.kind === 'chat') {
      await this.brain.handleChatTurn(stimulus as ChatStimulus);
    } else {
      await this.events.triageEvent(stimulus);
    }
  }
}
