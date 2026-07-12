import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { OrgUsage } from '@workspace/shared';

/** One org's usage snapshot changed — fanned out so the repo /events SSE can push the live usage ring to clients. */
export type UsageChange = {
  orgId: string;
  usage: OrgUsage;
};

/**
 * Realtime fan-out for Claude-subscription usage changes. `OauthUsageService` publishes on a harvested-window
 * change (live quota burn during a turn) and on an account switch; the web surface merges `stream$` (filtered
 * by org) into its per-repo /events SSE so the usage ring stays live without a client poll.
 *
 * In-memory, single-process (same model as `LiveTurnStore`): horizontal scale-out would need a shared
 * bus, out of scope here.
 */
@Injectable()
export class UsageEventBus {
  private readonly subject = new Subject<UsageChange>();

  publish(event: UsageChange): void {
    this.subject.next(event);
  }

  get stream$(): Observable<UsageChange> {
    return this.subject.asObservable();
  }
}
