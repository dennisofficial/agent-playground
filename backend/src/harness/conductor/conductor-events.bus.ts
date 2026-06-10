import { Injectable } from '@nestjs/common';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import type { ConductorEvent, ConductorStatus } from '../domain/conductor-events';

const INITIAL_STATUS: ConductorStatus = {
  busy: false,
  ctx: {},
  running: 0,
  speaker: 'dennis',
  thinking: [],
};

/**
 * The presentation seam, as RxJS streams: the append-only domain event stream (`events$`) and the
 * overwrite-style status snapshot (`status$`). The TUI renders both; the SurfaceBridge forwards
 * messages/reactions to the bound ChatSurface; a logger or admin web SSE feed can subscribe to the
 * same streams without the conductor knowing.
 */
@Injectable()
export class ConductorEventsBus {
  private readonly eventsSubject = new Subject<ConductorEvent>();
  private readonly statusSubject = new BehaviorSubject<ConductorStatus>(INITIAL_STATUS);

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
