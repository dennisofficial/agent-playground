import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { EngineEvent } from '@shared/engine/engine.types';

export const ENGINE_EVENT_NAME = 'engine.turn-event';

export interface EngineEventPayload {
  turnId: string;
  event: EngineEvent;
}

@Injectable()
export class EngineEventBus {
  constructor(private readonly emitter: EventEmitter2) {}

  emit(turnId: string, event: EngineEvent): void {
    this.emitter.emit(ENGINE_EVENT_NAME, { turnId, event });
  }
}
