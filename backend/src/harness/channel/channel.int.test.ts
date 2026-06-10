import { EnvModule } from '@workspace/nestjs-core';
import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { BotCursor, ChannelMessage } from '@workspace/shared/schemas';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { ChannelModule } from './channel.module';
import { ChannelService } from './channel.service';
import { CursorStore } from './cursor.store';

/**
 * Proves decision 3 of the migration: chat history + cursors survive a process restart. Each module
 * boot is a stand-in for a fresh process (ChannelService/CursorStore hydrate in onModuleInit).
 */
describe('channel persistence (live Postgres)', () => {
  const SURFACE = `tui:int-test-${Date.now()}`;
  let moduleRef: TestingModule;

  async function boot(): Promise<TestingModule> {
    process.env.HARNESS_SURFACE_ID = SURFACE;
    return Test.createTestingModule({
      imports: [
        EnvModule.forRoot({ envService: EnvService, validationSchema: envConfigValidation }),
        DatabaseModule,
        ChannelModule,
      ],
    }).compile();
  }

  afterEach(async () => {
    await moduleRef?.close();
  });

  afterAll(async () => {
    moduleRef = await boot();
    await moduleRef.init();
    const ds = moduleRef.get(DataSource);
    await ds.getRepository(ChannelMessage).delete({ surface_id: SURFACE });
    await ds.getRepository(BotCursor).delete({ surface_id: SURFACE });
    await moduleRef.close();
    delete process.env.HARNESS_SURFACE_ID;
  });

  it('persists appends/updates + cursors and hydrates them after a restart', async () => {
    // ── process 1: write a conversation ──────────────────────────────────
    moduleRef = await boot();
    await moduleRef.init();
    let channel = moduleRef.get(ChannelService);
    let cursors = moduleRef.get(CursorStore);

    const m0 = channel.append({ id: 'u-0', author: 'Dennis', authorId: 'dennis', text: 'hello team' });
    const m1 = channel.append({ id: 'alex:0', author: 'Alex', authorId: 'alex', authorBotId: 'alex', text: 'hi…' });
    // Streaming re-emit with the same id = in-place update, no new seq.
    channel.append({ id: 'alex:0', author: 'Alex', authorId: 'alex', authorBotId: 'alex', text: 'hi Dennis!' });
    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    expect(channel.length).toBe(2);

    cursors.set('alex', SURFACE, 2);
    await channel.flush();
    await cursors.flush();
    await moduleRef.close();

    // ── process 2: hydrate and verify ─────────────────────────────────────
    moduleRef = await boot();
    await moduleRef.init();
    channel = moduleRef.get(ChannelService);
    cursors = moduleRef.get(CursorStore);

    const log = channel.snapshot();
    expect(log.map((m) => [m.seq, m.id, m.text])).toEqual([
      [0, 'u-0', 'hello team'],
      [1, 'alex:0', 'hi Dennis!'],
    ]);
    expect(channel.length).toBe(2); // seq counter continues, no collisions
    expect(cursors.get('alex', SURFACE)).toBe(2);
    expect(cursors.get('sam', SURFACE)).toBe(0); // unseen bot starts at 0

    // Appends keep working after hydration with the continued seq.
    const m2 = channel.append({ id: 'u-1', author: 'Dennis', authorId: 'dennis', text: 'welcome back' });
    expect(m2.seq).toBe(2);
    expect(channel.since(2).map((m) => m.id)).toEqual(['u-1']);
    await channel.flush();
  });
});
