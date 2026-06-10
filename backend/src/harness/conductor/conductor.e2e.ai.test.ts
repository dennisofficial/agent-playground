import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { firstValueFrom, filter } from 'rxjs';
import { DatabaseModule } from '../../_lib/database/database.module';
import { EsmModule } from '../../_lib/esm/esm.module';
import { ChannelService } from '../channel/channel.service';
import { CursorStore } from '../channel/cursor.store';
import { HarnessModule } from '../harness.module';
import { ConductorEventsBus } from './conductor-events.bus';
import { ConductorService } from './conductor.service';

/**
 * Headless end-to-end: boots the full harness (no TUI), hails Alex, and waits for a real reply.
 * REAL LLM CALLS (gate + chat + reconcile) — runs only under `pnpm test:ai`.
 */
describe('conductor end-to-end (real LLM)', () => {
  it('answers a direct hail and advances the durable cursor', async () => {
    process.env.HARNESS_SURFACE_ID = `tui:ai-test-${Date.now()}`;
    const moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({ envService: EnvService, validationSchema: envConfigValidation }),
        DatabaseModule,
        EsmModule,
        HarnessModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const conductor = app.get(ConductorService);
    const bus = app.get(ConductorEventsBus);
    const channel = app.get(ChannelService);
    const cursors = app.get(CursorStore);

    const botReply = firstValueFrom(bus.events$.pipe(filter((e) => e.kind === 'message' && !e.fromHuman)));
    conductor.submitFrom('dennis', 'Dennis', '@Alex just say hi back in one short sentence — no tools.');
    await conductor.whenIdle();

    const reply = (await botReply) as { authorId: string; text: string };
    expect(reply.authorId).toBe('alex');
    expect(reply.text.length).toBeGreaterThan(0);
    expect(cursors.get('alex', channel.surfaceId)).toBeGreaterThan(0);

    await app.close();
    delete process.env.HARNESS_SURFACE_ID;
  }, 90_000);
});
