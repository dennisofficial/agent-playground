import { Injectable } from '@nestjs/common';
import { BehaviorSubject, Observable, ReplaySubject } from 'rxjs';
import type {
  ConductorEvent,
  ConductorStatus,
} from '../domain/conductor-events';

const INITIAL_STATUS: ConductorStatus = {
  busy: false,
  ctx: {},
  running: 0,
  speaker: 'dennis',
  thinking: [],
};

/** How many events a late subscriber can catch up on. Covers the boot window comfortably; bounded
 * so a long session doesn't retain its whole event history in memory. */
const EVENT_REPLAY_BUFFER = 1_000;

/**
 * The presentation seam, as RxJS streams: the append-only domain event stream (`events$`) and the
 * overwrite-style status snapshot (`status$`). The TUI renders both; the SurfaceBridge forwards
 * messages/reactions to the bound ChatSurface; a logger or admin web SSE feed can subscribe to the
 * same streams without the conductor knowing.
 *
 * `events$` is a REPLAY subject on purpose: the conductor starts scheduling during application
 * bootstrap (it may immediately run turns against hydrated, unconsumed channel messages), but the
 * Ink App only subscribes after it mounts — with a plain Subject those boot-window events would be
 * emitted to zero subscribers and never appear in the TUI. The bounded replay hands late
 * subscribers the session's backlog instead of silence.
 */
@Injectable()
export class ConductorEventsBus {
  private readonly eventsSubject = new ReplaySubject<ConductorEvent>(
    EVENT_REPLAY_BUFFER,
  );
  private readonly statusSubject = new BehaviorSubject<ConductorStatus>(
    INITIAL_STATUS,
  );

  get events$(): Observable<ConductorEvent> {
    return this.eventsSubject.asObservable();
  }

  get status$(): Observable<ConductorStatus> {
    return this.statusSubject.asObservable();
  }

  emit(event: ConductorEvent): void {
    this.eventsSubject.next(event);
  }

  get status(): ConductorStatus {
    return this.statusSubject.getValue();
  }

  patchStatus(patch: Partial<ConductorStatus>): void {
    this.statusSubject.next({ ...this.statusSubject.getValue(), ...patch });
  }
}
