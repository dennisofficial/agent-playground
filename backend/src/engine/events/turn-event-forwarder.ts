import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TurnTransport } from '../transport/turn-transport.service';
import { ENGINE_EVENT_NAME, type EngineEventPayload } from './engine-events';

/**
 * The sole subscriber on {@link ENGINE_EVENT_NAME}: forwards every engine event to `TurnTransport.emitEvent`
 * verbatim, so `TurnRunner` no longer needs to know `TurnTransport` emits events at all — it just publishes
 * to the bus. Registered as a Nest provider so `@OnEvent` gets wired at `onApplicationBootstrap`; `emit()`
 * is synchronous by default (this repo never calls `emitAsync`), so forwarding preserves the original
 * in-order, same-tick delivery of the direct `transport.emitEvent(turnId, e)` call it replaces.
 */
@Injectable()
export class TurnEventForwarder {
  constructor(private readonly transport: TurnTransport) {}

  @OnEvent(ENGINE_EVENT_NAME)
  handle(payload: EngineEventPayload): void {
    this.transport.emitEvent(payload.turnId, payload.event);
  }
}
