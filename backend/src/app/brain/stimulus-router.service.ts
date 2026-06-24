import { Injectable, Logger } from '@nestjs/common';
import type { ChatStimulus, Stimulus } from '../domain';
import type { StimulusConsumer } from '../stimulus';
import { AgentSessionManager } from './agent-session-manager.service';
import { EventTriageService } from './event-triage.service';

/**
 * R3 — STIMULUS ROUTER (thin; replaces the old TriageService as the STIMULUS_CONSUMER binding).
 *
 * Routes by kind:
 *   - 'chat'  → AgentSessionManager (the in-sandbox SDK session brain)
 *   - 'event' → EventTriageService (the unchanged untrusted-notification triage lane)
 *
 * No logic lives here: it is purely a demux. The split is structural — the event lane is unchanged
 * in behavior (verbatim extraction from the old TriageService); the chat lane is the new brain.
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
