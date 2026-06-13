import { Injectable } from '@nestjs/common';

/**
 * Session-scoped conductor metrics — in-memory, process-lifetime ("this session"). Modeled on
 * MemoryMetricsService. Today it tracks UNDER-RESPONSE: how often a human message burst reached
 * room quiescence with zero respond-action turns (nobody picked it up). This is the measurement
 * that gates whether an under-response FLOOR is worth building later — it is NOT itself a fix.
 *
 * "humanBurstDropped" is deliberately scoped:
 *  - per BURST, not per message (rapid-fire human messages fold into one batch);
 *  - "responded" = the gate chose `respond` (a respond-action turn), NOT a visible posted message
 *    (matches the `botBurst` signal). An emoji-only acknowledge does NOT count.
 */
export interface ConductorMetrics {
  /** Human bursts that reached quiescence with no respond-action turn. */
  humanBurstDropped: number;
}

@Injectable()
export class ConductorMetricsService {
  private humanBurstDropped = 0;

  /** One human burst went unanswered (no respond-action turn before the room went quiet). */
  recordDroppedBurst(): void {
    this.humanBurstDropped++;
  }

  snapshot(): ConductorMetrics {
    return { humanBurstDropped: this.humanBurstDropped };
  }

  reset(): void {
    this.humanBurstDropped = 0;
  }
}
