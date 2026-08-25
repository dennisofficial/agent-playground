import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TurnTransport } from '../transport/turn-transport.service';
import { ENGINE_EVENT_NAME, type EngineEventPayload } from './engine-events';

@Injectable()
export class TurnEventForwarder {
  constructor(private readonly transport: TurnTransport) {}

  @OnEvent(ENGINE_EVENT_NAME)
  handle(payload: EngineEventPayload): void {
    this.transport.emitEvent(payload.turnId, payload.event);
  }
}
