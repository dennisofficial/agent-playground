import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/engine/engine.types';
import { TurnTransport } from '../../transport/turn-transport.service';
import { EngineEventBus } from '../engine-events';
import { TurnEventForwarder } from '../turn-event-forwarder';

describe('TurnEventForwarder', () => {
  it('forwards an event published on EngineEventBus to TurnTransport.emitEvent', async () => {
    const emitEvent = vi.fn();
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        EngineEventBus,
        TurnEventForwarder,
        { provide: TurnTransport, useValue: { emitEvent } },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const bus = app.get(EngineEventBus);
    const event: EngineEvent = { kind: 'text', text: 'hello' };
    bus.emit('turn-1', event);

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith('turn-1', event);

    await app.close();
  });
});
