import { EnvModule } from '@workspace/nestjs-core';
import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { BotCursor, Channel, ChannelMessage } from '@workspace/shared/schemas';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { ChannelRegistryService } from './channel-registry.service';
import { ChannelModule } from './channel.module';
import { ChannelService } from './channel.service';
import { CursorStore } from './cursor.store';

/**
 * Proves decision 3 of the migration: chat history + cursors survive a process restart. Each module
 * boot is a stand-in for a fresh process (ChannelService/CursorStore hydrate in onModuleInit).
 */
describe('channel persistence (live Postgres)', () => {
  const SURFACE = `tui:int-test-${Date.now()}`;
  const SURFACE_B = `${SURFACE}-b`;
  let moduleRef: TestingModule;

  async function boot(surface: string = SURFACE): Promise<TestingModule> {
    process.env.HARNESS_SURFACE_ID = surface;
    return Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
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
    await ds.getRepository(ChannelMessage).delete({ surface_id: SURFACE_B });
    await ds.getRepository(Channel).delete({ channel_id: SURFACE });
    await ds.getRepository(Channel).delete({ channel_id: SURFACE_B });
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

    const before = Date.now();
    const m0 = channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'hello team',
    });
    const m1 = channel.append({
      id: 'alex:0',
      author: 'Alex',
      authorId: 'alex',
      authorBotId: 'alex',
      text: 'hi…',
    });
    const originalCreatedAt = m1.createdAt;
    // Streaming re-emit with the same id = in-place update, no new seq.
    const m1Updated = channel.append({
      id: 'alex:0',
      author: 'Alex',
      authorId: 'alex',
      authorBotId: 'alex',
      text: 'hi Dennis!',
    });
    expect(m0.seq).toBe(0);
    expect(m0.channelId).toBe(SURFACE); // append defaults the channel coordinate to the process surface
    expect(m1.seq).toBe(1);
    expect(channel.length).toBe(2);
    // createdAt is stamped at append-time and is a real epoch ms.
    expect(m0.createdAt).toBeGreaterThanOrEqual(before);
    expect(m1.createdAt).toBeGreaterThanOrEqual(before);
    // Streaming re-emit must preserve the original createdAt — never reset on update.
    expect(m1Updated.createdAt).toBe(originalCreatedAt);

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
    expect(log.every((m) => m.channelId === SURFACE)).toBe(true); // coordinate round-trips through Postgres
    expect(channel.length).toBe(2); // seq counter continues, no collisions
    expect(cursors.get('alex', SURFACE)).toBe(2);
    expect(cursors.get('sam', SURFACE)).toBe(0); // unseen bot starts at 0
    // createdAt round-trips: toChannelMsg maps the DB created_at back to epoch ms.
    expect(log.every((m) => m.createdAt > 0)).toBe(true);

    // Appends keep working after hydration with the continued seq.
    const m2 = channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'welcome back',
    });
    expect(m2.seq).toBe(2);
    expect(channel.since(2).map((m) => m.id)).toEqual(['u-1']);
    await channel.flush();
    await moduleRef.close();

    // ── process 3: a TAIL hydration window + an older cursor → backfill closes the gap ────────
    // (This is the restart-after-heavy-traffic case: a durable cursor below the hydrated window
    // must not have its gap silently skipped by `since()`.)
    process.env.CHANNEL_HYDRATE_LIMIT = '1';
    moduleRef = await boot();
    await moduleRef.init();
    channel = moduleRef.get(ChannelService);
    expect(channel.snapshot()).toHaveLength(1); // only the newest message is in the window
    expect(channel.floorSeq).toBe(2);
    expect(channel.since(0)).toHaveLength(1); // the gap is invisible before backfill…

    await channel.backfillTo(0);
    expect(channel.floorSeq).toBe(0);
    expect(channel.since(0).map((m) => m.id)).toEqual(['u-0', 'alex:0', 'u-1']); // …and complete after
    delete process.env.CHANNEL_HYDRATE_LIMIT;
  });

  it('keeps message identity per surface — the same id on another surface is a new row, not an update', async () => {
    // Surface-native ids (a Slack ts, a minted TUI id) are only unique within their channel; with
    // the old global-id PK, surface B's 'u-0' would silently upsert over surface A's.
    moduleRef = await boot(SURFACE_B);
    await moduleRef.init();
    const channelB = moduleRef.get(ChannelService);
    channelB.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'same id, different surface',
    });
    await channelB.flush();

    const ds = moduleRef.get(DataSource);
    const rows = await ds
      .getRepository(ChannelMessage)
      .find({ where: { id: 'u-0' }, order: { surface_id: 'ASC' } });
    expect(rows.map((r) => [r.surface_id, r.text])).toEqual([
      [SURFACE, 'hello team'],
      [SURFACE_B, 'same id, different surface'],
    ]);
  });

  it('persists registry rooms (kind/project/members) and hydrates them after a restart', async () => {
    moduleRef = await boot();
    await moduleRef.init();
    let registry = moduleRef.get(ChannelRegistryService);
    registry.ensure({
      channelId: SURFACE,
      kind: 'dm',
      project: 'project-a',
      members: ['alex'],
      displayName: 'dm:Alex',
    });
    registry.addMembers(SURFACE, ['dennis']);
    await registry.flush();
    await moduleRef.close();

    moduleRef = await boot();
    await moduleRef.init();
    registry = moduleRef.get(ChannelRegistryService);
    const room = registry.get(SURFACE);
    expect(room).toEqual({
      channelId: SURFACE,
      teamId: 'local',
      kind: 'dm',
      project: 'project-a',
      members: ['alex', 'dennis'],
      displayName: 'dm:Alex',
    });
    // ensure() after hydration is a no-op for a known room — it must not reset kind/project.
    const same = registry.ensure({ channelId: SURFACE });
    expect(same.kind).toBe('dm');
    expect(same.project).toBe('project-a');
  });
});
