import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { EngineEvent } from '@shared/engine/engine.types';

/**
 * ONE event name for every {@link EngineEvent} kind, not `engine.<kind>` per kind. The only listener
 * ({@link TurnEventForwarder}) forwards every kind identically (verbatim to `TurnTransport.emitEvent`) —
 * per-kind names would only buy per-kind subscriptions nobody needs yet, at the cost of a second place
 * (alongside `EngineEvent`'s own `kind` union) that has to stay in sync with the 15 kinds.
 */
export const ENGINE_EVENT_NAME = 'engine.turn-event';

/** The payload carried on {@link ENGINE_EVENT_NAME}: the turn it belongs to plus the raw event. */
export interface EngineEventPayload {
  turnId: string;
  event: EngineEvent;
}

/**
 * Thin wrapper over `EventEmitter2` so callers (namely {@link TurnRunner}) emit engine events by intent
 * ("emit this turn's event") rather than reaching for the emitter/event-name directly.
 */
@Injectable()
export class EngineEventBus {
  constructor(private readonly emitter: EventEmitter2) {}

  emit(turnId: string, event: EngineEvent): void {
    this.emitter.emit(ENGINE_EVENT_NAME, { turnId, event });
  }
}
